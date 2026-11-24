# dsh-memory-switch — per-conversation memory switch

One switch per conversation. Turned off, that conversation stops exchanging
information with other conversations through any of the channels listed below.

> It is a **policy gate, not a sandbox**: it closes the seams a plugin can see
> (tools, injected messages, wrapped services). Reading `~/.dsh/sessions/`
> directly through `bash` / `read` needs a sandbox policy — see Known limits.

- The switch lives in the composer tool row (`conversation.input.left`, beside
  the permission / plan chips) and is per conversation.
- State is derived entirely from the session log: clicking the switch runs
  `/memory on` or `/memory off`, the host folds that command into the
  `memorySwitch` session projection, and the projection frame pushes the new
  state back. Reload, resume, and fork all restore the same position; a fork
  inherits its parent's state through the inherited event prefix.
- Default: **on**, matching today's behaviour, unless the profile sets
  `defaultEnabled: false` (useful where no composer exists — see Environments).

## What OFF cuts

| Channel | Enforcement |
|---|---|
| `session_search`, `session_event_search`, `session_event_read`, `session_trace`, `session_event_trace` | Monotonic tool guard denies the call; a per-agent restriction hides them from the model |
| `cache_search` (research page cache in `~/.cache/dsh-free-search/research.db`, shared across conversations) | same — it can return pages another conversation fetched |
| Cross-conversation references (`@`-mentioned session snapshots) | filtered out of the prepared step (`source.kind = session-reference`) |
| Team relay messages (Agent Teams `source.kind = agent-message`) | filtered by default; `blockTeamRelay: false` lets them through |
| Agent Teams mailbox deliveries (`source.kind = team-message`, durable history written by another conversation) | filtered by default; `blockTeamMailbox: false` keeps them |
| IM archives — `dsh_im_group_history`, `dsh_im_group_file` (the same group's earlier DSH conversations) | guard + hidden while off; `blockImHistory: false` keeps them |
| External-agent bridges — `codebuddy_ask` (a second local agent with its own session access) | guard + hidden while off; `blockExternalAgents: false` keeps them |
| Cross-session full-text search results **about this conversation** | `sessionQuery.searchSessions` pages are filtered by the same durable state, so an OFF conversation is not found by other conversations' `session_search` |
| Subagent results re-injected into the parent (`source.kind = subagent-settled`) | **kept** by default (same lineage); `blockSubagentSettled: true` filters them |
| Subagent conversations spawned by this one | inherit OFF, including after a restart (the parent's durable projection is consulted when the parent is not live) |
| Model behaviour | a `memory-switch:policy` prompt section explains that memory is off and not to work around it |
| OpenViking tools, MCP resources, recall, capture, commits, queued writes | guard plus wrapped `openvikingMemory` service (`initialize` / `profileMessage` / `recallMessage` / `capture` / `maybeCommit` / `flush` / `dispose`). **Only when `@openviking/dsh-memory-plugin` is installed**; otherwise this whole section is inert and every other channel still applies |

Left on by default (configurable): ThoughtDAG `why_*` tools
(`blockThoughtdag: true`) and OpenViking-provided skills
(`blockOpenVikingSkills: true`). Workspace `AGENTS.md` instructions and ordinary
skills are not conversation memory and always stay available.

MCP memory servers are declared by name: `memoryMcpServers` (default
`['openviking']`) blocks both `mcp__<server>__*` tools and the resource tools
whose `server` argument names it. Document servers such as `mcp__notion__*` stay
allowed unless you list them, because whether they carry conversation memory
depends on what you wired up; `denyToolNames` / `denyToolPrefixes` remain
available for anything else.

## Install

A standard DSH profile bundle: host half `lib/index.js`, browser half
`lib/client.js` (`dsh.client`). Install it from GitHub:

```sh
dsh plugin add github:Kingzhoudk/dsh-memory-switch
# or the explicit git spec
dsh plugin add git+https://github.com/Kingzhoudk/dsh-memory-switch.git
```

The plugin manager records the dependency and enables the bundle; without HMR
the runtime must restart before the Host half mounts. The browser half appears
after the page reloads.

For a local checkout, install the directory instead
(`dsh plugin add link:/absolute/path/to/dsh-memory-switch`), or mount it by hand
through the profile:

```json
// ~/.dsh/profiles/web/package.json — dependencies
"dsh-memory-switch": "link:/absolute/path/to/dsh-memory-switch"
```

Mount it either as a bundle (append `"dsh-memory-switch"` to
`dsh.profile.bundles`; takes effect on restart) or through the profile's user
patch layer (`patchReload: live`, effective immediately):

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: memory-switch
      name: dsh-memory-switch
```

Then run `pnpm install` inside the profile directory so
`node_modules/dsh-memory-switch` resolves.

## Environments without a composer

The switch is a command first and a Web surface second. `/memory on|off|toggle|status`
runs anywhere a command registry exists — the Web/Desktop composer, an IM relay
chat, an ACP/SDK client, a terminal — so a conversation without the
`conversation.input.left` slot can still be controlled.

Where nobody can type a command first (`dsh headless` one-shot runs, scheduled
prompts), set `defaultEnabled: false` on the row: every fresh conversation then
starts OFF, and an explicit `/memory on` still restores it. Because the state is
log-derived, a resumed conversation keeps whatever it chose last.

## Commands

| Input | Behaviour |
|---|---|
| `/memory` or `/memory status` | show the current state of this conversation |
| `/memory off` | cut every cross-conversation memory channel (takes effect immediately) |
| `/memory on` | restore every channel |
| `/memory toggle` | invert |

## Configuration

```yaml
- id: memory-switch
  name: dsh-memory-switch
  config:
    blockOpenViking: true        # OpenViking recall/capture + its tools (needs the plugin)
    blockSessionTools: true      # session_search / cache_search and friends
    blockSessionReferences: true # drop @ cross-conversation snapshots
    blockTeamRelay: true         # drop team relay messages (agent-message)
    blockSubagentSettled: false  # drop subagent result re-injection (subagent-settled)
    blockThoughtdag: false       # also deny why_* (off by default)
    blockOpenVikingSkills: false # also deny OpenViking skills
    blockTeamMailbox: true       # drop Agent Teams mailbox deliveries (team-message)
    blockImHistory: true         # deny dsh_im_group_history / dsh_im_group_file
    blockExternalAgents: true    # deny external-agent bridges (codebuddy_ask)
    hideFromSearch: true         # hide this conversation from cross-session search
    defaultEnabled: true         # false starts every fresh conversation OFF
    memoryMcpServers: [openviking] # MCP servers treated as memory channels
    denyToolNames: []
    denyToolPrefixes: []
```

## Known limits

- **Direction**: an OFF conversation is strongly prevented from reading other
  conversations, and `hideFromSearch` removes it from cross-session full-text
  search results. Two gaps remain: a tool that is given the conversation id
  directly (`session_event_search`, `session_event_read`, `session_trace`) can
  still open it, and ThoughtDAG reads `~/.dsh/sessions` itself so no plugin seam
  filters it. Closing those needs a change in `tool-session-query` /
  `dsh-thoughtdag`.
- **Search filtering cost and TTL**: every hit is resolved against the durable
  projection (cached for 10 s), so a page of results costs up to one prepared
  session read per unseen conversation. A conversation turned back on elsewhere
  can stay hidden for at most that TTL.
- **Not a sandbox**: this plugin only closes model-visible channels. With
  `bash` / `read` available, the model can still read `~/.dsh/sessions/**.jsonl.zstd`
  or `~/.cache/dsh-free-search/research.db` directly. Preventing that needs a
  sandbox policy (`denyToolNames: ['bash']`, workspace file restrictions), which
  is out of scope here.
- **Third-party coupling**: the OpenViking side wraps the methods of its
  `openvikingMemory` service (`initialize`, `profileMessage`, `recallMessage`,
  `capture`, `maybeCommit`, `flush`, `dispose` — seven). Missing methods are
  skipped, but a renamed method after an upgrade would silently weaken that
  channel (the tool guard is unaffected). The wraps register a `ctx.effect`
  restorer, so a live reload does not stack them.
- **When OpenViking is not installed**: nothing in `~/.openviking/pending` is
  cleaned (without the service there is no `ovSessionId`); clear that directory
  by hand, or reinstall the plugin and toggle once.
- **Already-injected content is not retracted**: turning the switch off after a
  step does not remove recall text already written into this conversation's
  history; it only stops future reads and writes.

## Development

```bash
npm test          # unit + browser suites, then the real-host integration script
```

`npm test` runs `node --test tests/host.test.mjs tests/client.test.mjs` and then
`node scripts/test.mjs`. The integration script mounts the plugin into a real
Harness host (llm, sessions, projections, system prompt, tools, commands, agent
loop) with a stub `sessionQuery`, so it covers what the fake-context unit suite
cannot: the optional `sessionQuery` injection, the search-visibility filter
(including restore on unload), and `/memory toggle` round-tripping through the
real projection. It needs `DSH_CHECKOUT` and skips without it.

The browser-half tests resolve React from a DSH source checkout: export
`DSH_CHECKOUT=/path/to/deepseek-harness` to run them; without it those cases are
skipped.

`node --test tests/` fails on Node 22 with `Cannot find module .../tests` — Node
does not expand a directory argument there, so pass the files.

- `tests/host.test.mjs` — argument grammar, projection folding (success / failure
  / unrelated command / `toggle` replay), tool guard (including MCP resource
  tools, `cache_search`, IM archives, external-agent bridges and configured MCP
  servers), every cross-conversation message kind including the Agent Teams
  mailbox, search-result isolation and its TTL, OpenViking wrapping (seven
  methods), subagent inheritance, pending-queue cleanup including a second OFF,
  `defaultEnabled`, invalid-config fallback and reporting.
- `tests/client.test.mjs` — bundle self-registration, slot contract, fail-closed
  rendering before the projection arrives, and both settled states.
- `tests/host-integration.mts` — the real-host run described above.

## License

MIT — see [LICENSE](LICENSE).
