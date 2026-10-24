import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { API_ROUTE } from '../lib/constants.js'

const loaded = []
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition)
    },
  },
}

// `client.js` is a plain module-loader script, not an ES module; stub the
// loader before importing it and invoke the captured factory by hand.
await import('../client.js')

function fakeReact() {
  const noop = () => {}
  return {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, noop],
    useEffect: noop,
    useCallback: (callback) => callback,
    useRef: (value) => ({ current: value }),
  }
}

function createFakeCtx() {
  const dictionaries = []
  const bindings = []
  const injections = []
  const registrations = []
  const ctx = {
    effect(effect) {
      const dispose = effect()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    locale: {
      register(namespace, dicts) {
        dictionaries.push({ namespace, dicts })
        return () => {}
      },
      bind(namespace) {
        bindings.push(namespace)
        return (key) => key
      },
    },
    slots: {
      inject(name, register) {
        injections.push(name)
        return register()
      },
      register(config, component) {
        registrations.push({ config, component })
        return () => {}
      },
    },
  }
  return { ctx, dictionaries, bindings, injections, registrations }
}

test('client entry loads once with the plugin id', () => {
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'dsh-crash-backup')
  assert.equal(typeof loaded[0].factory, 'function')
})

test('apply registers zh/en dictionaries and exactly one settings.section', () => {
  const { ctx, dictionaries, bindings, injections, registrations } = createFakeCtx()
  const plugin = loaded[0].factory((name) => {
    assert.equal(name, 'react')
    return fakeReact()
  })

  assert.deepEqual(plugin.inject, ['slots', 'locale'])
  plugin.apply(ctx)

  assert.equal(dictionaries.length, 1)
  const [{ namespace, dicts }] = dictionaries
  assert.equal(namespace, 'dsh-crash-backup')
  assert.deepEqual(bindings, ['dsh-crash-backup'])
  assert.deepEqual(Object.keys(dicts).sort(), ['en', 'zh'])

  const zhKeys = Object.keys(dicts.zh).sort()
  assert.deepEqual(zhKeys, Object.keys(dicts.en).sort())
  assert.ok(zhKeys.length >= 30, 'dictionary covers the settings page copy')
  for (const key of zhKeys) {
    assert.equal(typeof dicts.zh[key], 'string', `zh.${key}`)
    assert.equal(typeof dicts.en[key], 'string', `en.${key}`)
  }
  assert.equal(dicts.zh.title, '存档')
  assert.equal(dicts.zh.count, '已保存 {count}/{max}')
  assert.equal(
    dicts.zh.crashHint,
    'DSH 崩溃或无法启动时，打开备份目录，双击任一存档里的 RESTORE.cmd 即可回档。',
  )

  assert.deepEqual(injections, ['settings.section'])
  assert.equal(registrations.length, 1)
  const [{ config, component }] = registrations
  assert.equal(config.name, 'settings.section')
  assert.equal(config.id, 'dsh-crash-backup')
  assert.equal(config.locale, 'dsh-crash-backup')
  assert.equal(typeof config.label, 'function')
  assert.equal(typeof component, 'function')
})

test('every client endpoint matches a route registered in index.js', async () => {
  const clientSource = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const indexSource = await readFile(new URL('../index.js', import.meta.url), 'utf8')

  const fromClient = [
    ...new Set(clientSource.match(/\/dsh-crash-backup\/api\/[a-z-]+/g) ?? []),
  ].sort()
  const fromIndex = [
    ...new Set(
      [...indexSource.matchAll(/\$\{API_ROUTE\}([a-z/-]+)/g)].map(
        (match) => `${API_ROUTE}${match[1]}`,
      ),
    ),
  ].sort()

  assert.equal(API_ROUTE, '/dsh-crash-backup/api')
  assert.equal(fromClient.length, 7)
  assert.deepEqual(fromClient, fromIndex)
})

function sameDeps(left, right) {
  if (left === undefined || right === undefined) return left === right
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
  return left.every((value, index) => Object.is(value, right[index]))
}

/**
 * Minimal hook runtime for structural checks: eager function components,
 * synchronous state flushes and captured host elements. Not a DOM renderer.
 */
function createHookHarness() {
  const states = []
  const effects = []
  const callbacks = []
  const refs = []
  let nodes = []
  let component = null
  let hookIndex = 0
  let effectIndex = 0
  let callbackIndex = 0
  let refIndex = 0
  let rendering = false
  let needsRender = false
  let pendingEffects = []

  const React = {
    createElement(type, props, ...children) {
      if (typeof type === 'function') return type({ ...(props ?? {}), children })
      const element = { type, props: props ?? {}, children }
      nodes.push(element)
      return element
    },
    useState(initial) {
      const index = hookIndex
      hookIndex += 1
      if (!(index in states)) {
        states[index] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next) => {
        const value = typeof next === 'function' ? next(states[index]) : next
        if (Object.is(value, states[index])) return
        states[index] = value
        schedule()
      }
      return [states[index], setState]
    },
    useEffect(effect, deps) {
      const index = effectIndex
      effectIndex += 1
      const previous = effects[index]
      if (previous && sameDeps(previous.deps, deps)) return
      pendingEffects.push(() => {
        if (previous?.cleanup) previous.cleanup()
        const cleanup = effect()
        effects[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
      })
    },
    useCallback(callback, deps) {
      const index = callbackIndex
      callbackIndex += 1
      const previous = callbacks[index]
      if (!previous || !sameDeps(previous.deps, deps)) callbacks[index] = { callback, deps }
      return callbacks[index].callback
    },
    useRef(initial) {
      const index = refIndex
      refIndex += 1
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
  }

  function schedule() {
    if (rendering) {
      needsRender = true
      return
    }
    render()
  }

  function render() {
    if (!component) return
    rendering = true
    try {
      do {
        needsRender = false
        hookIndex = 0
        effectIndex = 0
        callbackIndex = 0
        refIndex = 0
        pendingEffects = []
        nodes = []
        component({})
        for (const run of pendingEffects) run()
      } while (needsRender)
    } finally {
      rendering = false
    }
  }

  return {
    React,
    mount(next) {
      component = next
      render()
    },
    get nodes() {
      return nodes
    },
  }
}

async function settle(rounds = 30) {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve()
}

function installBrowserStubs(t, respond) {
  const calls = []
  const intervals = []
  const timeouts = []
  const clearedIntervals = []
  const originals = {
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  }

  globalThis.fetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve().then(() => respond(calls.length, url, init))
  }
  globalThis.setInterval = (fn, ms) => {
    intervals.push({ fn, ms })
    return intervals.length
  }
  globalThis.clearInterval = (id) => {
    clearedIntervals.push(id)
  }
  globalThis.setTimeout = (fn, ms) => {
    timeouts.push({ fn, ms })
    return timeouts.length
  }
  globalThis.clearTimeout = () => {}

  t.after(() => {
    globalThis.fetch = originals.fetch
    globalThis.setInterval = originals.setInterval
    globalThis.clearInterval = originals.clearInterval
    globalThis.setTimeout = originals.setTimeout
    globalThis.clearTimeout = originals.clearTimeout
  })
  return { calls, intervals, timeouts, clearedIntervals }
}

async function mountSection(t, respond) {
  const browser = installBrowserStubs(t, respond)
  const harness = createHookHarness()
  const { ctx, registrations } = createFakeCtx()
  loaded[0].factory(() => harness.React).apply(ctx)
  harness.mount(registrations[0].component)
  await settle()
  return { ...browser, harness }
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('a failed first status read renders a retry control and a 2 s backoff', async (t) => {
  const ui = await mountSection(t, () => {
    throw new Error('offline')
  })

  const retry = ui.harness.nodes.find(
    (node) => node.type === 'button' && node.props?.className === 'dcb-btn dcb-retry',
  )
  assert.ok(retry, 'retry button is rendered while status is null')
  assert.equal(retry.children[0], 'retry')
  assert.ok(ui.timeouts.some((timer) => timer.ms === 2000), 'first backoff is 2 s')

  const before = ui.calls.length
  retry.props.onClick()
  await settle()
  assert.ok(ui.calls.length > before, 'retry calls /status immediately')
})

test('backup keeps polling after a failed refresh and reports completion', async (t) => {
  const save = {
    id: 'dsh-save-20261024-090000',
    createdAt: '2026-10-24T09:00:00.000Z',
    dshVersion: '44.7.0',
    pluginCount: 1,
    sizeBytes: 1024,
  }
  const emptyStatus = {
    maxSaves: 3,
    backupRoot: 'C:\\dsh-backups',
    profile: 'desktop',
    saves: [],
    busy: false,
    job: null,
  }
  const doneStatus = {
    ...emptyStatus,
    saves: [save],
    job: { phase: 'done', percent: 100, startedAt: '2026-10-24T10:00:00.000Z' },
  }
  const responses = [
    () => jsonResponse(emptyStatus),
    () =>
      jsonResponse(
        { accepted: true, job: { phase: 'starting', percent: 0, startedAt: 't1' } },
        202,
      ),
    () => {
      throw new Error('refresh failed')
    },
    () => jsonResponse(doneStatus),
  ]

  const ui = await mountSection(t, (call) => responses[call - 1]())
  const backup = ui.harness.nodes.find(
    (node) => node.type === 'button' && node.props?.className.includes('dcb-btn-primary'),
  )
  assert.ok(backup, 'backup button is rendered')

  backup.props.onClick()
  await settle()

  assert.equal(ui.calls.length, 3)
  assert.equal(ui.intervals.length, 1, 'poll interval starts despite the failed refresh')
  assert.equal(ui.intervals[0].ms, 1200)

  ui.intervals[0].fn()
  await settle()

  assert.ok(
    ui.harness.nodes.some(
      (node) =>
        node.props?.className?.includes('dcb-banner-ok') && node.children[0] === 'backupDone',
    ),
    'completion is reported once a later poll sees the settled job',
  )
  assert.ok(ui.clearedIntervals.length >= 1, 'poll interval stops when the job settles')
})