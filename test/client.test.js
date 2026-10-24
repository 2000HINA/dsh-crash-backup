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
