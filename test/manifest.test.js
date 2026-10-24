import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildManifest,
  readDshVersion,
  readProfilePlugins,
  renderManifestMd,
  scanProfileLinks,
} from '../lib/manifest.js'

async function tempDir(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-manifest-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

function sampleManifest() {
  return buildManifest({
    id: 'dsh-save-20261024-090000',
    createdAt: '2026-10-24T09:00:00.000Z',
    dshVersion: '44.7.0',
    profile: 'desktop',
    installDir: 'C:\\tool\\dsh',
    home: 'C:\\Users\\a\\.dsh',
    backupRoot: 'C:\\tool\\dsh-backups',
    plugins: { dependencies: { 'dsh-ops': '0.3.0' }, bundles: ['dsh-ops'] },
    links: [{ path: 'node_modules/dsh-ops', target: 'C:\\tool\\dsh-ops' }],
    totalBytes: 100,
    contents: { hasInstall: true, hasProfile: true },
  })
}

test('manifest keeps plugin inventory, contents and links', () => {
  const manifest = sampleManifest()

  assert.deepEqual(Object.keys(manifest), [
    'schemaVersion', 'producer', 'id', 'createdAt', 'dshVersion', 'profile',
    'installDir', 'home', 'backupRoot', 'plugins', 'contents', 'links', 'totalBytes',
  ])
  assert.equal(manifest.schemaVersion, 1)
  assert.equal(manifest.producer, 'dsh-crash-backup')
  assert.equal(manifest.id, 'dsh-save-20261024-090000')
  assert.equal(manifest.plugins.dependencies['dsh-ops'], '0.3.0')
  assert.deepEqual(manifest.plugins.bundles, ['dsh-ops'])
  assert.deepEqual(manifest.links, [
    { path: 'node_modules/dsh-ops', target: 'C:\\tool\\dsh-ops' },
  ])
  assert.deepEqual(manifest.contents, {
    hasInstall: true,
    hasProfile: true,
    hasOthers: false,
    hasHome: false,
    hasRuntimes: false,
  })
  assert.equal(manifest.totalBytes, 100)
})

test('manifest defaults the optional inventory fields', () => {
  const manifest = buildManifest({})
  assert.deepEqual(manifest.plugins, { dependencies: {}, bundles: [] })
  assert.deepEqual(manifest.links, [])
  assert.equal(manifest.totalBytes, 0)
  assert.deepEqual(manifest.contents, {
    hasInstall: false,
    hasProfile: false,
    hasOthers: false,
    hasHome: false,
    hasRuntimes: false,
  })
})

test('renderManifestMd mentions time, version, profile, size and plugins', () => {
  const md = renderManifestMd(sampleManifest())
  assert.match(md, /dsh-save-20261024-090000/)
  assert.match(md, /2026-10-24T09:00:00\.000Z/)
  assert.match(md, /44\.7\.0/)
  assert.match(md, /desktop/)
  assert.match(md, /100 B/)
  assert.match(md, /dsh-ops/)
  assert.match(md, /0\.3\.0/)
  assert.match(md, /链接：1/)
})

test('readDshVersion reads the version file and survives a missing install', async (t) => {
  const root = await tempDir(t)
  await writeFile(join(root, 'version'), '44.7.0\r\n')
  assert.equal(await readDshVersion(root), '44.7.0')
  assert.equal(await readDshVersion(join(root, 'missing')), '')
})

test('readProfilePlugins reads dependencies and bundles without throwing', async (t) => {
  const root = await tempDir(t)
  const profile = join(root, 'profile')
  await mkdir(profile, { recursive: true })
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify({
      dependencies: { 'dsh-ops': '0.3.0', 'dsh-save-slots': 'link:C:/tool/MyPlugin' },
      dsh: { profile: { bundles: ['dsh-ops'] } },
    }),
  )

  assert.deepEqual(await readProfilePlugins(profile), {
    dependencies: { 'dsh-ops': '0.3.0', 'dsh-save-slots': 'link:C:/tool/MyPlugin' },
    bundles: ['dsh-ops'],
  })

  await writeFile(join(profile, 'package.json'), '{ not json')
  assert.deepEqual(await readProfilePlugins(profile), { dependencies: {}, bundles: [] })
  assert.deepEqual(await readProfilePlugins(join(root, 'missing')), {
    dependencies: {},
    bundles: [],
  })
})

test('scanProfileLinks reports junctions relative to the profile, never following them', async (t) => {
  const root = await tempDir(t)
  const profile = join(root, 'profile')
  const target = join(root, 'external')
  await mkdir(join(profile, 'node_modules', '@scope'), { recursive: true })
  await mkdir(join(profile, 'node_modules', 'plain'), { recursive: true })
  await mkdir(join(target, 'node_modules'), { recursive: true })
  await writeFile(join(profile, 'node_modules', 'plain', 'index.js'), '// real file')
  await symlink(target, join(profile, 'node_modules', '@scope', 'linked'), 'junction')
  await symlink(target, join(profile, 'node_modules', 'plain', 'nested'), 'junction')
  // A link inside the target would be reported too if the walker followed links.
  await symlink(target, join(target, 'node_modules', 'loop'), 'junction')

  const links = await scanProfileLinks(profile)
  assert.deepEqual(
    links.map((link) => link.path),
    ['node_modules/@scope/linked', 'node_modules/plain/nested'],
  )
  for (const link of links) {
    // Node appends a trailing separator when it creates the junction itself.
    assert.equal(link.target.replace(/[\\/]+$/, ''), target)
  }

  assert.deepEqual(await scanProfileLinks(join(root, 'missing')), [])
})
