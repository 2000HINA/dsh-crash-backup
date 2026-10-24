import test from 'node:test'
import assert from 'node:assert/strict'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listArchive } from '../lib/archive.js'
import {
  assertModeSupported,
  classifyRemoveError,
  cleanupOrphans,
  createBackup,
  deleteSave,
  listSaves,
} from '../lib/backup.js'
import { readIndex, writeIndex } from '../lib/index-file.js'

async function fakeEnv(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bak-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  const install = join(root, 'install')
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'desktop')
  await mkdir(install, { recursive: true })
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(install, 'version'), '44.7.0')
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { a: '1.0.0' } }))
  // One allowlisted home file, one runtimes folder and two other profiles so
  // every optional source branch is exercised. `dsh-tui` carries a large
  // `node_modules` that must never be archived.
  await writeFile(join(home, 'settings.yaml'), 'theme: dark\n')
  await mkdir(join(home, 'profiles', 'headless'), { recursive: true })
  await writeFile(join(home, 'profiles', 'headless', 'package.json'), '{}')
  const otherProfile = join(home, 'profiles', 'dsh-tui')
  await mkdir(join(otherProfile, 'node_modules', 'big'), { recursive: true })
  await writeFile(join(otherProfile, 'cordis.patch.yml'), 'patch: true\n')
  await writeFile(join(otherProfile, 'package.json'), JSON.stringify({ dependencies: { tui: '1.0.0' } }))
  await writeFile(join(otherProfile, 'node_modules', 'big', 'index.js'), 'module.exports = 1')
  await mkdir(join(home, 'dsh-runtimes', 'node'), { recursive: true })
  await writeFile(join(home, 'dsh-runtimes', 'node', 'marker.txt'), 'runtime')
  return {
    root,
    settings: {
      installDir: install,
      home,
      profile: 'desktop',
      profileDir,
      backupRoot: join(root, 'dsh-backups'),
      maxSaves: 3,
      backupRootSource: 'default',
    },
  }
}

async function assertMissing(target) {
  await assert.rejects(access(target))
}

test('a successful backup creates exactly zip and restore scripts', async (t) => {
  const { settings } = await fakeEnv(t)
  const stages = []
  const manifest = await createBackup(settings, {
    onProgress: (stage, percent) => stages.push(`${stage}:${percent}`),
  })

  const folder = join(settings.backupRoot, manifest.id)
  assert.deepEqual(
    (await readdir(folder)).sort(),
    [`${manifest.id}.zip`, 'RESTORE.cmd', 'RESTORE.ps1'].sort(),
  )

  const ps1 = await readFile(join(folder, 'RESTORE.ps1'), 'utf8')
  assert.ok(ps1.startsWith('\uFEFF'), 'RESTORE.ps1 must start with a UTF-8 BOM')
  assert.ok(ps1.includes(manifest.id))
  assert.ok((await readFile(join(folder, 'RESTORE.cmd'), 'utf8')).includes('RESTORE.ps1'))

  const entries = await listArchive(join(folder, `${manifest.id}.zip`))
  for (const required of [
    'manifest.json',
    'install/version',
    `profile/${settings.profile}/package.json`,
    'profile/others/headless/package.json',
    'profile/others/dsh-tui/cordis.patch.yml',
    'profile/others/dsh-tui/package.json',
    'home/settings.yaml',
    'runtimes/node/marker.txt',
  ]) {
    assert.ok(entries.includes(required), `archive is missing ${required}`)
  }
  // Other profiles contribute config files only, never node_modules.
  assert.equal(
    entries.some((entry) => entry.startsWith('profile/others/dsh-tui/node_modules/')),
    false,
    'other-profile node_modules must not be archived',
  )
  assert.equal(
    entries.some((entry) => entry.endsWith('pnpm-lock.yaml')),
    false,
    'missing other-profile config files must be skipped',
  )

  assert.deepEqual(manifest.contents, {
    hasInstall: true,
    hasProfile: true,
    hasOthers: true,
    hasHome: true,
    hasRuntimes: true,
  })
  assert.equal(manifest.profile, 'desktop')
  assert.equal(manifest.dshVersion, '44.7.0')
  assert.equal(manifest.plugins.dependencies.a, '1.0.0')
  assert.ok(manifest.totalBytes > 0)

  const index = await readIndex(settings.backupRoot)
  assert.equal(index.saves.length, 1)
  assert.equal(index.saves[0].id, manifest.id)
  assert.equal(index.saves[0].hasProfile, true)
  assert.deepEqual(await listSaves(settings), index.saves)

  assert.deepEqual(
    [...new Set(stages)],
    ['checking:1', 'archive:10', 'scripts:90', 'done:100'],
  )
})

test('a fourth backup is rejected once the save limit is reached', async (t) => {
  const { settings } = await fakeEnv(t)
  const ids = []
  for (let index = 0; index < 3; index += 1) {
    ids.push((await createBackup(settings)).id)
  }
  assert.equal(new Set(ids).size, 3, 'rapid backups must still get unique ids')
  assert.equal((await listSaves(settings)).length, 3)

  await assert.rejects(
    () => createBackup(settings),
    (error) => {
      assert.match(String(error?.message), /limit|最多保存/)
      return true
    },
  )

  const names = (await readdir(settings.backupRoot)).filter((name) => name.startsWith('dsh-save-'))
  assert.deepEqual(names.sort(), ids.sort(), 'the rejected backup must not create a folder')
  assert.equal(names.some((name) => name.endsWith('.partial')), false)
})

test('a stale non-empty index cannot hide saves or bypass the limit', async (t) => {
  const { settings } = await fakeEnv(t)
  const ids = []
  for (let index = 0; index < 3; index += 1) {
    ids.push((await createBackup(settings)).id)
  }
  const saves = (await readIndex(settings.backupRoot)).saves
  assert.equal(saves.length, 3)

  // Simulate a crash between publishing a save and refreshing the index: the
  // folders are complete but the index only knows about the first save.
  await writeIndex(settings.backupRoot, [saves[0]])

  const listed = await listSaves(settings)
  assert.equal(listed.length, 3)
  assert.deepEqual(listed.map((save) => save.id).sort(), ids.sort())
  assert.equal((await readIndex(settings.backupRoot)).saves.length, 3)

  // The cap must count folders, not index entries, even if the index goes
  // stale again after the reconciliation above.
  await writeIndex(settings.backupRoot, [saves[0]])
  await assert.rejects(
    () => createBackup(settings),
    (error) => {
      assert.match(String(error?.message), /limit|最多保存/)
      return true
    },
  )
  assert.equal(
    (await readdir(settings.backupRoot)).filter((name) => name.startsWith('dsh-save-')).length,
    3,
  )
})

test('a failed index update does not fail a published backup', async (t) => {
  const { settings } = await fakeEnv(t)
  // A directory named index.json makes every index write fail with EPERM.
  await mkdir(settings.backupRoot, { recursive: true })
  await mkdir(join(settings.backupRoot, 'index.json'))

  const manifest = await createBackup(settings)

  assert.ok(manifest.id.startsWith('dsh-save-'))
  const names = await readdir(join(settings.backupRoot, manifest.id))
  assert.ok(names.includes(`${manifest.id}.zip`), 'the published save must survive')
  assert.ok(names.includes('RESTORE.ps1'))
})

test('cleanupOrphans removes only stale staging, keeps fresh staging, junctions and zipless folders', async (t) => {
  const { root, settings } = await fakeEnv(t)
  const manifest = await createBackup(settings)

  const stale = join(settings.backupRoot, 'dsh-save-20261024-060000.partial')
  await mkdir(join(stale, 'nested'), { recursive: true })
  await writeFile(join(stale, 'nested', 'leftover.txt'), 'x')
  const old = new Date(Date.now() - 31 * 60 * 1000)
  await utimes(stale, old, old)

  const fresh = join(settings.backupRoot, 'dsh-save-20261024-090000.partial')
  await mkdir(fresh, { recursive: true })
  await writeFile(join(fresh, 'in-flight.txt'), 'still writing')

  // A complete `dsh-save-*` folder without a zip may be an old-format save:
  // it must survive the sweep instead of being deleted as an orphan.
  const zipless = join(settings.backupRoot, 'dsh-save-20261024-080000')
  await mkdir(zipless, { recursive: true })
  await writeFile(join(zipless, 'notes.txt'), 'no archive here')
  // A folder that still has a zip is not an orphan, even if the zip is broken.
  const unreadable = join(settings.backupRoot, 'dsh-save-20261024-070000')
  await mkdir(unreadable, { recursive: true })
  await writeFile(join(unreadable, 'broken.zip'), 'not a zip')

  // A junction named like staging must be skipped: its target is user data.
  const linkTarget = join(root, 'junction-target')
  await mkdir(linkTarget, { recursive: true })
  await writeFile(join(linkTarget, 'keep.txt'), 'precious')
  const link = join(settings.backupRoot, 'dsh-save-20261024-065959.partial')
  await symlink(linkTarget, link, 'junction')

  await cleanupOrphans(settings)

  await assertMissing(stale)
  assert.deepEqual(await readdir(zipless), ['notes.txt'])
  assert.deepEqual(await readdir(fresh), ['in-flight.txt'])
  assert.deepEqual(await readdir(unreadable), ['broken.zip'])
  // The junction and its target are untouched.
  assert.ok((await readFile(join(linkTarget, 'keep.txt'), 'utf8')).includes('precious'))
  assert.ok((await readdir(link)).includes('keep.txt'))
  // The complete save is kept.
  assert.ok((await readFile(join(settings.backupRoot, manifest.id, `${manifest.id}.zip`))).length > 0)
})

test('a legacy payload save survives cleanupOrphans and a new backup', async (t) => {
  const { settings } = await fakeEnv(t)
  // Old `dsh-save-slots` format: `payload/` + `MANIFEST.json`, no zip.
  const legacy = join(settings.backupRoot, 'dsh-save-20260101-000000')
  await mkdir(join(legacy, 'payload'), { recursive: true })
  await writeFile(join(legacy, 'payload', 'version'), '43.0.0')
  await writeFile(join(legacy, 'MANIFEST.json'), JSON.stringify({ format: 'payload' }))

  await cleanupOrphans(settings)
  assert.deepEqual(
    (await readdir(legacy)).sort(),
    ['MANIFEST.json', 'payload'],
    'cleanupOrphans must not delete an old-format save',
  )

  // createBackup sweeps orphans before writing: the legacy save must survive.
  const manifest = await createBackup(settings)
  assert.notEqual(manifest.id, 'dsh-save-20260101-000000')
  assert.deepEqual((await readdir(legacy)).sort(), ['MANIFEST.json', 'payload'])
  assert.equal(await readFile(join(legacy, 'payload', 'version'), 'utf8'), '43.0.0')
  // The legacy folder is not a new-format save and must not be listed.
  assert.deepEqual((await listSaves(settings)).map((save) => save.id), [manifest.id])
})

test('deleteSave removes the folder and its index entry', async (t) => {
  const { settings } = await fakeEnv(t)
  const manifest = await createBackup(settings)
  assert.equal((await readIndex(settings.backupRoot)).saves.length, 1)

  await deleteSave(settings, manifest.id)

  await assertMissing(join(settings.backupRoot, manifest.id))
  assert.deepEqual((await readIndex(settings.backupRoot)).saves, [])
  assert.deepEqual(await listSaves(settings), [])

  await assert.rejects(deleteSave(settings, 'dsh-save-2026102-090000'), /无效/)
  await assert.rejects(deleteSave(settings, '../evil'), /无效/)
  await assert.rejects(deleteSave(settings, 'dsh-save-20261024-090000/../x'), /无效/)
})

test('a backup root inside dsh home or the plugin data dir is rejected', async (t) => {
  const { settings } = await fakeEnv(t)

  await assert.rejects(
    () => createBackup({ ...settings, backupRoot: join(settings.home, 'backups') }),
    /用户目录/,
  )
  await assert.rejects(
    () => createBackup({ ...settings, backupRoot: join(settings.home, 'dsh-crash-backup') }),
    /插件数据目录/,
  )
  assert.deepEqual(await listSaves(settings), [])
})

test('the documented home fallback folder is allowed as a backup root', async (t) => {
  const { settings } = await fakeEnv(t)
  const fallback = { ...settings, backupRoot: join(settings.home, 'dsh-backups') }

  const manifest = await createBackup(fallback)

  assert.ok(manifest.id.startsWith('dsh-save-'))
  assert.deepEqual(
    (await listSaves(fallback)).map((save) => save.id),
    [manifest.id],
  )
})

test('assertModeSupported requires a profile for plugin mode', () => {
  assert.throws(() => assertModeSupported({ hasProfile: false }, 'plugins'), /profile/)
  assert.throws(
    () => assertModeSupported({ contents: { hasProfile: false } }, 'plugins'),
    /profile/,
  )
  assert.doesNotThrow(() => assertModeSupported({ hasProfile: true }, 'plugins'))
  assert.doesNotThrow(() => assertModeSupported({ contents: { hasProfile: true } }, 'plugins'))
  assert.doesNotThrow(() => assertModeSupported({ hasProfile: false }, 'full'))
})

test('classifyRemoveError separates gone, busy and unexpected codes', () => {
  assert.equal(classifyRemoveError('ENOENT'), 'gone')
  for (const code of ['EPERM', 'EBUSY', 'EACCES']) {
    assert.equal(classifyRemoveError(code), 'busy', `${code} must be treated as in use`)
  }
  for (const code of ['EINVAL', 'EISDIR', 'ENOTEMPTY', 'UNKNOWN', undefined, null, '']) {
    assert.equal(classifyRemoveError(code), 'error', `${String(code)} must be surfaced`)
  }
})

test('listSaves reconciles an index that names different folders', async (t) => {
  const { settings } = await fakeEnv(t)
  const manifest = await createBackup(settings)
  // Same entry count as the folder count, but the id matches no folder: a
  // count-only comparison would leave the real save unlisted.
  await writeIndex(settings.backupRoot, [
    {
      id: 'dsh-save-20990101-000000',
      createdAt: '2099-01-01T00:00:00.000Z',
      dshVersion: '0',
      pluginCount: 0,
      sizeBytes: 0,
      restorable: true,
      hasProfile: false,
    },
  ])

  assert.deepEqual((await listSaves(settings)).map((save) => save.id), [manifest.id])
  assert.deepEqual(
    (await readIndex(settings.backupRoot)).saves.map((save) => save.id),
    [manifest.id],
  )
})

test('listSaves ignores zipless folders and tolerates an unwritable index', async (t) => {
  const { settings } = await fakeEnv(t)
  await mkdir(settings.backupRoot, { recursive: true })
  // A damaged leftover without any zip must not count as a save folder.
  await mkdir(join(settings.backupRoot, 'dsh-save-20261024-070000'), { recursive: true })
  // A directory named index.json makes every index rebuild fail with EPERM.
  await mkdir(join(settings.backupRoot, 'index.json'))

  assert.deepEqual(await listSaves(settings), [])
})
