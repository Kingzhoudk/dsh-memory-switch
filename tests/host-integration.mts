/**
 * Real-host integration check for dsh-memory-switch.
 *
 * The unit suite drives `apply()` against a fake context; this script mounts the
 * plugin into a real Harness host instead (llm, sessions, projections, system
 * prompt, tools, commands, agent loop with a scripted adapter) plus a stub
 * `sessionQuery` service. It covers what a fake context cannot:
 *  1. the plugin mounts against the real service graph, including the optional
 *     `sessionQuery` injection that owns cross-session search visibility;
 *  2. `/memory off` commits through the real command executor and publishes
 *     `{ enabled: false }` on the client-visible projection;
 *  3. the model-facing policy section is present only while the switch is off;
 *  4. `searchSessions` pages are filtered by the same durable state, and the
 *     original method is restored when the plugin unloads;
 *  5. `/memory toggle` flips the durable state (not only an in-memory flag).
 *
 * scripts/test.mjs copies it into a DSH checkout and runs it with tsx.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context, Service } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import CommandsRuntime from '@deepseek-ai/dsh-commands'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'

const CHECKOUT = process.env.DSH_CHECKOUT
const PLUGIN = process.env.DSH_MEMORY_SWITCH_PLUGIN
if (CHECKOUT === undefined || PLUGIN === undefined) {
  throw new Error('set DSH_CHECKOUT (a deepseek-harness checkout) and DSH_MEMORY_SWITCH_PLUGIN (this package)')
}
const { MockAdapter, textResponse } = await import(
  pathToFileURL(join(CHECKOUT, 'packages/core/agent-loop/tests/mock-adapter.ts')).href
)
const MemorySwitch = await import(pathToFileURL(join(PLUGIN, 'lib/index.js')).href)

const MARKER = 'Memory switch: OFF for this conversation'

/**
 * Stand-in for the shipped SQLite-backed service: the plugin only needs the two
 * methods it wraps, and every conversation except `persisted-off` is on.
 */
class StubSessionQuery extends Service {
  constructor(ctx) {
    super(ctx, 'sessionQuery')
    /** Every searchSessions invocation, for the filter assertions. */
    this.requests = []
  }

  async searchSessions(request) {
    this.requests.push(request)
    return {
      items: [
        { header: { id: 'off-live' } },
        { header: { id: 'persisted-off' } },
        { header: { id: 'on-live' } },
      ],
    }
  }

  async observeSession(id) {
    return {
      projections: { values: { memorySwitch: { enabled: id !== 'persisted-off' } } },
      [Symbol.dispose]() {},
    }
  }
}

function waitForIdle(ctx, agent) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { dispose(); reject(new Error('agent did not go idle')) }, 10_000)
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      clearTimeout(timer)
      dispose()
      resolve()
    })
  })
}

function systemText(request) {
  const system = request.messages.find(message => message.role === 'system')
  if (system === undefined) return ''
  return system.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

const ctx = new Context()
await ctx.plugin(LlmRuntime)
await ctx.plugin(SessionStore)
await ctx.plugin(SessionProjectionRegistry)
await ctx.plugin(SystemPrompt, { personaPrefix: 'stable base' })
await ctx.plugin(ToolRuntime)
await ctx.plugin(NativeToolExecutor)
await ctx.plugin(AgentRegistry)
await ctx.plugin(CommandsRuntime)
await ctx.plugin(AgentLoop, { agents: [] })
await ctx.plugin(StubSessionQuery)

const memoryPlugin = await ctx.plugin(MemorySwitch)
const query = ctx.get('sessionQuery')

const adapter = new MockAdapter([textResponse('ok'), textResponse('ok'), textResponse('ok'), textResponse('ok')])
ctx.llm.registerAdapter(['mock'], adapter)
const agent = await ctx.agentLoop.create(SessionId('memory-test'), { provider: 'mock', model: 'mock' })
const signal = new AbortController().signal

// 0. default state: on, no policy section
assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.memorySwitch, { enabled: true },
  'the shipped default is memory on')

// 1. the search filter is installed by the real injection: a persisted
//    conversation whose durable projection says off is already hidden
const page = await query.searchSessions({}, {})
assert.deepEqual(page.items.map(hit => hit.header.id), ['off-live', 'on-live'],
  'the persisted off conversation is filtered from cross-session search')

// 2. /memory off commits through the real command path
const off = await ctx.commands.execute(agent, '/memory off', [], signal)
assert.equal(off?.result.kind, 'success')
assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.memorySwitch, { enabled: false })

// 3. the policy section reaches the model only while off
agent.followup(createUserMessage({ content: [{ type: 'text', text: '接着做' }], source: { kind: 'user' } }))
await waitForIdle(ctx, agent)
assert.ok(systemText(adapter.requests[0]).includes(MARKER), 'the off policy is in the system prompt')

// 4. a live conversation that turns off is filtered too, through its own
//    projection: create it under the id the stub page reports
const other = await ctx.agentLoop.create(SessionId('off-live'), { provider: 'mock', model: 'mock' })
const otherOff = await ctx.commands.execute(other, '/memory off', [], signal)
assert.equal(otherOff?.result.kind, 'success')
const filtered = await query.searchSessions({}, {})
assert.deepEqual(filtered.items.map(hit => hit.header.id), ['on-live'],
  'a live off conversation is filtered from search')
assert.ok(query.requests.length >= 2, 'the wrapper delegates to the real service')

// 5. /memory toggle flips the durable state and removes the section
const toggled = await ctx.commands.execute(agent, '/memory toggle', [], signal)
assert.equal(toggled?.result.kind, 'success')
assert.deepEqual(ctx.sessionProjections.snapshot(agent.session).values.memorySwitch, { enabled: true },
  'toggle folds to the opposite state')
agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
await waitForIdle(ctx, agent)
assert.ok(!systemText(adapter.requests[1]).includes(MARKER), 'the policy disappears once memory is back on')

// 6. status reports the effective state
const status = await ctx.commands.execute(agent, '/memory status', [], signal)
assert.match(status.result.text, /Memory is ON/u)

// 7. unloading restores the unwrapped behavior
await memoryPlugin.dispose()
const afterUnload = await query.searchSessions({}, {})
assert.equal(afterUnload.items.length, 3, 'the search wrapper is removed on unload')

console.log('MEMORY_SWITCH_HOST_INTEGRATION_OK')
