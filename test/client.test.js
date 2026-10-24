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
  // The confirm dialog listens for Escape through `window`; no-ops suffice for
  // structural rendering.
  addEventListener() {},
  removeEventListener() {},
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

const SAVE = {
  id: 'dsh-save-20261024-090000',
  createdAt: '2026-10-24T09:00:00.000Z',
  dshVersion: '44.7.0',
  pluginCount: 1,
  sizeBytes: 1024,
}

function statusWith(save) {
  return {
    maxSaves: 3,
    backupRoot: 'C:\\dsh-backups',
    profile: 'desktop',
    saves: save ? [save] : [],
    busy: false,
    job: null,
  }
}

/** Mount the section with one save and open its restore dialog. */
async function openRestoreDialog(t, save) {
  const ui = await mountSection(t, (call, url) => {
    if (url.endsWith('/status')) return jsonResponse(statusWith(save))
    return jsonResponse({ restoring: true, id: save.id, mode: 'full' }, 202)
  })
  const open = ui.harness.nodes.find(
    (node) => node.type === 'button' && node.children[0] === 'restore',
  )
  assert.ok(open, 'the save card has a restore button')
  open.props.onClick()
  await settle()
  return ui
}

function modeRow(ui, value) {
  const radio = ui.harness.nodes.find(
    (node) => node.type === 'input' && node.props?.value === value,
  )
  assert.ok(radio, `the ${value} mode radio is rendered`)
  const label = ui.harness.nodes.find(
    (node) => node.type === 'label' && node.children.includes(radio),
  )
  assert.ok(label, `the ${value} mode row is rendered`)
  return { radio, label }
}

function confirmButton(ui) {
  const button = ui.harness.nodes.find(
    (node) => node.type === 'button' && node.children[0] === 'confirmRestore',
  )
  assert.ok(button, 'the restore dialog has a confirm button')
  return button
}

test('the dictionaries name both restore modes', () => {
  const { ctx, dictionaries } = createFakeCtx()
  loaded[0].factory(() => fakeReact()).apply(ctx)
  const dicts = dictionaries[0].dicts

  assert.equal(dicts.zh.modeFull, '完整回档')
  assert.equal(dicts.zh.modePlugins, '仅回滚插件')
  assert.ok(dicts.zh.modePluginsDesc.includes('插件 profile'))
  assert.ok(dicts.zh.modePluginsUnavailable.includes('缺少插件内容'))
  assert.equal(typeof dicts.en.modeFull, 'string')
  assert.ok(dicts.en.modeFull.length > 0)
  assert.equal(typeof dicts.en.modePlugins, 'string')
  assert.ok(dicts.en.modePlugins.length > 0)
})

test('the settings copy warns about credentials and keeps the old saves', () => {
  const { ctx, dictionaries } = createFakeCtx()
  loaded[0].factory(() => fakeReact()).apply(ctx)
  const dicts = dictionaries[0].dicts

  assert.ok(dicts.zh.credentialWarning.includes('.credentials.yaml'))
  assert.match(dicts.zh.credentialWarning, /请勿|不要/)
  assert.ok(dicts.en.credentialWarning.includes('.credentials.yaml'))
  assert.match(dicts.en.credentialWarning, /share|upload/)
  assert.match(dicts.zh.locationDone, /旧目录/)
  assert.match(dicts.zh.locationDone, /存档/)
  assert.match(dicts.en.locationDone, /old folder/)
})

test('a fallback note, a missing folder and the credential warning are rendered', async (t) => {
  const ui = await mountSection(t, () =>
    jsonResponse({
      ...statusWith(null),
      backupRootSource: 'fallback',
      backupRootNote: '默认目录不可写，已回退',
      backupRootExists: false,
    }),
  )

  assert.ok(
    ui.harness.nodes.some((node) => node.children?.[0] === '默认目录不可写，已回退'),
    'the fallback note from the API is shown',
  )
  assert.ok(
    ui.harness.nodes.some((node) => node.children?.[0] === 'folderMissing'),
    'a missing backup folder is called out',
  )
  assert.ok(
    ui.harness.nodes.some((node) => node.children?.[0] === 'credentialWarning'),
    'the credential warning is visible in the settings section',
  )
})

test('a successful location change announces that the old saves are kept', async (t) => {
  const responses = [
    () => jsonResponse(statusWith(null)),
    () => jsonResponse({ path: 'D:\\New Root' }),
    () => jsonResponse({ backupRoot: 'D:\\New Root' }),
    () => jsonResponse({ ...statusWith(null), backupRoot: 'D:\\New Root' }),
  ]
  const ui = await mountSection(t, (call) => responses[call - 1]())
  const change = ui.harness.nodes.find(
    (node) => node.type === 'button' && node.children[0] === 'changeFolder',
  )
  assert.ok(change, 'change-folder button is rendered')

  change.props.onClick()
  await settle()

  assert.ok(
    ui.harness.nodes.some(
      (node) =>
        node.props?.className?.includes('dcb-banner-ok') && node.children[0] === 'locationDone',
    ),
    'the success notice mentions the old folder after a location change',
  )
  assert.equal(
    ui.calls.filter((call) => call.url.endsWith('/location')).length,
    1,
    'the picked folder is saved exactly once',
  )
})

test('a long-path warning returned by a backup is shown in the section', async (t) => {
  const responses = [
    () => jsonResponse(statusWith(null)),
    () =>
      jsonResponse(
        {
          accepted: true,
          job: { phase: 'starting', percent: 0, startedAt: 't1' },
          warning: 'LongPathsEnabled=0',
        },
        202,
      ),
    () => jsonResponse(statusWith(null)),
  ]
  const ui = await mountSection(t, (call) => responses[call - 1]())
  const backup = ui.harness.nodes.find(
    (node) => node.type === 'button' && node.props?.className.includes('dcb-btn-primary'),
  )
  assert.ok(backup, 'backup button is rendered')

  backup.props.onClick()
  await settle()

  assert.ok(
    ui.harness.nodes.some((node) => node.children?.[0] === 'LongPathsEnabled=0'),
    'the advisory warning is visible',
  )
})

test('plugins mode is disabled with a reason when the save has no profile', async (t) => {
  const ui = await openRestoreDialog(t, { ...SAVE, hasProfile: false })

  const full = modeRow(ui, 'full')
  assert.equal(full.radio.props.disabled, false, 'full restore is always available')
  assert.equal(full.radio.props.checked, true, 'full restore is the default')

  const plugins = modeRow(ui, 'plugins')
  assert.equal(plugins.radio.props.disabled, true, 'plugins mode is disabled')
  assert.ok(
    plugins.label.props.className.includes('dcb-mode-disabled'),
    'the disabled row is marked in the UI',
  )
  const description = plugins.label.children[1].children[1]
  assert.equal(
    description.children[0],
    'modePluginsUnavailable',
    'the disabled row shows the reason instead of the scope description',
  )
  assert.equal(confirmButton(ui).props.disabled, false, 'the default mode is still submittable')

  // A disabled mode cannot be picked through the UI, but a stale selection must
  // never let its restore launch either.
  plugins.radio.props.onChange()
  await settle()
  assert.equal(modeRow(ui, 'plugins').radio.props.checked, true)
  assert.equal(confirmButton(ui).props.disabled, true, 'confirm follows the selected mode')
  confirmButton(ui).props.onClick()
  await settle()
  assert.equal(
    ui.calls.filter((call) => call.url.endsWith('/restore')).length,
    0,
    'an unavailable mode never posts /restore',
  )
})

test('confirm posts the selected restore mode', async (t) => {
  const ui = await openRestoreDialog(t, { ...SAVE, hasProfile: true })

  const plugins = modeRow(ui, 'plugins')
  assert.equal(plugins.radio.props.disabled, false, 'plugins mode is available')
  assert.equal(plugins.radio.props.checked, false)
  assert.equal(confirmButton(ui).props.disabled, false)

  plugins.radio.props.onChange()
  await settle()
  const selected = modeRow(ui, 'plugins')
  assert.equal(selected.radio.props.checked, true, 'plugins becomes the selected mode')
  assert.ok(selected.label.props.className.includes('dcb-mode-selected'))

  confirmButton(ui).props.onClick()
  await settle()

  const restore = ui.calls.filter((call) => call.url.endsWith('/restore')).at(-1)
  assert.ok(restore, 'confirm posts /restore')
  assert.deepEqual(JSON.parse(restore.init.body), { id: SAVE.id, mode: 'plugins' })

  // Reopening the dialog defaults back to a full restore.
  const reopen = ui.harness.nodes.find(
    (node) => node.type === 'button' && node.children[0] === 'restore',
  )
  reopen.props.onClick()
  await settle()
  assert.equal(modeRow(ui, 'full').radio.props.checked, true, 'reopening resets to full')
  confirmButton(ui).props.onClick()
  await settle()

  const fullRestore = ui.calls.filter((call) => call.url.endsWith('/restore')).at(-1)
  assert.deepEqual(JSON.parse(fullRestore.init.body), { id: SAVE.id, mode: 'full' })
})

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