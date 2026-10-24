import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listArchive } from '../lib/archive.js'
import { cleanupOrphans, createBackup, deleteSave, listSaves } from '../lib/backup.js'
import { readIndex } from '../lib/index-file.js'

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
  // One allowlisted home file, one other profile and one runtimes folder so
  // every optional source branch is exercised.
  await writeFile(join(home, 'settings.yaml'), 'theme: dark\n')
  await mkdir(join(home, 'profiles', 'headless'), { recursive: true })
  await writeFile(join(home, 'profiles', 'headless', 'package.json'), '{}')
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
    'home/settings.yaml',
    'runtimes/node/marker.txt',
  ]) {
    assert.ok(entries.includes(required), `archive is missing ${required}`)
  }

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

test('cleanupOrphans removes stale partial and zipless save folders', async (t) => {
  const { settings } = await fakeEnv(t)
  const manifest = await createBackup(settings)

  const partial = join(settings.backupRoot, 'dsh-save-20261024-090000.partial')
  await mkdir(join(partial, 'nested'), { recursive: true })
  await writeFile(join(partial, 'nested', 'leftover.txt'), 'x')
  const zipless = join(settings.backupRoot, 'dsh-save-20261024-080000')
  await mkdir(zipless, { recursive: true })
  await writeFile(join(zipless, 'notes.txt'), 'no archive here')
  // A folder that still has a zip is not an orphan, even if the zip is broken.
  const unreadable = join(settings.backupRoot, 'dsh-save-20261024-070000')
  await mkdir(unreadable, { recursive: true })
  await writeFile(join(unreadable, 'broken.zip'), 'not a zip')

  await cleanupOrphans(settings)

  await assertMissing(partial)
  await assertMissing(zipless)
  assert.deepEqual(await readdir(unreadable), ['broken.zip'])
  // The complete save is kept.
  assert.ok((await readFile(join(settings.backupRoot, manifest.id, `${manifest.id}.zip`))).length > 0)
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
