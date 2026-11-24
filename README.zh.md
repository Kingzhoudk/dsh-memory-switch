# 记忆开关 · dsh-memory-switch

每个会话一个**记忆开关**：关掉之后，这个会话不再通过下面「关闭后具体切断什么」表里列出的任何一条已知通道与其它对话交换信息。

> 它是**策略闸门**，不是沙箱：关掉的是插件能看到的那些接缝（工具、注入消息、服务包装）。`bash` / `read` 直接读 `~/.dsh/sessions/` 之类的越权路径需要靠沙箱策略，见「已知边界」。

- 开关在**输入框工具条**里（`conversation.input.left`，权限/计划等模式 chip 旁边），每个会话独立。
- 状态**完全由会话日志推导**：点击开关执行 `/memory on` 或 `/memory off`，宿主把这次命令折叠成 `memorySwitch` 投影再推回界面。重开、恢复（resume）、fork 都自动保持同一状态；fork 会连父会话的状态一起继承。
- 默认**开启**（与现有行为一致），除非 profile 配置了 `defaultEnabled: false`（见「没有输入框的环境」）。

## 关闭后具体切断什么

| 通道 | 处理方式 |
|---|---|
| 会话历史检索工具 `session_search` / `session_event_search` / `session_event_read` / `session_trace` / `session_event_trace` | 单调工具守卫拒绝调用 + 从模型可见工具列表隐藏 |
| 研究页面缓存 `cache_search`（全局 `~/.cache/dsh-free-search/research.db`，与会话无关） | 同上。它会搜到别的会话抓过的网页，因此按跨对话记忆通道处理 |
| 跨会话引用（`@` 引用其它会话的快照，`source.kind = session-reference`） | 在 `agent/pre-step` 外层过滤掉该类消息 |
| 团队中继消息（Agent Teams 的 `source.kind = agent-message`，别的会话 steer 过来的内容） | 同上，默认过滤（`blockTeamRelay: false` 可放行） |
| 团队邮箱投递（`source.kind = team-message`，别的会话写进本会话的持久历史） | 默认过滤（`blockTeamMailbox: false` 可放行） |
| IM 群归档工具 `dsh_im_group_history` / `dsh_im_group_file`（同一群聊里更早的 DSH 会话） | 关闭时守卫拒绝 + 从工具列表隐藏（`blockImHistory: false` 可放行） |
| 外部 agent 桥 `codebuddy_ask`（另起一个本机 agent，它自己就能读会话目录） | 关闭时守卫拒绝 + 隐藏（`blockExternalAgents: false` 可放行） |
| 跨会话全文检索结果里**关于本会话**的条目 | 用同一份持久状态过滤 `sessionQuery.searchSessions` 的结果页，别的会话 `session_search` 搜不到已关闭的会话 |
| 子代理结果回注父会话（`source.kind = subagent-settled`） | 默认**保留**（同一血统）；`blockSubagentSettled: true` 时过滤 |
| 由本会话派生的子代理会话 | 继承「关」状态；父会话不在本进程时，会去读父会话的持久投影，重启后仍然继承 |
| 模型行为 | 注入一段 `memory-switch:policy` 提示，说明本会话记忆已关闭、不要试图绕过 |
| OpenViking MCP 工具 `mcp__openviking__*`；MCP 资源工具（`server=openviking`）；长期记忆召回与 profile 注入；捕获与提交；已排队写入 | 守卫 + 服务包裹（`initialize` / `profileMessage` / `recallMessage` / `capture` / `maybeCommit` / `flush` / `dispose`）。**仅当 `@openviking/dsh-memory-plugin` 已安装并提供 `openvikingMemory` 服务时生效**；未安装时这段是惰性的，其余通道照常 |

默认**不**切断（可按需在配置里打开）：ThoughtDAG 的 `why_check` / `why_file` / `why_find` / `why_recall`（`blockThoughtdag: true`）、OpenViking 提供的技能（`blockOpenVikingSkills: true`）。工作区 `AGENTS.md` 指令与普通技能不算对话记忆，始终保留——它们是项目约定和能力，关掉会让 agent 行为异常。

MCP 记忆服务器按名字声明：`memoryMcpServers`（默认 `['openviking']`）会同时拦下 `mcp__<server>__*` 工具和 `server` 参数指向它的资源工具。Notion 这类文档服务器默认放行——它们是不是「对话记忆」取决于你接了什么；其余用 `denyToolNames` / `denyToolPrefixes` 补充。

## 安装

插件是标准的 DSH profile bundle（宿主半 `lib/index.js` + 浏览器半 `lib/client.js`）。从
GitHub 安装：

```sh
dsh plugin add github:Kingzhoudk/dsh-memory-switch
# 等价的显式 git spec
dsh plugin add git+https://github.com/Kingzhoudk/dsh-memory-switch.git
```

插件管理器会写入 profile 依赖并启用这个 bundle；没有 HMR 时需要重启运行时才能挂载宿主半，
浏览器半在页面刷新后出现。

本地开发可以改成装目录（`dsh plugin add link:/本地路径/dsh-memory-switch`），或手工挂到 profile：

```json
// ~/.dsh/profiles/web/package.json — dependencies
"dsh-memory-switch": "link:/本地路径/dsh-memory-switch"
```

二选一：当作 bundle（把 `"dsh-memory-switch"` 追加到 `dsh.profile.bundles`，重启生效），或直接
挂到 profile 的用户补丁层（`patchReload: live`，立即生效）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: memory-switch
      name: dsh-memory-switch
```

然后在 profile 目录里 `pnpm install`，让 `node_modules/dsh-memory-switch` 能解析到。

## 没有输入框的环境

开关首先是命令，其次才是 Web 界面。只要有命令注册表，`/memory on|off|toggle|status` 在任何环境都可用：Web/桌面输入框、IM 群聊、ACP/SDK 客户端、终端。没有 `conversation.input.left` 这个 slot 的会话同样能控制。

完全没人能先输入命令的场景（`dsh headless` 一次性运行、定时任务）用行配置 `defaultEnabled: false`：每个新会话默认关闭，`/memory on` 仍可恢复。状态由会话日志推导，恢复（resume）的会话保持上次的选择。

## 命令

| 输入 | 行为 |
|---|---|
| `/memory` 或 `/memory status` | 显示本会话当前状态 |
| `/memory off` | 本会话关闭跨对话记忆（立即生效；模型侧从下一步起不再看到相关工具） |
| `/memory on` | 恢复 |
| `/memory toggle` | 取反 |

## 配置

```yaml
- id: memory-switch
  name: dsh-memory-switch
  config:
    blockOpenViking: true        # OpenViking 召回/捕获 + 其工具（需已装该插件）
    blockSessionTools: true      # session_search / cache_search 等历史与缓存检索工具
    blockSessionReferences: true # 过滤 @ 跨会话引用快照
    blockTeamRelay: true         # 过滤团队中继消息（agent-message）
    blockSubagentSettled: false  # 过滤子代理结果回注（subagent-settled）
    blockThoughtdag: false       # 是否也禁 why_* 工具（默认否）
    blockOpenVikingSkills: false # 是否也禁 OpenViking 技能
    blockTeamMailbox: true       # 过滤团队邮箱投递（team-message）
    blockImHistory: true         # 拒绝 dsh_im_group_history / dsh_im_group_file
    blockExternalAgents: true    # 拒绝外部 agent 桥（codebuddy_ask）
    hideFromSearch: true         # 本会话不出现在跨会话检索结果里
    defaultEnabled: true         # 设 false：新会话默认关闭
    memoryMcpServers: [openviking] # 视为记忆通道的 MCP 服务器
    denyToolNames: []            # 额外按名字拒绝
    denyToolPrefixes: []         # 额外按前缀拒绝
```

## 已知边界

- **方向性**：关闭的会话「读不到别人」是强制的；「别人搜不到本会话」现在由 `hideFromSearch` 过滤 `searchSessions` 结果页来覆盖。仍有两个缺口：直接拿着会话 id 的 `session_event_search` / `session_event_read` / `session_trace` 仍能打开它；ThoughtDAG 自己读 `~/.dsh/sessions`，插件没有过滤接缝。这两处需要改 `tool-session-query` / `dsh-thoughtdag`。
- **检索过滤的代价**：每个结果都要对一次持久投影（缓存 10 秒），一页结果最多多出「未见过会话数」次 prepared session 读取；在别处被重新打开的会话最多被隐藏这么久。
- **实现依赖**：OpenViking 侧通过包裹其 `openvikingMemory` 服务的方法实现，依赖该插件的方法名（`initialize/profileMessage/recallMessage/capture/maybeCommit/flush/dispose`）。升级该插件后若方法改名，记忆开关对这些通道的拦截会失效（工具守卫不受影响）。本包对这些方法缺失是容忍的（缺哪个就不包哪个）。
- **已发生的注入不可撤回**：关闭发生在某个 step 之后时，之前已经进入本会话历史的召回内容不会从日志里删除；开关只保证此后不再读取/写入。

## 开发与验证

```bash
npm test          # 单测 + 浏览器半，再跑一次真实宿主集成脚本
```

`npm test` 先跑 `node --test tests/host.test.mjs tests/client.test.mjs`，再跑 `node scripts/test.mjs`。集成脚本把插件挂到真实 Harness 宿主（llm、session、投影、系统提示词、工具、命令、agent loop）并配一个桩 `sessionQuery`，覆盖 fake ctx 做不到的部分：可选 `sessionQuery` 注入、检索可见性过滤（含卸载还原）、`/memory toggle` 走真实投影往返。需要 `DSH_CHECKOUT`，没有则跳过。

浏览器半的测试从 DSH 源码 checkout 里解析 React：设置
`DSH_CHECKOUT=/path/to/deepseek-harness` 才会运行，否则这两条用例会被跳过。

`node --test tests/` 在 Node 22 下不展开目录参数，会以 `Cannot find module .../tests` 失败——请按上面的写法传文件。

- `tests/host.test.mjs`：命令参数语法、投影折叠（成功/失败/无关命令/`toggle` 重放）、工具守卫（含 MCP 资源工具、`cache_search`、IM 群归档、外部 agent 桥、可配置 MCP 服务器）、各类跨会话消息过滤（引用 / 团队中继 / 团队邮箱 / 子代理回注）、检索结果隔离与 TTL、OpenViking 七个方法的包裹、子代理继承、待发队列清理（含连续两次关闭）、`defaultEnabled`、非法配置回落与告警。
- `tests/client.test.mjs`：浏览器半 bundle 自注册、slot 注册契约、投影未就绪时的 fail-closed 渲染与两态渲染。
- `tests/host-integration.mts`：上面说的真实宿主集成运行。

## 许可证

MIT，见 [LICENSE](LICENSE)。
