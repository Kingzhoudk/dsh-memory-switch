/**
 * dsh-memory-switch — browser half.
 *
 * One compact switch in the composer tool row, registered through
 * `conversation.input.left` so it sits beside the other per-conversation mode
 * chips. The switch is a view of the host's log-derived `memorySwitch`
 * projection; clicking it executes `/memory on` / `/memory off`, and the
 * projection frame pushes the new state back. No client-side mode state is
 * kept, so a reload, resume or fork shows the same switch position.
 *
 * The bundle is plain JavaScript: React comes from the browser module table,
 * styles are component-owned CSS using only theme tokens, and no Harness
 * client package is imported.
 */
window.__ModuleLoader__.load({
  id: 'dsh-memory-switch',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'memory-switch'
    const PACKAGE_ID = 'dsh-memory-switch'
    const SWITCH_ID = 'memory-switch'

    const EN = {
      'label': 'Memory',
      'aria.on': 'Memory is on for this conversation; press to turn it off',
      'aria.off': 'Memory is off for this conversation; press to turn it on',
      'title.on': 'Memory ON — this conversation may use history search, cross-conversation references and long-term memory',
      'title.off': 'Memory OFF — this conversation reads and writes no cross-conversation memory',
      'title.busy': 'Switching memory…',
      'title.pending': 'Reading this conversation\'s memory state…',
      'aria.pending': 'Memory state is still loading for this conversation',
      'error.failed': 'Could not switch memory',
      'error.unavailable': 'This conversation cannot run the /memory command',
    }

    const ZH = {
      'label': '记忆',
      'aria.on': '本会话记忆已开启，点击关闭',
      'aria.off': '本会话记忆已关闭，点击开启',
      'title.on': '记忆开启 — 本会话可以使用历史会话检索、跨会话引用与长期记忆',
      'title.off': '记忆关闭 — 本会话不读取也不写入任何跨对话记忆',
      'title.busy': '正在切换记忆…',
      'title.pending': '正在读取本会话的记忆状态…',
      'aria.pending': '本会话记忆状态尚未就绪',
      'error.failed': '切换记忆失败',
      'error.unavailable': '当前会话无法执行 /memory 命令',
    }

    // Component-owned stylesheet; only theme tokens participate so light and
    // dark switching, font scaling and theme overrides keep working.
    const CSS = `
.dsh-memory-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 8px;
  border: none;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  font-weight: 500;
  line-height: 20px;
  white-space: nowrap;
  cursor: pointer;
}
@media (hover: hover) {
  .dsh-memory-toggle:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
}
.dsh-memory-toggle:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dsh-memory-toggle:disabled { cursor: default; opacity: 0.6; }
.dsh-memory-toggle[aria-checked='true'] { color: var(--dsw-alias-brand-primary); }
.dsh-memory-toggle[data-error] { color: var(--dsw-alias-state-error-primary); }
.dsh-memory-label { pointer-events: none; }
.dsh-memory-track {
  box-sizing: border-box;
  position: relative;
  flex: 0 0 auto;
  width: 28px;
  height: 16px;
  padding: 2px;
  border-radius: 999px;
  background: var(--dsw-alias-border-l3);
  transition: background-color 120ms ease;
}
.dsh-memory-toggle[aria-checked='true'] .dsh-memory-track { background: var(--dsw-alias-brand-primary); }
.dsh-memory-thumb {
  display: block;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--dsw-alias-label-primary-foreground);
  transition: transform 120ms ease;
}
.dsh-memory-toggle[aria-checked='false'] .dsh-memory-thumb { background: var(--dsw-alias-switch-thumb); }
.dsh-memory-toggle[aria-checked='true'] .dsh-memory-thumb { transform: translateX(12px); }
@media (prefers-reduced-motion: reduce) {
  .dsh-memory-track, .dsh-memory-thumb { transition: none; }
}
`

    function failureText(t, result) {
      if (result !== undefined && result.ok === false) {
        const error = result.error
        const message = error !== undefined && typeof error.message === 'string' ? error.message : undefined
        const code = error !== undefined && typeof error.code === 'string' ? error.code : undefined
        if (message !== undefined) return code === undefined ? message : `${message} (${code})`
      }
      return t('error.failed')
    }

    /**
     * The command's own outcome, which travels inside a successful remote call.
     * A rejected switch reports `{ kind: 'error', text }` here, so treating
     * `ok: true` as success would hide it.
     */
    function handlerError(result) {
      const outcome = result?.value?.result
      if (outcome === undefined || outcome === null || outcome.kind !== 'error') return undefined
      return typeof outcome.text === 'string' && outcome.text !== '' ? outcome.text : 'error'
    }

    function MemoryToggle(props) {
      const { useProjection, useSession, useAccess, useRemoteAccess, sessionId } = props
      // Every seat is defensive: a throwing component blanks the slot entry, so
      // a missing optional prop degrades the switch instead of the composer.
      const t = typeof props.t === 'function' ? props.t : key => key
      const projection = typeof useProjection === 'function' ? useProjection('memorySwitch') : undefined
      // Fail closed: until the projection frame arrives the switch renders as
      // OFF and cannot be clicked, so a memory-off conversation never shows a
      // misleading "on" (and a privacy indicator never claims more than it has).
      const known = projection !== undefined && projection !== null
      const enabled = known && projection.enabled !== false
      const removed = typeof useSession === 'function' && useSession(snapshot => snapshot.removed) === true
      // The switch runs a slash command, so the gate is `commands/execute`
      // (owner-only in a shared conversation), not `session/prompt`.
      const executeDenied = typeof useRemoteAccess === 'function'
        ? useRemoteAccess('commands/execute') === false
        : typeof useAccess === 'function' && useAccess('commands/execute') === false
      const [pending, setPending] = React.useState(false)
      const [error, setError] = React.useState(null)
      const alive = React.useRef(true)

      React.useEffect(() => {
        alive.current = true
        return () => { alive.current = false }
      }, [])

      React.useEffect(() => {
        setPending(false)
        setError(null)
      }, [sessionId])

      const title = error !== null
        ? `${t('error.failed')}: ${error}`
        : !known ? t('title.pending')
          : pending ? t('title.busy') : t(enabled ? 'title.on' : 'title.off')

      const toggle = () => {
        if (pending || removed || executeDenied || !known) return
        setPending(true)
        setError(null)
        const line = enabled ? '/memory off' : '/memory on'
        // The result only belongs to the conversation it was issued for.
        const target = sessionId
        let request
        try {
          request = ctx.remote.commands.execute(sessionId, line, [])
        } catch (reason) {
          setPending(false)
          setError(reason instanceof Error ? reason.message : String(reason))
          return
        }
        request
          .then((result) => {
            if (!alive.current || target !== sessionId) return
            if (result === undefined) {
              setError(t('error.unavailable'))
              return
            }
            if (result.ok === true && result.value !== undefined) {
              const rejected = handlerError(result)
              if (rejected !== undefined) setError(rejected)
              return
            }
            if (result.ok === true) {
              setError(t('error.unavailable'))
              return
            }
            setError(failureText(t, result))
          }, (reason) => {
            if (!alive.current || target !== sessionId) return
            setError(reason instanceof Error ? reason.message : String(reason))
          })
          .then(() => { if (alive.current && target === sessionId) setPending(false) })
      }

      return h(
        React.Fragment,
        null,
        h('style', { key: 'style', 'data-plugin': PACKAGE_ID }, CSS),
        h(
          'button',
          {
            type: 'button',
            role: 'switch',
            'aria-checked': enabled,
            'aria-label': known ? t(enabled ? 'aria.on' : 'aria.off') : t('aria.pending'),
            'aria-busy': !known || pending ? true : undefined,
            title,
            disabled: pending || removed || executeDenied || !known,
            className: 'dsh-memory-toggle',
            ...(error === null ? {} : { 'data-error': '' }),
            onMouseDown: (event) => { event.preventDefault() },
            onClick: toggle,
          },
          h('span', { className: 'dsh-memory-label', key: 'label' }, t('label')),
          h('span', { className: 'dsh-memory-track', key: 'track' }, h('span', { className: 'dsh-memory-thumb' })),
        ),
      )
    }

    let ctx
    function apply(pluginCtx) {
      ctx = pluginCtx

      pluginCtx.effect(() => pluginCtx.locale.register(NS, 'en', EN), 'memory-switch: English dictionary')
      pluginCtx.effect(() => pluginCtx.locale.register(NS, 'zh', ZH), 'memory-switch: Chinese dictionary')

      pluginCtx.slots.inject('conversation.input.left', () => pluginCtx.slots.register({
        name: 'conversation.input.left',
        id: SWITCH_ID,
        order: 20,
        locale: NS,
      }, MemoryToggle))
    }

    return {
      // `remote.commands` is the mounted Remote namespace service; `remote`
      // carries it through the traceable service proxy.
      inject: ['slots', 'locale', 'remote', 'remote.commands'],
      apply,
    }
  },
})
