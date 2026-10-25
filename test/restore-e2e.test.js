/**
 * Behavioural test of the generated RESTORE.ps1.
 *
 * It builds a disposable install/home/profile tree, creates a real save with
 * `createBackup`, then runs the generated script with the three path overrides
 * exactly like a rescue invocation would. Two paths are covered:
 *
 *   1. answering `n` at the Y/N prompt exits 0 and touches no restore target;
 *   2. a corrupt manifest exits non-zero with the readable preflight message.
 *
 * The whole file is skipped when Windows PowerShell is unavailable.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBackup } from '../lib/backup.js'
import { RESTORE_LEASE_FILE } from '../lib/restore.js'

const POWERSHELL = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

const SKIP = !existsSync(POWERSHELL) ? 'Windows PowerShell is unavailable' : false

async function assertMissing(target) {
  await assert.rejects(access(target))
}

/** The script must not have taken a pre-restore snapshot (the folder may exist). */
async function assertNoSnapshot(backupRoot) {
  const entries = await readdir(join(backupRoot, '_pre-restore')).catch(() => [])
  assert.deepEqual(entries, [], 'the restore script must not write a pre-restore snapshot')
}

/** Disposable install, home and backup tree with a real generated save. */
async function prepare(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-restore-e2e-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const install = join(root, 'install')
  const home = join(root, 'home')
  const profileDir = join(home, 'profiles', 'desktop')
  await mkdir(install, { recursive: true })
  await mkdir(profileDir, { recursive: true })

  await writeFile(join(install, 'version'), '44.7.0')
  await writeFile(join(install, 'app.js'), 'console.log(1)\n')
  await writeFile(join(profileDir, 'package.json'), '{"name":"desktop"}\n')
  await writeFile(join(profileDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
  await writeFile(join(profileDir, 'cordis.patch.yml'), 'patch: true\n')
  await writeFile(join(home, 'AGENTS.md'), '# user agents\n')
  await writeFile(join(home, 'settings.yaml'), 'theme: dark\n')

  const settings = {
    installDir: install,
    home,
    profile: 'desktop',
    profileDir,
    backupRoot: join(root, 'backups'),
    backupRootSource: 'default',
    maxSaves: 3,
  }
  const manifest = await createBackup(settings)
  const saveDir = join(settings.backupRoot, manifest.id)
  return {
    root,
    install,
    home,
    profileDir,
    backupRoot: settings.backupRoot,
    saveDir,
    ps1: join(saveDir, 'RESTORE.ps1'),
  }
}

/** Run the standalone script the way a rescue session would. */
function runRestore(env, { input, mode = 'full' }) {
  return spawnSync(
    POWERSHELL,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      env.ps1,
      '-Mode',
      mode,
      '-InstallDirOverride',
      env.install,
      '-UserDshOverride',
      env.home,
      '-BackupRootOverride',
      env.backupRoot,
    ],
    {
      input,
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true,
    },
  )
}

/** Newest restore log; the script always writes one before touching targets. */
async function readRestoreLog(backupRoot) {
  const dir = join(backupRoot, '_restore-logs')
  const names = (await readdir(dir).catch(() => [])).sort()
  assert.ok(names.length > 0, 'the restore script must write a log')
  return readFile(join(dir, names.at(-1)), 'utf8')
}

async function snapshotTargets(env) {
  return {
    version: await readFile(join(env.install, 'version'), 'utf8'),
    app: await readFile(join(env.install, 'app.js'), 'utf8'),
    packageJson: await readFile(join(env.profileDir, 'package.json'), 'utf8'),
    lockfile: await readFile(join(env.profileDir, 'pnpm-lock.yaml'), 'utf8'),
    agents: await readFile(join(env.home, 'AGENTS.md'), 'utf8'),
    settingsYaml: await readFile(join(env.home, 'settings.yaml'), 'utf8'),
  }
}

test(
  'RESTORE.ps1 cancels without touching targets and fails readable on a corrupt manifest',
  { skip: SKIP, timeout: 180_000 },
  async (t) => {
    const env = await prepare(t)
    const before = await snapshotTargets(env)

    // 1. Answer `n` at the Y/N prompt: exit 0, nothing restored.
    const canceled = runRestore(env, { input: 'n\n' })
    assert.equal(
      canceled.status,
      0,
      `cancel must exit 0\nstdout:\n${canceled.stdout}\nstderr:\n${canceled.stderr}`,
    )
    assert.deepEqual(await snapshotTargets(env), before, 'cancel must not modify any target')
    await assertNoSnapshot(env.backupRoot)
    await assertMissing(join(env.backupRoot, RESTORE_LEASE_FILE))
    assert.match(await readRestoreLog(env.backupRoot), /用户取消回档/)

    // 2. Confirm `y`, then hit the manifest preflight with invalid JSON:
    //    non-zero exit, readable message, still no target writes.
    await writeFile(join(env.saveDir, 'manifest.json'), '{ not json')

    const corrupt = runRestore(env, { input: 'y\n' })
    assert.notEqual(
      corrupt.status,
      0,
      `a corrupt manifest must exit non-zero\nstdout:\n${corrupt.stdout}\nstderr:\n${corrupt.stderr}`,
    )
    assert.deepEqual(await snapshotTargets(env), before, 'a corrupt manifest must not modify any target')
    await assertMissing(join(env.backupRoot, RESTORE_LEASE_FILE))

    const log = await readRestoreLog(env.backupRoot)
    assert.match(log, /无法解析 manifest\.json/, 'the preflight message must be readable in the log')
    assert.match(log, /回档失败/)
  },
)

test(
  'full restore mirrors install/profile and keeps extra home files',
  { skip: SKIP, timeout: 180_000 },
  async (t) => {
    const env = await prepare(t)
    await writeFile(join(env.install, 'version'), '99.0.0-changed')
    await writeFile(join(env.profileDir, 'package.json'), '{"name":"changed","x":1}\n')
    await mkdir(join(env.install, 'extra'), { recursive: true })
    await writeFile(join(env.install, 'extra', 'leftover.txt'), 'remove me')
    await writeFile(join(env.home, 'keep.txt'), 'keep me')

    const result = runRestore(env, { input: 'y\n' })
    assert.equal(
      result.status,
      0,
      `full restore must succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    assert.equal(await readFile(join(env.install, 'version'), 'utf8'), '44.7.0')
    assert.equal(
      await readFile(join(env.profileDir, 'package.json'), 'utf8'),
      '{"name":"desktop"}\n',
    )
    await assertMissing(join(env.install, 'extra'))
    assert.equal(await readFile(join(env.home, 'keep.txt'), 'utf8'), 'keep me')
    const snapshots = await readdir(join(env.backupRoot, '_pre-restore')).catch(() => [])
    assert.ok(snapshots.length > 0, 'full restore must snapshot the current config')
    await assertMissing(join(env.backupRoot, RESTORE_LEASE_FILE))
  },
)

test(
  'plugins-only restore touches only the plugin profile',
  { skip: SKIP, timeout: 180_000 },
  async (t) => {
    const env = await prepare(t)
    await writeFile(join(env.install, 'version'), '99.0.0-changed')
    await writeFile(join(env.home, 'AGENTS.md'), '# changed\n')
    await writeFile(join(env.profileDir, 'package.json'), '{"name":"changed","x":1}\n')

    const result = runRestore(env, { input: 'y\n', mode: 'plugins' })
    assert.equal(
      result.status,
      0,
      `plugins restore must succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
    assert.equal(
      await readFile(join(env.profileDir, 'package.json'), 'utf8'),
      '{"name":"desktop"}\n',
    )
    assert.equal(
      await readFile(join(env.install, 'version'), 'utf8'),
      '99.0.0-changed',
      'plugins mode must not touch the install directory',
    )
    assert.equal(
      await readFile(join(env.home, 'AGENTS.md'), 'utf8'),
      '# changed\n',
      'plugins mode must not touch user data',
    )
    const snapshots = await readdir(join(env.backupRoot, '_pre-restore'))
    assert.ok(snapshots.some((name) => name.endsWith('-plugins')))
    await assertMissing(join(env.backupRoot, RESTORE_LEASE_FILE))
  },
)
