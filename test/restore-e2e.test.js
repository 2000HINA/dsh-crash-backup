/**
 * Behavioural test of the generated RESTORE.ps1.
 *
 * It builds a disposable install/home/profile tree, creates a real save with
 * `createBackup`, then runs the generated script with the three path overrides
 * exactly like a rescue invocation would. Two paths are covered:
 *
 *   1. answering `n` at the Y/N prompt exits 0 and touches no restore target;
 *   2. a corrupt zip exits non-zero with the readable preflight message.
 *
 * The whole file is skipped when Windows PowerShell or tar.exe is unavailable.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TAR_PATH } from '../lib/archive.js'
import { createBackup } from '../lib/backup.js'
import { RESTORE_LEASE_FILE } from '../lib/restore.js'

const POWERSHELL = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

const SKIP =
  !existsSync(POWERSHELL) || !existsSync(TAR_PATH)
    ? 'Windows PowerShell or tar.exe is unavailable'
    : false

async function assertMissing(target) {
  await assert.rejects(access(target))
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
function runRestore(env, { input }) {
  return spawnSync(
    POWERSHELL,
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      env.ps1,
      '-Mode',
      'full',
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
  'RESTORE.ps1 cancels without touching targets and fails readable on a corrupt zip',
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
    await assertMissing(join(env.backupRoot, '_pre-restore'))
    await assertMissing(join(env.backupRoot, RESTORE_LEASE_FILE))
    assert.match(await readRestoreLog(env.backupRoot), /用户取消回档/)

    // 2. Confirm `y`, then hit the archive preflight with a corrupt zip:
    //    non-zero exit, readable message, still no target writes.
    const zips = (await readdir(env.saveDir)).filter((name) => name.toLowerCase().endsWith('.zip'))
    assert.equal(zips.length, 1, 'the save carries exactly one zip')
    await writeFile(join(env.saveDir, zips[0]), 'this is not a zip archive')

    const corrupt = runRestore(env, { input: 'y\n' })
    assert.notEqual(
      corrupt.status,
      0,
      `a corrupt zip must exit non-zero\nstdout:\n${corrupt.stdout}\nstderr:\n${corrupt.stderr}`,
    )
    assert.deepEqual(await snapshotTargets(env), before, 'a corrupt zip must not modify any target')
    await assertMissing(join(env.backupRoot, '_pre-restore'))
    await assertMissing(join(env.backupRoot, RESTORE_LEASE_FILE))

    const log = await readRestoreLog(env.backupRoot)
    assert.match(log, /无法读取存档压缩包/, 'the preflight message must be readable in the log')
    assert.match(log, /回档失败/)
  },
)
