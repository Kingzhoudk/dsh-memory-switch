/**
 * Focused host-half tests for dsh-memory-switch.
 *
 * The plugin is plain ESM with no runtime dependencies, so the suite drives
 * `apply()` against a minimal fake context: a log-driven projection handle, a
 * command registry, a tool registry, and the OpenViking service. Each test
 * asserts one enforcement channel, not the cordis wiring itself.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  createMemoryProjection,
  memoryProjection,
  parseMemoryArgument,
  resolveMemoryTarget,
} from '../lib/index.js'

/** Build one session whose projection folds events appended to `events`. */
function makeSession(id, header = {}) {
  const events = []
  let seq = 0
  return {
    id,
    header: { id, ...header },
    events,
    get seq() { return seq },
    append(type, data) {
      seq += 1
      const event = { type, seq, time: Date.now(), data }
      events.push(event)
      return event
    },
    snapshotEvents() { return events },
    /** Fold the whole log exactly as the projection registry would. */
    fold() {
      let state = memoryProjection.init()
      for (const event of events) state = memoryProjection.apply(state, event)
      return state
    },
  }
}

/** Minimal host context capturing everything the plugin wires. */
function makeCtx(options = {}) {
  const handlers = new Map()
  const tools = options.tools ?? []
  const restrictions = []
  const guards = []
  let command
  let projectionDefinition
  const openviking = options.openviking

  const ctx = {
    logger: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
    effect(fn) { fn(); return () => {} },
    on(name, listener) {
      const list = handlers.get(name) ?? []
      list.push(listener)
      handlers.set(name, list)
    },
    get(name) {
      if (name === 'openvikingMemory') return openviking
      if (name === 'sessions') return options.sessions
      if (name === 'sessionQuery') return options.sessionQuery
      return undefined
    },
    sessionProjections: {
      async register(definition) {
        projectionDefinition = definition
        return {
          stateOf: session => session.fold(),
          dispose() {},
        }
      },
    },
    systemPrompt: {
      getSectionOrder: () => 0,
      section() { return () => {} },
    },
    tools: {
      schemas: () => tools.map(name => ({ name })),
      restrict: (filter) => {
        restrictions.push(filter)
        return () => {}
      },
      guard: (guard) => {
        guards.push(guard)
        return () => {}
      },
    },
    inject(names, callback) {
      if (names.includes('commands')) {
        callback({ commands: { register(definition) { command = definition } } })
        return
      }
      if (names.includes('openvikingMemory') && openviking !== undefined) {
        callback({ openvikingMemory: openviking })
      }
      if (names.includes('sessionQuery') && options.sessionQuery !== undefined) {
        callback({ sessionQuery: options.sessionQuery })
      }
    },
  }
  return {
    ctx,
    handlers,
    restrictions,
    guards,
    getCommand: () => command,
    getProjection: () => projectionDefinition,
    tools,
  }
}

/** Run the registered pre-step waterfall the way the agent loop does. */
async function runPreStep(harness, agent, messages) {
  const listeners = harness.handlers.get('agent/pre-step') ?? []
  assert.equal(listeners.length, 1)
  return await listeners[0]({ agent, signal: { aborted: false } }, async () => ({ kind: 'enter', messages }))
}

/** Evaluate every registered monotonic guard the way the pipeline does. */
function runGuard(harness, agent, toolName, args = {}) {
  for (const guard of harness.guards) {
    const reason = guard({ agent, name: toolName, arguments: args })
    if (reason !== undefined) return { kind: 'deny', reason }
  }
  return { kind: 'allow' }
}

/** Build one live agent over a session. */
function makeAgent(session, harness) {
  return {
    session,
    status: 'idle',
    ctx: {
      tools: {
        restrict: harness.ctx.tools.restrict,
      },
    },
  }
  }

test('argument grammar accepts only on/off spellings', () => {
  for (const value of ['on', 'ON', ' enable ', '1', 'true']) assert.equal(parseMemoryArgument(value), true)
  for (const value of ['off', 'OFF', 'disable', '0', 'false']) assert.equal(parseMemoryArgument(value), false)
  for (const value of ['', 'status', 'toggle', 'maybe']) assert.equal(parseMemoryArgument(value), undefined)
})

test('default state is ON and a settled /memory off flips it', () => {
  const session = makeSession('s1')
  assert.equal(session.fold().enabled, true)

  // command/run with the off argument, then a successful command/done.
  session.append('command/run', { name: 'memory', args: ' off', commandId: 'c1' })
  assert.equal(session.fold().enabled, true, 'a running command changes nothing yet')
  session.append('command/done', { commandId: 'c1', kind: 'success' })
  assert.equal(session.fold().enabled, false)
})

test('a failed command leaves the state untouched', () => {
  const session = makeSession('s2')
  session.append('command/run', { name: 'memory', args: 'on', commandId: 'c9' })
  session.append('command/done', { commandId: 'c9', kind: 'error' })
  assert.equal(session.fold().enabled, true)
})

test('unrelated commands are ignored', () => {
  const session = makeSession('s3')
  session.append('command/run', { name: 'grill', args: 'off', commandId: 'g1' })
  session.append('command/done', { commandId: 'g1', kind: 'success' })
  assert.equal(session.fold().enabled, true)
})

test('/memory off denies cross-conversation tools and hides them', async () => {
  const harness = makeCtx({
    tools: ['session_search', 'mcp__openviking__search', 'why_check', 'bash'],
  })
  await apply(harness.ctx, {})
  const session = makeSession('s4')
  const agent = makeAgent(session, harness)
  const created = harness.handlers.get('agent/created')[0]
  await created({ agent })

  // Switch OFF through the human command surface.
  const command = harness.getCommand()
  const result = await command.handler({ agent, rawInput: ' off' })
  assert.equal(result.kind, 'success')
  // The real adapter appends the pair around the handler; replay that here.
  session.append('command/run', { name: 'memory', args: ' off', commandId: 'c2' })
  session.append('command/done', { commandId: 'c2', kind: 'success' })

  assert.equal((runGuard(harness, agent, 'session_search')).kind, 'deny')
  assert.equal((runGuard(harness, agent, 'mcp__openviking__search')).kind, 'deny')
  assert.equal((runGuard(harness, agent, 'bash')).kind, 'allow')
  assert.equal((runGuard(harness, agent, 'why_check')).kind, 'allow', 'why_* is opt-in')

  // The chat tool was hidden for this agent scope.
  assert.ok(harness.restrictions.some(filter => (filter.deny ?? []).includes('session_search')))
  assert.ok(harness.restrictions.some(filter => (filter.deny ?? []).includes('mcp__openviking__search')))
})

test('/memory on restores every channel', async () => {
  const harness = makeCtx({ tools: ['session_search', 'mcp__openviking__search'] })
  await apply(harness.ctx, {})
  const session = makeSession('s5')
  const agent = makeAgent(session, harness)
  const created = harness.handlers.get('agent/created')[0]
  await created({ agent })

  const command = harness.getCommand()
  await command.handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })
  assert.equal((runGuard(harness, agent, 'session_search')).kind, 'deny')

  await command.handler({ agent, rawInput: 'on' })
  session.append('command/run', { name: 'memory', args: 'on', commandId: 'c2' })
  session.append('command/done', { commandId: 'c2', kind: 'success' })
  assert.equal((runGuard(harness, agent, 'session_search')).kind, 'allow')
})

test('foreign-conversation context is dropped from the prepared step', async () => {
  const harness = makeCtx()
  await apply(harness.ctx, {})
  const session = makeSession('s6')
  const agent = makeAgent(session, harness)
  const created = harness.handlers.get('agent/created')[0]
  await created({ agent })

  const command = harness.getCommand()
  await command.handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })

  const messages = [
    { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] },
    { source: { kind: 'session-reference' }, content: [{ type: 'text', text: 'other chat' }] },
    { source: { kind: 'plugin:openviking-memory' }, content: [{ type: 'text', text: 'recalled' }] },
  ]
  const decision = await runPreStep(harness, agent, messages)
  assert.equal(decision.kind, 'enter')
  assert.equal(decision.messages.length, 1)
  assert.equal(decision.messages[0].source.kind, 'user')
})

test('OpenViking recall and capture are wrapped off, and restored on', async () => {
  const calls = []
  const openviking = {
    states: new Map(),
    async initialize() { calls.push('initialize') },
    async profileMessage() { calls.push('profileMessage'); return { text: 'profile' } },
    async recallMessage() { calls.push('recallMessage'); return { text: 'recall' } },
    capture() { calls.push('capture') },
    maybeCommit() { calls.push('maybeCommit') },
    async flush() { calls.push('flush') },
    dispose() { calls.push('dispose') },
  }
  const harness = makeCtx({ openviking })
  await apply(harness.ctx, {})
  const session = makeSession('s7')
  const agent = makeAgent(session, harness)
  const created = harness.handlers.get('agent/created')[0]
  await created({ agent })

  // ON: the wrappers pass calls through.
  await openviking.profileMessage(agent)
  await openviking.recallMessage(agent, [])
  assert.deepEqual(calls, ['profileMessage', 'recallMessage'])

  const command = harness.getCommand()
  await command.handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })
  calls.length = 0

  // OFF: recall, profile, capture, commit and flush are all suppressed.
  await openviking.profileMessage(agent)
  await openviking.recallMessage(agent, [])
  openviking.capture(session, { type: 'user/message' })
  openviking.maybeCommit(session, { type: 'turn/end' })
  await openviking.flush(session)
  openviking.dispose(session)
  assert.deepEqual(calls, [], 'no cross-conversation traffic while off')
})

test('a subagent spawned by an off conversation starts off too', async () => {
  const harness = makeCtx({ tools: ['session_search'] })
  await apply(harness.ctx, {})
  const parent = makeSession('parent')
  const parentAgent = makeAgent(parent, harness)
  const created = harness.handlers.get('agent/created')[0]
  await created({ agent: parentAgent })

  await harness.getCommand().handler({ agent: parentAgent, rawInput: 'off' })
  parent.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  parent.append('command/done', { commandId: 'c1', kind: 'success' })

  const child = makeSession('child', { parentSession: 'parent', origin: 'subagent' })
  const childAgent = makeAgent(child, harness)
  await created({ agent: childAgent })
  assert.equal((runGuard(harness, childAgent, 'session_search')).kind, 'deny')
})

test('OpenViking MCP resource tools are denied by server argument', async () => {
  const harness = makeCtx({ tools: ['list_mcp_resources', 'read_mcp_resource'] })
  await apply(harness.ctx, {})
  const session = makeSession('s8')
  const agent = makeAgent(session, harness)
  await harness.handlers.get('agent/created')[0]({ agent })

  await harness.getCommand().handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })

  assert.equal(runGuard(harness, agent, 'list_mcp_resources', { server: 'openviking' }).kind, 'deny')
  assert.equal(runGuard(harness, agent, 'read_mcp_resource', { server: 'openviking' }).kind, 'deny')
  assert.equal(runGuard(harness, agent, 'list_mcp_resources', { server: 'linglong' }).kind, 'allow')
})

test('queued OpenViking writes for the conversation are dropped when it goes off', async () => {
  const { mkdtemp, writeFile, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-switch-'))
  const previous = process.env.OPENVIKING_PENDING_DIR
  process.env.OPENVIKING_PENDING_DIR = dir
  try {
    await writeFile(join(dir, 'mine_0.json'), JSON.stringify({ type: 'addMessage', sessionId: 'dsh-session-s9' }))
    await writeFile(join(dir, 'other_0.json'), JSON.stringify({ type: 'addMessage', sessionId: 'dsh-session-other' }))
    const openviking = {
      stateFor: () => ({ ovSessionId: 'dsh-session-s9' }),
      initialize: async () => {},
      profileMessage: async () => null,
      recallMessage: async () => null,
      capture: () => {},
      maybeCommit: () => {},
      flush: async () => {},
      dispose: () => {},
    }
    const harness = makeCtx({ tools: ['session_search'], openviking })
    await apply(harness.ctx, {})
    const session = makeSession('s9')
    const agent = makeAgent(session, harness)
    await harness.handlers.get('agent/created')[0]({ agent })

    await harness.getCommand().handler({ agent, rawInput: 'off' })
    session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
    session.append('command/done', { commandId: 'c1', kind: 'success' })

    const deadline = Date.now() + 2000
    while ((await readdir(dir)).includes('mine_0.json') && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    const left = await readdir(dir)
    assert.deepEqual(left, ['other_0.json'], 'only this conversation\'s queued writes are dropped')
  } finally {
    if (previous === undefined) delete process.env.OPENVIKING_PENDING_DIR
    else process.env.OPENVIKING_PENDING_DIR = previous
  }
})

test('cache_search counts as cross-conversation memory', async () => {
  const harness = makeCtx({ tools: ['cache_search', 'session_search'] })
  await apply(harness.ctx, {})
  const session = makeSession('s10')
  const agent = makeAgent(session, harness)
  await harness.handlers.get('agent/created')[0]({ agent })
  await harness.getCommand().handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })

  assert.equal(runGuard(harness, agent, 'cache_search').kind, 'deny')
  assert.ok(
    harness.restrictions.some(filter => (filter.deny ?? []).includes('cache_search')),
    'the research cache tool is hidden as well as denied',
  )
})

test('other-conversation message kinds are dropped per channel', async () => {
  const harness = makeCtx({ tools: [] })
  await apply(harness.ctx, {})
  const session = makeSession('s11')
  const agent = makeAgent(session, harness)
  await harness.handlers.get('agent/created')[0]({ agent })
  await harness.getCommand().handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })

  const decision = await runPreStep(harness, agent, [
    { source: { kind: 'user' } },
    { source: { kind: 'session-reference' } },
    { source: { kind: 'agent-message' } },
    { source: { kind: 'subagent-settled' } },
  ])
  assert.deepEqual(
    decision.messages.map(message => message.source.kind),
    ['user', 'subagent-settled'],
    'references and team relay are dropped; a settled subagent result is kept by default',
  )
})

test('relay and subagent-result channels follow their own switches', async () => {
  const harness = makeCtx({ tools: [] })
  await apply(harness.ctx, { blockTeamRelay: false, blockSubagentSettled: true })
  const session = makeSession('s12')
  const agent = makeAgent(session, harness)
  await harness.handlers.get('agent/created')[0]({ agent })
  await harness.getCommand().handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })

  const decision = await runPreStep(harness, agent, [
    { source: { kind: 'user' } },
    { source: { kind: 'session-reference' } },
    { source: { kind: 'agent-message' } },
    { source: { kind: 'subagent-settled' } },
  ])
  assert.deepEqual(
    decision.messages.map(message => message.source.kind),
    ['user', 'agent-message'],
    'the reference filter stays on while the two opt-outs are flipped',
  )
})

test('turning the switch off twice drops writes queued in between', async () => {
  const { mkdtemp, writeFile, readdir } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-memory-switch-'))
  const previous = process.env.OPENVIKING_PENDING_DIR
  process.env.OPENVIKING_PENDING_DIR = dir
  try {
    const openviking = {
      stateFor: () => ({ ovSessionId: 'dsh-session-s13' }),
      initialize: async () => {},
      profileMessage: async () => null,
      recallMessage: async () => null,
      capture: () => {},
      maybeCommit: () => {},
      flush: async () => {},
      dispose: () => {},
    }
    const harness = makeCtx({ tools: [], openviking })
    await apply(harness.ctx, {})
    const session = makeSession('s13')
    const agent = makeAgent(session, harness)
    await harness.handlers.get('agent/created')[0]({ agent })
    const command = harness.getCommand()

    await writeFile(join(dir, 'a_0.json'), JSON.stringify({ sessionId: 'dsh-session-s13' }))
    await command.handler({ agent, rawInput: 'off' })
    assert.deepEqual(await readdir(dir), [], 'the first OFF drains the queue before reporting success')

    await command.handler({ agent, rawInput: 'on' })
    await writeFile(join(dir, 'b_0.json'), JSON.stringify({ sessionId: 'dsh-session-s13' }))
    await command.handler({ agent, rawInput: 'off' })
    assert.deepEqual(await readdir(dir), [], 'a second OFF drops what was queued while it was on')
  } finally {
    if (previous === undefined) delete process.env.OPENVIKING_PENDING_DIR
    else process.env.OPENVIKING_PENDING_DIR = previous
  }
})

test('unknown config keys are reported instead of silently ignored', async () => {
  const warns = []
  const harness = makeCtx({ tools: [] })
  harness.ctx.logger = () => ({ debug() {}, info() {}, warn(message, detail) { warns.push(`${message} ${String(detail ?? '')}`) }, error() {} })
  await apply(harness.ctx, { blockSessionTool: false, hideFromSerch: true })
  assert.ok(
    warns.some(message => message.includes('ignored unknown config keys') && message.includes('blockSessionTool')),
    'a misspelled key is named in a warning',
  )
})

test('invalid config values fall back to defaults and are reported', async () => {
  const warns = []
  const harness = makeCtx({ tools: ['session_search'] })
  harness.ctx.logger = () => ({ debug() {}, info() {}, warn(message) { warns.push(String(message)) }, error() {} })
  await apply(harness.ctx, { blockSessionTools: 'no', denyToolNames: 'session_search' })

  assert.ok(
    warns.some(message => message.includes('ignored invalid config values')),
    'a rejected value is reported instead of silently shaping policy',
  )
  const session = makeSession('s14')
  const agent = makeAgent(session, harness)
  await harness.handlers.get('agent/created')[0]({ agent })
  await harness.getCommand().handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })
  assert.equal(
    runGuard(harness, agent, 'session_search').kind,
    'deny',
    'the mistyped boolean keeps its secure default',
  )
})


test('toggle resolves inside the fold, so it survives replay', () => {
  assert.equal(resolveMemoryTarget('toggle', true), false)
  assert.equal(resolveMemoryTarget('toggle', false), true)
  assert.equal(resolveMemoryTarget(' on ', false), true)
  assert.equal(resolveMemoryTarget('maybe', true), undefined)

  const session = makeSession('s15')
  session.append('command/run', { name: 'memory', args: 'toggle', commandId: 'c1' })
  assert.equal(session.fold().enabled, true, 'the run alone changes nothing')
  session.append('command/done', { commandId: 'c1', kind: 'success' })
  assert.equal(session.fold().enabled, false, 'a toggle folds to the opposite of the state it applied to')
  session.append('command/run', { name: 'memory', args: 'toggle', commandId: 'c2' })
  session.append('command/done', { commandId: 'c2', kind: 'success' })
  assert.equal(session.fold().enabled, true, 'a second toggle lands back on')
})

test('Agent Teams mailbox deliveries count as other-conversation context', async () => {
  const harness = makeCtx()
  await apply(harness.ctx, {})
  const session = makeSession('s16')
  const agent = makeAgent(session, harness)
  await harness.handlers.get('agent/created')[0]({ agent })
  await harness.getCommand().handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })

  const decision = await runPreStep(harness, agent, [
    { source: { kind: 'user' } },
    { source: { kind: 'team-message' } },
  ])
  assert.deepEqual(decision.messages.map(message => message.source.kind), ['user'], 'the team mailbox is a foreign-conversation channel')

  const open = makeCtx()
  await apply(open.ctx, { blockTeamMailbox: false })
  const session2 = makeSession('s17')
  const agent2 = makeAgent(session2, open)
  await open.handlers.get('agent/created')[0]({ agent: agent2 })
  await open.getCommand().handler({ agent: agent2, rawInput: 'off' })
  session2.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session2.append('command/done', { commandId: 'c1', kind: 'success' })
  const kept = await runPreStep(open, agent2, [{ source: { kind: 'team-message' } }])
  assert.equal(kept.messages.length, 1, 'blockTeamMailbox: false keeps mail')
})

test('IM archives and external-agent bridges are memory channels while off', async () => {
  const harness = makeCtx({ tools: ['dsh_im_group_history', 'dsh_im_group_file', 'codebuddy_ask', 'read_mcp_resource'] })
  await apply(harness.ctx, {})
  const session = makeSession('s18')
  const agent = makeAgent(session, harness)
  await harness.handlers.get('agent/created')[0]({ agent })
  await harness.getCommand().handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })

  assert.equal(runGuard(harness, agent, 'dsh_im_group_history').kind, 'deny', 'the group archive spans other conversations')
  assert.equal(runGuard(harness, agent, 'dsh_im_group_file').kind, 'deny')
  assert.equal(runGuard(harness, agent, 'codebuddy_ask').kind, 'deny', 'a second local agent can read session logs itself')

  const open = makeCtx({ tools: ['dsh_im_group_history', 'codebuddy_ask'] })
  await apply(open.ctx, { blockImHistory: false, blockExternalAgents: false })
  const session2 = makeSession('s19')
  const agent2 = makeAgent(session2, open)
  await open.handlers.get('agent/created')[0]({ agent: agent2 })
  await open.getCommand().handler({ agent: agent2, rawInput: 'off' })
  session2.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session2.append('command/done', { commandId: 'c1', kind: 'success' })
  assert.equal(runGuard(open, agent2, 'dsh_im_group_history').kind, 'allow')
  assert.equal(runGuard(open, agent2, 'codebuddy_ask').kind, 'allow')
})

test('memoryMcpServers names the MCP memory channels to cut', async () => {
  const harness = makeCtx({ tools: ['mcp__memory__search', 'mcp__notion__search', 'read_mcp_resource'] })
  await apply(harness.ctx, { memoryMcpServers: ['memory'] })
  const session = makeSession('s20')
  const agent = makeAgent(session, harness)
  await harness.handlers.get('agent/created')[0]({ agent })
  await harness.getCommand().handler({ agent, rawInput: 'off' })
  session.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  session.append('command/done', { commandId: 'c1', kind: 'success' })

  assert.equal(runGuard(harness, agent, 'mcp__memory__search').kind, 'deny')
  assert.equal(runGuard(harness, agent, 'mcp__notion__search').kind, 'allow', 'a document server is not memory by default')
  assert.equal(runGuard(harness, agent, 'read_mcp_resource', { server: 'memory' }).kind, 'deny')
  assert.equal(runGuard(harness, agent, 'read_mcp_resource', { server: 'notion' }).kind, 'allow')
})

test('a memory-off conversation is hidden from cross-session search', async () => {
  const liveOff = makeSession('live-off')
  liveOff.append('command/run', { name: 'memory', args: 'off', commandId: 'c1' })
  liveOff.append('command/done', { commandId: 'c1', kind: 'success' })
  const liveOn = makeSession('live-on')

  /** A fresh fake search service, so one mount cannot see another's wrapper. */
  function makeQuery(observed) {
    return {
      async searchSessions() {
        return {
          items: [
            { header: { id: 'live-off' } },
            { header: { id: 'persisted-off' } },
            { header: { id: 'live-on' } },
          ],
        }
      },
      async observeSession(id) {
        observed.push(id)
        return {
          projections: { values: { memorySwitch: { enabled: id !== 'persisted-off' } } },
          [Symbol.dispose]() {},
        }
      },
    }
  }

  const sessions = { get: id => (id === 'live-off' ? liveOff : id === 'live-on' ? liveOn : undefined) }
  const observed = []
  const sessionQuery = makeQuery(observed)
  const harness = makeCtx({ tools: [], sessions, sessionQuery })
  await apply(harness.ctx, {})

  const page = await sessionQuery.searchSessions({}, {})
  assert.deepEqual(page.items.map(hit => hit.header.id), ['live-on'], 'off conversations are filtered from search results')
  assert.ok(observed.includes('persisted-off'), 'a conversation that is not live is read from its durable projection')

  const kept = makeCtx({ tools: [], sessions, sessionQuery: makeQuery([]) })
  await apply(kept.ctx, { hideFromSearch: false })
  const unfiltered = await kept.ctx.get('sessionQuery').searchSessions({}, {})
  assert.equal(unfiltered.items.length, 3, 'hideFromSearch: false leaves search untouched')
})

test('defaultEnabled preselects the switch for a profile without a composer', () => {
  assert.equal(createMemoryProjection().init().enabled, true)
  assert.equal(createMemoryProjection({ defaultEnabled: false }).init().enabled, false)
  const offSession = makeSession('s21')
  const definition = createMemoryProjection({ defaultEnabled: false })
  assert.equal(definition.init().enabled, false, 'a fresh conversation starts off')
  offSession.append('command/run', { name: 'memory', args: 'on', commandId: 'c1' })
  offSession.append('command/done', { commandId: 'c1', kind: 'success' })
  assert.equal(offSession.fold().enabled, true, 'the explicit command still restores memory')
})
