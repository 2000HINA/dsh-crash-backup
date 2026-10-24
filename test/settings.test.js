import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  settingsFile,
  readSavedBackupRoot,
  saveBackupRoot,
  validateBackupDir,
} from '../lib/settings.js'

const env = { installDir: 'C:\\tool\\dsh', profileDir: 'C:\\Users\\a\\.dsh\\profiles\\desktop' }

async function tempHome() {
  return mkdtemp(join(tmpdir(), 'dsh-settings-'))
}

test('settings file lives in the plugin data directory', () => {
  assert.equal(settingsFile('C:\\Users\\a\\.dsh'), 'C:\\Users\\a\\.dsh\\dsh-crash-backup\\settings.json')
})

test('rejects a folder inside the install dir (case-insensitive)', () => {
  const result = validateBackupDir('c:\\TOOL\\dsh\\backups', env)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'inside-install')
})

test('rejects a folder inside the profile dir (case-insensitive)', () => {
  const result = validateBackupDir('C:\\users\\A\\.DSH\\profiles\\desktop\\saves', env)
  assert.equal(result.ok, false)
  assert.equal(result.code, 'inside-profile')
})

test('rejects the drive root', () => {
  assert.equal(validateBackupDir('C:\\', env).code, 'drive-root')
})

test('rejects UNC network paths as not local', () => {
  for (const candidate of ['\\\\server\\share\\backups', '//server/share/backups']) {
    const result = validateBackupDir(candidate, env)
    assert.equal(result.ok, false, `${candidate} must be rejected`)
    assert.equal(result.code, 'unc')
    assert.match(result.message, /本地/)
    assert.match(result.message, /UNC/)
  }
})

test('rejects an empty candidate', () => {
  assert.equal(validateBackupDir('   ', env).code, 'empty')
  assert.equal(validateBackupDir(undefined, env).code, 'empty')
})

test('accepts a writable temp folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-ok-'))
  assert.deepEqual(validateBackupDir(dir, env), { ok: true })
})

test('a shared name prefix does not count as inside the install dir', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-prefix-'))
  const result = validateBackupDir(join(root, 'dsh2', 'backups'), {
    installDir: join(root, 'dsh'),
    profileDir: join(root, 'home', 'profiles', 'desktop'),
  })
  assert.deepEqual(result, { ok: true })
})

test('reports not-writable when the folder cannot be created', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-blocked-'))
  const blocker = join(root, 'blocker')
  await writeFile(blocker, 'a file, not a directory')
  assert.equal(validateBackupDir(join(blocker, 'nested'), env).code, 'not-writable')
})

test('requires the install and profile safety context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-context-'))
  assert.throws(() => validateBackupDir(dir), /installDir/)
  assert.throws(() => validateBackupDir(dir, { installDir: env.installDir }), /profileDir/)
  assert.throws(
    () => validateBackupDir(dir, { installDir: 42, profileDir: env.profileDir }),
    /installDir/,
  )
  assert.throws(
    () => validateBackupDir(dir, { installDir: env.installDir, profileDir: '   ' }),
    /profileDir/,
  )
})

test('saves and reads the backup root back', async () => {
  const home = await tempHome()
  await saveBackupRoot(home, 'D:\\dsh-backups')
  assert.equal(readSavedBackupRoot(home), 'D:\\dsh-backups')
  assert.deepEqual(await readdir(join(home, 'dsh-crash-backup')), ['settings.json'])
})

test('returns null when nothing was saved yet', async () => {
  assert.equal(readSavedBackupRoot(await tempHome()), null)
})

test('returns null for corrupt JSON', async () => {
  const home = await tempHome()
  await mkdir(join(home, 'dsh-crash-backup'), { recursive: true })
  await writeFile(settingsFile(home), '{ not json')
  assert.equal(readSavedBackupRoot(home), null)
})

test('returns null for a wrong-shaped settings file', async () => {
  const home = await tempHome()
  await mkdir(join(home, 'dsh-crash-backup'), { recursive: true })
  await writeFile(settingsFile(home), JSON.stringify({ backupRoot: 42 }))
  assert.equal(readSavedBackupRoot(home), null)
})
