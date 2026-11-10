/**
 * dsh-memory-switch — host half.
 *
 * One durable, per-conversation switch that decides whether that conversation
 * may exchange information with other conversations through any memory
 * channel. The switch state is derived entirely from the session log: a
 * `/memory on|off` run is folded by the `memorySwitch` session projection, so
 * resume, replay and fork restore it from what is already durable — and a fork
 * inherits the parent's switch state together with the inherited event prefix.
 *
 * While the switch is OFF for a conversation this plugin:
 *   - denies cross-conversation tools through the monotonic tool guard
 *     (session-history search, the research page cache, OpenViking MCP tools
 *     and resources, optionally ThoughtDAG `why_*`) and hides them with a
 *     per-agent restriction;
 *   - stops OpenViking from recalling long-term memory into that conversation
 *     and from capturing it back to the server (wraps the provided
 *     `openvikingMemory` service, so the third-party package stays untouched),
 *   - drops that conversation's still-queued OpenViking writes, on every OFF;
 *   - drops other-conversation context messages from the step it is about to
 *     enter: `session-reference` snapshots, team relay (`agent-message`), and
 *     optionally re-injected subagent results (`subagent-settled`);
 *   - tells the model, through a prompt section, that memory is off;
 *   - propagates OFF to subagent conversations it spawns, and re-reads the
 *     parent's durable projection so a restart does not lose the inheritance.
 *
 * Scope: this is a policy gate over the seams a plugin can see, not a sandbox.
 * A conversation with `bash`/`read` can still open the session logs directly.
 *
 * @module dsh-memory-switch
 */

import { readdir, readFile, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Projection key shared by the host unit and the client switch. */
export const MEMORY_KEY = 'memorySwitch'

/** Command name, without the leading slash. */
export const MEMORY_COMMAND = 'memory'

/** Stable wire views: identity-stable per flag so unchanged states never publish. */
const VIEW_ON = Object.freeze({ enabled: true })
const VIEW_OFF = Object.freeze({ enabled: false })

/** Model-facing policy shown only while the switch is off. */
const OFF_SECTION = `## Memory switch: OFF for this conversation (记忆已关闭)

The user turned cross-conversation memory OFF for this conversation. Honor it:
- Do not retrieve or cite other conversations. Session-history search tools are
  unavailable here by policy; do not try to work around their absence.
- Do not read or write long-term memory, and never present something as
  "recalled" from earlier sessions.
- Work only from this conversation's own history and from the workspace files
  or links the user provides here.
- If the user asks for something that would require another conversation's
  context, say that memory is off for this conversation and ask them to supply
  the material here (or to turn the switch back on).`

/** OpenViking MCP tools are published under this harness prefix. */
const OPENVIKING_TOOL_PREFIX = 'mcp__openviking__'

/** MCP resource tools carry the server as an argument instead of a name prefix. */
const MCP_RESOURCE_TOOL_NAMES = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']

/** Stock session-history retrieval tools: cross-conversation by construction. */
const SESSION_TOOL_NAMES = [
  'session_search',
  'session_event_search',
  'session_event_read',
  'session_trace',
  'session_event_trace',
  // The research page cache is a per-user store (~/.cache/dsh-free-search),
  // so this tool can re-read pages another conversation fetched.
  'cache_search',
]

/** Injected user-message sources contributed by other live conversations. */
const TEAM_RELAY_KIND = 'agent-message'

/** Subagent result re-injection into the parent conversation. */
const SUBAGENT_SETTLED_KIND = 'subagent-settled'

/** ThoughtDAG `why` layer: cross-agent conversation index (opt-in to block). */
const WHY_TOOL_NAMES = ['why_check', 'why_file', 'why_find', 'why_recall']

/** Injected message source kinds that carry another conversation's content. */
const FOREIGN_MESSAGE_KINDS = ['session-reference']

const DENY_REASON = 'Memory is off for this conversation (记忆已关闭)：跨对话记忆工具在此会话不可用。'

const DEFAULTS = {
  blockOpenViking: true,
  blockSessionTools: true,
  blockThoughtdag: false,
  blockSessionReferences: true,
  blockOpenVikingSkills: false,
  blockTeamRelay: true,
  blockSubagentSettled: false,
  denyToolNames: [],
  denyToolPrefixes: [],
}

/**
 * Parse the command's free-form argument.
 * @param value raw command input (the registry keeps separator whitespace).
 * @returns the requested state, or undefined when the argument changes nothing.
 */
export function parseMemoryArgument(value) {
  const arg = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (arg === 'on' || arg === '1' || arg === 'true' || arg === 'enable') return true
  if (arg === 'off' || arg === '0' || arg === 'false' || arg === 'disable') return false
  return undefined
}

/** Whether a value is a JSON record rather than an array. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate one folded state; only `parse` is used by the projection registry. */
const stateSchema = {
  parse(value) {
    if (!isRecord(value)) throw new Error('memory-switch: projection state must be an object')
    if (typeof value.enabled !== 'boolean') throw new Error('memory-switch: state.enabled must be a boolean')
    if (value.running === null || value.running === undefined) return { enabled: value.enabled, running: null }
    if (!isRecord(value.running)
      || typeof value.running.commandId !== 'string'
      || typeof value.running.wanted !== 'boolean') {
      throw new Error('memory-switch: state.running must be { commandId, wanted } or null')
    }
    return { enabled: value.enabled, running: { commandId: value.running.commandId, wanted: value.running.wanted } }
  },
}

/** Validate one published view. */
const viewSchema = {
  parse(value) {
    if (!isRecord(value) || typeof value.enabled !== 'boolean') {
      throw new Error('memory-switch: view must be { enabled: boolean }')
    }
    return value
  },
}

/**
 * Log-derived memory state: the last settled `/memory on|off` wins.
 *
 * A command only changes the state when its paired `command/done` reports
 * success, so a rejected toggle leaves the switch untouched. No custom session
 * event type is introduced: the fold reads the existing `command/run` /
 * `command/done` pair.
 */
export const memoryProjection = {
  key: MEMORY_KEY,
  stateVersion: 1,
  stateSchema,
  init: () => ({ enabled: true, running: null }),
  apply(state, event) {
    if (event.type === 'command/run' && event.data?.name === MEMORY_COMMAND) {
      const wanted = parseMemoryArgument(event.data.args)
      if (wanted === undefined) return state
      return { enabled: state.enabled, running: { commandId: event.data.commandId, wanted } }
    }
    if (event.type === 'command/done') {
      const running = state.running
      if (running === null || event.data?.commandId !== running.commandId) return state
      const enabled = event.data.kind === 'success' ? running.wanted : state.enabled
      return { enabled, running: null }
    }
    return state
  },
  wire: {
    viewSchema,
    // The view is a constant per flag, so the registry's Object.is comparison
    // suppresses publication for unrelated events.
    view: state => (state.enabled ? VIEW_ON : VIEW_OFF),
    summary: true,
  },
}

/** Required services: prompt contributions, the projection table, and tools. */
export const inject = ['systemPrompt', 'sessionProjections', 'tools']

/**
 * Normalize one plugin config value.
 *
 * A wrong type never escalates into a silent permission change: the affected
 * key falls back to its default and the discarded value is reported, because a
 * mistyped `denyToolNames: 'session_search'` used to become `[]` (fail-open)
 * with no trace anywhere.
 *
 * @param input raw cordis config.
 * @param warn reporter for keys whose value was rejected.
 * @returns the effective config.
 */
function normalizeConfig(input, warn) {
  const raw = isRecord(input) ? input : {}
  if (input !== undefined && !isRecord(input)) {
    warn('config is not an object; every key uses its default', { received: typeof input })
  }
  const discards = []
  const pickBool = key => {
    const value = raw[key]
    if (value === undefined) return DEFAULTS[key]
    if (typeof value === 'boolean') return value
    discards.push({ key, expected: 'boolean', received: typeof value })
    return DEFAULTS[key]
  }
  const pickList = key => {
    const value = raw[key]
    if (value === undefined) return DEFAULTS[key]
    if (!Array.isArray(value)) {
      discards.push({ key, expected: 'string[]', received: typeof value })
      return DEFAULTS[key]
    }
    const kept = value.filter(entry => typeof entry === 'string' && entry.length > 0)
    if (kept.length < value.length) {
      discards.push({ key, expected: 'non-empty strings', received: value.length - kept.length })
    }
    return kept
  }
  const config = {
    blockOpenViking: pickBool('blockOpenViking'),
    blockSessionTools: pickBool('blockSessionTools'),
    blockThoughtdag: pickBool('blockThoughtdag'),
    blockSessionReferences: pickBool('blockSessionReferences'),
    blockOpenVikingSkills: pickBool('blockOpenVikingSkills'),
    blockTeamRelay: pickBool('blockTeamRelay'),
    blockSubagentSettled: pickBool('blockSubagentSettled'),
    denyToolNames: pickList('denyToolNames'),
    denyToolPrefixes: pickList('denyToolPrefixes'),
  }
  if (discards.length > 0) warn('ignored invalid config values; defaults applied', { discards })
  return config
}

/**
 * Mount the projection, the `/memory` command, the model-facing policy section,
 * and every memory-channel gate.
 * @param ctx plugin context.
 * @param input optional row config overriding the channel selection.
 * @returns a promise settling once the projection is registered.
 */
export async function apply(ctx, input) {
  /** Best-effort logger: logging must never interfere with policy. */
  const log = (level, message, detail) => {
    try {
      const logger = typeof ctx.logger === 'function' ? ctx.logger('memory-switch') : ctx.logger
      const write = logger?.[level] ?? logger?.info
      if (typeof write === 'function') {
        write.call(logger, detail === undefined ? message : `${message} ${JSON.stringify(detail)}`)
      }
    } catch {
      /* ignore */
    }
  }

  /** Effective config, validated against the switch's own defaults. */
  const config = normalizeConfig(input, (message, detail) => log('warn', message, detail))

  /** Projection handle; reads fall back to "enabled" before registration. */
  let handle

  /** The OpenViking runtime once its service exists. */
  let openviking

  /** Per-session in-memory override: set by a toggle, cleared when the fold catches up. */
  const overrides = new Map()

  /** Sessions known to be OFF, by durable id (parent → subagent propagation). */
  const knownOff = new Set()

  /** Subagent conversations forced off in memory because their parent is off. */
  const inheritedOff = new Set()

  /**
   * Sessions with a queue drop in flight.
   *
   * This is a concurrency guard, not a "done once" marker: turning the switch
   * off again must drop whatever was queued in the meantime, so the entry is
   * removed as soon as the attempt settles.
   */
  const dropping = new Set()

  /**
   * Read the switch for one session.
   * @param session session to read.
   * @returns true when cross-conversation memory is allowed.
   */
  function isEnabled(session) {
    if (!session) return true
    const id = session.id
    let folded
    try {
      const state = handle?.stateOf?.(session)
      if (state && typeof state.enabled === 'boolean') folded = state.enabled
    } catch {
      /* unreadable projection: fall through to the in-memory view */
    }
    if (overrides.has(id)) {
      const wanted = overrides.get(id)
      if (folded === wanted) overrides.delete(id)
      else return wanted
    }
    // A subagent conversation spawned by an OFF parent has no durable event of
    // its own, so the in-memory inheritance outranks its (enabled) projection.
    if (inheritedOff.has(id)) return false
    if (folded !== undefined) return folded
    if (knownOff.has(id)) return false
    return true
  }

  /**
   * Record a visible state change immediately, before the fold commits.
   * @param session session being toggled.
   * @param enabled requested state.
   */
  function remember(session, enabled) {
    if (!session) return Promise.resolve()
    const id = session.id
    overrides.set(id, enabled)
    if (enabled) {
      knownOff.delete(id)
      inheritedOff.delete(id)
      return Promise.resolve()
    }
    knownOff.add(id)
    // Awaited by the command handler: reporting "off" only after the queue is
    // drained closes the window where a drain tick replays what was captured.
    return dropPendingWrites(session)
  }

  /**
   * Whether one tool belongs to a cross-conversation memory channel.
   * @param toolName model-facing tool name.
   * @returns true when the call must be denied for a memory-off session.
   */
  function isBlockedToolName(toolName) {
    const tool = String(toolName ?? '')
    if (tool === '') return false
    if (config.blockOpenViking && tool.startsWith(OPENVIKING_TOOL_PREFIX)) return true
    if (config.blockSessionTools && SESSION_TOOL_NAMES.includes(tool)) return true
    if (config.blockThoughtdag && WHY_TOOL_NAMES.includes(tool)) return true
    if (config.denyToolNames.includes(tool)) return true
    return config.denyToolPrefixes.some(prefix => tool.startsWith(prefix))
  }

  /**
   * Whether one execution must be denied while the switch is off.
   * @param exec tool execution view.
   * @returns a denial reason, or undefined to let it run.
   */
  function denialFor(exec) {
    const agent = exec?.agent
    if (!agent?.session) return undefined
    if (isEnabled(agent.session)) return undefined
    const toolName = String(exec.name ?? '')
    if (isBlockedToolName(toolName)) return DENY_REASON
    if (config.blockOpenViking && MCP_RESOURCE_TOOL_NAMES.includes(toolName)) {
      const server = String(exec.arguments?.server ?? '')
      if (server === 'openviking') return DENY_REASON
    }
    if (config.blockOpenVikingSkills && toolName === 'skill') {
      const skillName = String(exec.arguments?.name ?? '')
      if (skillName.startsWith('openviking') || skillName === 'ov-experience-memory') {
        return 'Memory is off for this conversation (记忆已关闭)：OpenViking 技能在此会话不可用。'
      }
    }
    return undefined
  }

  /** Per-agent gate bookkeeping: applied restriction + cumulative denied names. */
  const gates = new Map()

  /**
   * Read or create the gate record for one live agent.
   * @param agent live agent.
   * @returns the mutable record.
   */
  function gateFor(agent) {
    const id = agent?.session?.id
    if (id === undefined) return undefined
    let gate = gates.get(id)
    if (gate === undefined) {
      gate = { denied: new Set(), dispose: undefined }
      gates.set(id, gate)
    }
    return gate
  }

  /**
   * Reconcile the per-agent tool restriction with the current switch state.
   * Denied names accumulate: a hidden tool disappears from the visible set, so
   * the union is what keeps one restriction stable across steps. Visibility is
   * only the UX layer; `denialFor` is the enforcement layer.
   * @param agent live agent.
   */
  function syncToolGate(agent) {
    const gate = gateFor(agent)
    if (gate === undefined) return
    if (isEnabled(agent.session)) {
      if (gate.denied.size > 0) gate.denied.clear()
      const dispose = gate.dispose
      gate.dispose = undefined
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
      return
    }
    // Names that already produced a working restriction; kept for the retry
    // below so one bad addition cannot cost the whole hidden set.
    const before = new Set(gate.denied)
    let added = false
    try {
      // Enumeration uses the root registry (it accepts the agent as a scope);
      // the restriction must be applied on the agent's own scope.
      for (const schema of ctx.tools.schemas(agent)) {
        const toolName = schema?.name
        if (typeof toolName !== 'string' || gate.denied.has(toolName)) continue
        if (!isBlockedToolName(toolName)) continue
        gate.denied.add(toolName)
        added = true
      }
    } catch (error) {
      log('debug', 'could not enumerate agent tools', { error: String(error) })
    }
    if (!added && gate.dispose !== undefined) return
    try {
      gate.dispose?.()
    } catch {
      /* ignore */
    }
    gate.dispose = undefined
    if (gate.denied.size === 0) return
    try {
      gate.dispose = agent.ctx.tools.restrict({ deny: [...gate.denied] })
      return
    } catch (error) {
      log('warn', 'tool restriction failed', { error: String(error), names: [...gate.denied] })
    }
    // The registry rejects a name it does not accept as a global restriction
    // (a stale or scope-local entry). Dropping the whole hidden set would
    // silently lose the UX layer for every already-working name, so fall back
    // to exactly the names that worked before this round.
    gate.denied.clear()
    for (const name of before) {
      if (isBlockedToolName(name)) gate.denied.add(name)
    }
    if (gate.denied.size === 0) return
    try {
      gate.dispose = agent.ctx.tools.restrict({ deny: [...gate.denied] })
    } catch (error) {
      log('warn', 'tool restriction retry failed; hidden set unavailable', { error: String(error) })
      gate.denied.clear()
    }
  }

  // ── OpenViking adapter ─────────────────────────────────────────────────
  // The third-party OpenViking plugin provides its runtime as the
  // `openvikingMemory` service. Wrapping that service's public methods keeps
  // recall, profile injection, capture, commit, and shutdown-commit out of a
  // memory-off conversation without editing the third-party package.

  /** Wrap every entry point that carries a session. */
  function installOpenVikingGuard(runtime) {
    if (!runtime || typeof runtime !== 'object') return undefined
    const skip = session => session !== undefined && session !== null && !isEnabled(session)
    /** Original methods replaced by this install, restored on dispose. */
    const originals = []
    const wrap = (method, factory) => {
      const original = runtime[method]
      if (typeof original !== 'function') return
      originals.push([method, original])
      runtime[method] = factory(original.bind(runtime))
    }
    wrap('initialize', original => async agent => (skip(agent?.session) ? undefined : original(agent)))
    wrap('profileMessage', original => async agent => (skip(agent?.session) ? null : original(agent)))
    wrap('recallMessage', original => async (agent, messages) => (skip(agent?.session) ? null : original(agent, messages)))
    wrap('capture', original => (session, event) => (skip(session) ? undefined : original(session, event)))
    wrap('maybeCommit', original => (session, event) => (skip(session) ? undefined : original(session, event)))
    wrap('flush', original => async session => (skip(session) ? undefined : original(session)))
    wrap('dispose', original => (session) => {
      if (!skip(session)) return original(session)
      // Clean up local state without sending the shutdown commit.
      try {
        runtime.states?.delete?.(session.id)
      } catch {
        /* ignore */
      }
      void dropPendingWrites(session)
      return undefined
    })
    log('info', 'OpenViking memory guarded')
    // The profile runs `patchReload: live`: without a disposer a reload would
    // stack wrappers on the same runtime methods and keep stale closures.
    return () => {
      for (const [method, original] of originals) {
        try {
          runtime[method] = original
        } catch {
          /* ignore */
        }
      }
      originals.length = 0
    }
  }

  /**
   * Drop this conversation's queued OpenViking writes, so a global drain tick
   * cannot replay content captured before the switch was turned off.
   *
   * Every OFF attempt drops again: content captured while the switch was back
   * on must not survive a second OFF. Repeated concurrent calls for the same
   * conversation share one attempt instead of racing the same files.
   *
   * @param session session whose queue must be cleared.
   * @returns a promise settling when this attempt finished.
   */
  async function dropPendingWrites(session) {
    const id = session?.id
    if (id === undefined || dropping.has(id)) return
    dropping.add(id)
    try {
      const state = openviking?.stateFor?.(session)
      const ovSessionId = state?.ovSessionId
      if (typeof ovSessionId !== 'string' || ovSessionId === '') return
      const dir = process.env.OPENVIKING_PENDING_DIR || join(homedir(), '.openviking', 'pending')
      const entries = await readdir(dir)
      for (const name of entries) {
        if (!name.endsWith('.json')) continue
        const file = join(dir, name)
        try {
          const record = JSON.parse(await readFile(file, 'utf8'))
          if (record?.sessionId === ovSessionId) await unlink(file)
        } catch {
          /* unreadable or already gone */
        }
      }
      log('info', 'dropped queued OpenViking writes for a memory-off conversation')
    } catch {
      /* no queue, no permission, or no runtime: nothing to drop */
    } finally {
      dropping.delete(id)
    }
  }

  // ── Human surface: /memory ─────────────────────────────────────────────
  // Registered before the projection so the switch works the moment a command
  // registry exists; the fold picks the change up from the log.
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: MEMORY_COMMAND,
      description: 'Turn cross-conversation memory on or off for this conversation (记忆开关)',
      input: { hint: '[on|off|status]' },
      handler: async ({ agent, rawInput }) => {
        if (!agent?.session) return { kind: 'error', text: 'memory-switch: no active conversation' }
        const arg = typeof rawInput === 'string' ? rawInput.trim().toLowerCase() : ''
        if (arg === '' || arg === 'status') {
          return {
            kind: 'success',
            text: isEnabled(agent.session)
              ? 'Memory is ON for this conversation: history search, cross-conversation references, and long-term memory are available.'
              : 'Memory is OFF for this conversation: no history search, cross-conversation reference, or long-term memory read/write.',
          }
        }
        const wanted = parseMemoryArgument(arg === 'toggle' ? (isEnabled(agent.session) ? 'off' : 'on') : arg)
        if (wanted === undefined) {
          return { kind: 'error', text: `memory-switch: unknown argument "${arg}" (use on|off|status)` }
        }
        if (isEnabled(agent.session) === wanted) {
          return {
            kind: 'success',
            text: `Memory is already ${wanted ? 'ON' : 'OFF'} for this conversation.`,
          }
        }
        await remember(agent.session, wanted)
        try {
          syncToolGate(agent)
        } catch {
          /* ignore */
        }
        return {
          kind: 'success',
          text: wanted
            ? 'Memory is now ON for this conversation.'
            : 'Memory is now OFF for this conversation: this conversation will not read or write cross-conversation memory.',
        }
      },
    })
  })

  // Optional third-party service: the child fiber activates only when the
  // OpenViking plugin provided its runtime, which also orders the wrapping
  // after that plugin is mounted. `restore` unwraps on fiber dispose, so a
  // live reload never stacks guards on the shared runtime.
  ctx.inject(['openvikingMemory'], (scope) => {
    openviking = scope.openvikingMemory
    const restore = installOpenVikingGuard(openviking)
    if (typeof restore === 'function') {
      ctx.effect(() => restore, 'memory-switch: OpenViking guard')
    }
  })

  // Consumers must not publish before the unit is ready: the prompt section
  // reads the folded state on every assembly.
  handle = await ctx.sessionProjections.register(memoryProjection)

  // Model-facing policy, present only while the switch is off.
  const baseOrder = typeof ctx.systemPrompt?.getSectionOrder === 'function'
    ? ctx.systemPrompt.getSectionOrder('PLAN_POLICY')
    : undefined
  // Staggered behind `grill:policy` (+10): two per-conversation policy sections
  // that share an order would be sequenced by key name, which is an accident.
  const policyOrder = (Number.isFinite(baseOrder) ? baseOrder : 0) + 20
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'memory-switch:policy',
    order: policyOrder,
    text: (context) => {
      const agent = context?.agent
      if (agent === undefined || agent === null) return ''
      try {
        return isEnabled(agent.session) ? '' : OFF_SECTION
      } catch {
        return ''
      }
    },
  }), 'memory-switch: policy section')

  // ── Enforcement: the monotonic tool guard ──────────────────────────────
  // Guards have no "allow" result, so listener ordering cannot turn a denial
  // back into permission; a global guard covers every agent's calls.
  ctx.effect(() => ctx.tools.guard(denialFor), 'memory-switch: tool guard')

  // ── Lifecycle wiring ───────────────────────────────────────────────────

  // Registered at apply time rather than on the first `agent/created`: the
  // profile reloads plugins live (`patchReload: live`), and a conversation that
  // already exists when this plugin mounts would otherwise keep accepting
  // cross-conversation context until some *other* conversation is created.
  // `prepend` keeps this filter outermost among the boot-time contributors.
  ctx.effect(
    () => ctx.on('agent/pre-step', filterPreStep, { prepend: true }),
    'memory-switch: pre-step filter',
  )

  /**
   * Force one conversation off through the in-memory inheritance path.
   * @param agent live agent owning the conversation.
   * @param id durable session id.
   */
  function inheritOff(agent, id) {
    inheritedOff.add(id)
    knownOff.add(id)
    void dropPendingWrites(agent.session)
    try {
      syncToolGate(agent)
    } catch (error) {
      log('warn', 'inherited gate failed', { error: String(error) })
    }
  }

  /**
   * Whether a parent conversation had memory off, read through whatever is
   * available for a parent that is not live in this process.
   *
   * In-memory bookkeeping alone loses the answer across a restart: a spawned
   * subagent carries no `/memory` event of its own, so its fold reads "on"
   * again after `dsh web` restarts. The parent's own log still knows, so the
   * question is asked of the live registry first and of the durable session
   * query second.
   *
   * @param parentId durable parent session id.
   * @returns true when the parent is off, false when it is on, undefined when
   * it cannot be read.
   */
  async function parentIsOff(parentId) {
    const sessions = ctx.get?.('sessions')
    const parent = sessions !== undefined && typeof sessions.get === 'function' ? sessions.get(parentId) : undefined
    if (parent !== undefined) return !isEnabled(parent)
    const query = ctx.get?.('sessionQuery')
    if (query === undefined || typeof query.observeSession !== 'function') return undefined
    let observation
    try {
      observation = await query.observeSession(parentId, { projectionMode: 'all' })
      const value = observation?.projections?.values?.[MEMORY_KEY]
      if (value !== undefined && typeof value.enabled === 'boolean') return value.enabled === false
      return undefined
    } catch {
      return undefined
    } finally {
      try {
        observation?.[Symbol.dispose]?.()
      } catch {
        /* ignore */
      }
    }
  }

  /** One conversation came alive: reconcile gates and inherit parent policy. */
  ctx.on('agent/created', ({ agent }) => {
    if (!agent?.session) return
    try {
      const id = agent.session.id
      if (!isEnabled(agent.session)) {
        knownOff.add(id)
        void dropPendingWrites(agent.session)
        syncToolGate(agent)
        return
      }
      knownOff.delete(id)
      const parentId = agent.session.header?.parentSession
      if (typeof parentId !== 'string' || parentId === '') {
        syncToolGate(agent)
        return
      }
      // A spawned conversation must not become the leak its parent refused.
      if (knownOff.has(parentId)) {
        inheritOff(agent, id)
        return
      }
      syncToolGate(agent)
      // The parent was not seen off in this process; it may be a resumed
      // conversation whose switch lives in its own log.
      void parentIsOff(parentId).then((off) => {
        // An explicit choice made in this process always wins over inheritance.
        if (off !== true || overrides.has(id)) return
        inheritOff(agent, id)
        log('info', 'conversation inherited memory-off from its parent session')
      }, () => { /* unreadable parent: keep the conversation on */ })
    } catch (error) {
      log('warn', 'agent/created handling failed', { error: String(error) })
    }
  })

  /**
   * Strip foreign-conversation context from the step about to be entered.
   * @param payload agent/pre-step payload.
   * @param next downstream waterfall.
   * @returns the (possibly filtered) decision.
   */
  async function filterPreStep({ agent, signal }, next) {
    const decision = await next()
    if (signal?.aborted) return decision
    try {
      syncToolGate(agent)
    } catch (error) {
      log('warn', 'pre-step gate failed', { error: String(error) })
    }
    if (isEnabled(agent?.session)) return decision
    if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    const kept = decision.messages.filter(message => !isForeignContextMessage(message))
    if (kept.length === decision.messages.length) return decision
    return { ...decision, messages: kept }
  }

  /**
   * Whether a step message carries another conversation's content.
   *
   * Each kind is gated by its own switch, so turning one channel off never
   * silently turns another on: `session-reference` follows
   * `blockSessionReferences`, Team relay follows `blockTeamRelay`, subagent
   * results follow `blockSubagentSettled`.
   *
   * @param message candidate user message.
   * @returns true when the message must be dropped for a memory-off session.
   */
  function isForeignContextMessage(message) {
    const kind = message?.source?.kind
    if (typeof kind !== 'string') return false
    if (kind === 'session-reference') return config.blockSessionReferences
    if (kind === TEAM_RELAY_KIND) return config.blockTeamRelay
    if (kind === SUBAGENT_SETTLED_KIND) return config.blockSubagentSettled
    // Kinds added by future contributors stay blocked until opted out.
    if (FOREIGN_MESSAGE_KINDS.includes(kind)) return true
    return config.blockOpenViking && kind.toLowerCase().includes('openviking')
  }

  // Release gate bookkeeping when a conversation goes away.
  ctx.on('agent/disposed', ({ agent }) => {
    const id = agent?.session?.id
    if (id === undefined) return
    const gate = gates.get(id)
    gates.delete(id)
    overrides.delete(id)
    try {
      gate?.dispose?.()
    } catch {
      /* ignore */
    }
  })
}
