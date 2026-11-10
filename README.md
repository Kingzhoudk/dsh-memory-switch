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
- Default: **on**, matching today's behaviour.

## What OFF cuts

| Channel | Enforcement |
|---|---|
| `session_search`, `session_event_search`, `session_event_read`, `session_trace`, `session_event_trace` | Monotonic tool guard denies the call; a per-agent restriction hides them from the model |
| `cache_search` (research page cache in `~/.cache/dsh-free-search/research.db`, shared across conversations) | same — it can return pages another conversation fetched |
| Cross-conversation references (`@`-mentioned session snapshots) | filtered out of the prepared step (`source.kind = session-reference`) |
| Team relay messages (Agent Teams `source.kind = agent-message`) | filtered by default; `blockTeamRelay: false` lets them through |
| Subagent results re-injected into the parent (`source.kind = subagent-settled`) | **kept** by default (same lineage); `blockSubagentSettled: true` filters them |
| Subagent conversations spawned by this one | inherit OFF, including after a restart (the parent's durable projection is consulted when the parent is not live) |
| Model behaviour | a `memory-switch:policy` prompt section explains that memory is off and not to work around it |
| OpenViking tools, MCP resources, recall, capture, commits, queued writes | guard plus wrapped `openvikingMemory` service (`initialize` / `profileMessage` / `recallMessage` / `capture` / `maybeCommit` / `flush` / `dispose`). **Only when `@openviking/dsh-memory-plugin` is installed**; otherwise this whole section is inert and every other channel still applies |

Left on by default (configurable): ThoughtDAG `why_*` tools
(`blockThoughtdag: true`) and OpenViking-provided skills
(`blockOpenVikingSkills: true`). Workspace `AGENTS.md` instructions and ordinary
skills are not conversation memory and always stay available.

Other MCP memory servers (for example `mcp__notion__*`) are not blocked by
default: whether they count as conversation memory depends on what you wired up,
so declare them with `denyToolNames` / `denyToolPrefixes`.

## Install

A standard DSH profile bundle: host half `lib/index.js`, browser half
`lib/client.js` (`dsh.client`).

```json
// ~/.dsh/profiles/web/package.json — dependencies
"dsh-memory-switch": "link:/home/dk/workspace/dsh-memory-switch"
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
    denyToolNames: []
    denyToolPrefixes: []
```

## Known limits

- **Direction**: an OFF conversation is strongly prevented from reading other
  conversations, but the reverse — other conversations' searches not finding
  it — is not achievable in this plugin: the session-query SQLite index and the
  ThoughtDAG index have no per-session exclusion seam (`dsh-thoughtdag` reads
  `~/.dsh/sessions` directly). Symmetric isolation needs a change in those
  packages.
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
npm test          # same as node --test tests/host.test.mjs tests/client.test.mjs
```

`node --test tests/` fails on Node 22 with `Cannot find module .../tests` — Node
does not expand a directory argument there, so pass the files.

- `tests/host.test.mjs` — argument grammar, projection folding (success / failure
  / unrelated command), tool guard (including MCP resource tools and
  `cache_search`), every cross-conversation message kind, OpenViking wrapping
  (seven methods), subagent inheritance, pending-queue cleanup including a second
  OFF, invalid-config fallback and reporting.
- `tests/client.test.mjs` — bundle self-registration, slot contract, fail-closed
  rendering before the projection arrives, and both settled states.
