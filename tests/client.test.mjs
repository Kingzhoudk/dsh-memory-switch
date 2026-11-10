/**
 * Browser-half smoke test: the bundle registers the composer switch with the
 * host's slot contract and renders both states.
 *
 * The bundle is plain JavaScript built for the browser module table, so the
 * test supplies that table's `load` hook and a `require` stub for the only
 * external it uses (`react`). React is resolved from the DSH checkout this
 * plugin is developed against; without it the suite skips instead of failing.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const REPO = process.env.DSH_CHECKOUT ?? '/home/dk/study/deepseek-harness'
let React
let renderToStaticMarkup
try {
  const repoRequire = createRequire(`${REPO}/packages/client/ui-goal/package.json`)
  React = repoRequire('react')
  renderToStaticMarkup = repoRequire('react-dom/server').renderToStaticMarkup
} catch {
  React = undefined
}

const skip = React === undefined ? 'react from the DSH checkout is unavailable' : false

/** Load the bundle once and return its captured factory result. */
let bundlePromise
function loadBundle() {
  bundlePromise ??= loadBundleOnce()
  return bundlePromise
}

async function loadBundleOnce() {
  let captured
  globalThis.window = {
    __ModuleLoader__: {
      load(entry) { captured = entry },
    },
  }
  await import('../lib/client.js')
  assert.ok(captured, 'bundle registered itself with the module loader')
  assert.equal(captured.id, 'dsh-memory-switch')
  const repoRequire = createRequire(`${REPO}/packages/client/ui-goal/package.json`)
  return captured.factory(repoRequire)
}

/** Minimal client plugin context capturing slot and locale registration. */
function pluginCtx(overrides = {}) {
  const slots = []
  const dictionaries = []
  const calls = []
  const ctx = {
    effect(fn) { fn(); return () => {} },
    locale: {
      register(namespace, language, dictionary) { dictionaries.push({ namespace, language, dictionary }) },
    },
    slots: {
      inject(name, register) { register() },
      register(definition, component) {
        slots.push({ definition, component })
        return () => {}
      },
    },
    remote: {
      commands: {
        async execute(...args) { calls.push(args); return { ok: true, value: {} } },
      },
    },
    on() {},
    ...overrides,
  }
  return { ctx, slots, dictionaries, calls }
}

test('the bundle registers one composer switch on conversation.input.left', { skip }, async () => {
  const plugin = await loadBundle()
  const { ctx, slots, dictionaries } = pluginCtx()

  assert.equal(typeof plugin.apply, 'function')
  for (const name of plugin.inject) assert.equal(typeof ctx[name.split('.')[0]], 'object')
  plugin.apply(ctx)

  assert.equal(slots.length, 1)
  const [{ definition, component }] = slots
  assert.equal(definition.name, 'conversation.input.left')
  assert.equal(definition.id, 'memory-switch')
  assert.equal(definition.locale, 'memory-switch')
  assert.equal(typeof component, 'function')
  assert.deepEqual(dictionaries.map(entry => entry.language).sort(), ['en', 'zh'])
  const labels = dictionaries.map(entry => entry.dictionary.label)
  assert.deepEqual(labels.sort(), ['Memory', '记忆'])
})

test('the switch fails closed until the projection arrives, then follows it', { skip }, async () => {
  const plugin = await loadBundle()
  const { ctx, slots } = pluginCtx()
  plugin.apply(ctx)
  const component = slots[0].component

  const base = {
    sessionId: 'session-1',
    useAccess: () => true,
    useSession: () => false,
    t: key => key,
  }

  // No frame yet: render OFF and refuse clicks instead of claiming "on".
  const unknown = renderToStaticMarkup(React.createElement(component, {
    ...base,
    useProjection: () => undefined,
  }))
  assert.match(unknown, /role="switch"/)
  assert.match(unknown, /aria-checked="false"/)
  assert.match(unknown, /disabled=""/)
  assert.match(unknown, /aria-busy="true"/)
  assert.match(unknown, /dsh-memory-toggle/)

  const on = renderToStaticMarkup(React.createElement(component, {
    ...base,
    useProjection: () => ({ enabled: true }),
  }))
  assert.match(on, /aria-checked="true"/)
  assert.doesNotMatch(on, /disabled=""/)

  const off = renderToStaticMarkup(React.createElement(component, {
    ...base,
    useProjection: () => ({ enabled: false }),
  }))
  assert.match(off, /aria-checked="false"/)
  assert.doesNotMatch(off, /disabled=""/)
})
