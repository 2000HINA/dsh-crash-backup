/**
 * Runtime-environment detection, settings resolution and Windows feature
 * probes. Path arithmetic uses the win32 dialect so results are stable on any
 * host; the only filesystem access is the persisted backup root and the
 * default-root writability probe, both via lib/settings.js.
 */
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { BACKUP_DIR_NAME, MAX_SAVES } from './constants.js'
import { isWritableTarget, readSavedBackupRoot } from './settings.js'

const win32 = path.win32

/** Directory holding the executable that runs DSH. */
export function detectInstallDir(execPath) {
  return win32.dirname(execPath)
}

/** DSH home directory: a non-empty DSH_HOME wins, otherwise <homedir>/.dsh. */
export function detectHome(env, homedir) {
  const override = env.DSH_HOME?.trim()
  return override || win32.join(homedir, '.dsh')
}

/** Default backup root: a `dsh-backups` sibling of the install directory. */
export function defaultBackupRoot(installDir) {
  return win32.join(win32.dirname(installDir), BACKUP_DIR_NAME)
}

/** Fallback used when the default root is not writable. */
export function fallbackBackupRoot(home) {
  return win32.join(home, BACKUP_DIR_NAME)
}

/** Read `HKLM\...\FileSystem\LongPathsEnabled`; null when unknown. */
export function readLongPathsEnabled() {
  try {
    const reg = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    const result = spawnSync(
      reg,
      [
        'query',
        'HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem',
        '/v',
        'LongPathsEnabled',
      ],
      { windowsHide: true, encoding: 'utf8' },
    )
    const match = /LongPathsEnabled\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.stdout ?? '')
    return match ? Number.parseInt(match[1], 16) : null
  } catch {
    return null
  }
}

/**
 * Warning for a disabled Windows long-path setting, or '' when it is enabled
 * or unknown. Advisory only: callers log/return it and never fail on it.
 * `readValue` is injectable so the check stays testable without the registry.
 */
export function longPathsWarning(readValue = readLongPathsEnabled) {
  let value
  try {
    value = readValue()
  } catch {
    return ''
  }
  if (value !== 0 && value !== '0') return ''
  return (
    '警告：Windows 长路径支持未启用（LongPathsEnabled=0）。备份或回档包含深层目录时' +
    '可能因路径过长失败；建议把 HKLM\\SYSTEM\\CurrentControlSet\\Control\\FileSystem\\' +
    'LongPathsEnabled 设为 1 并重启后再操作。'
  )
}

/**
 * Derive every path the Host half needs to locate backups.
 * Priority: explicit `config.backupRoot` > persisted choice > default.
 *
 * When the default root cannot be written, `<home>/dsh-backups` is used
 * instead and `backupRootNote` explains the fallback to the settings page.
 * `isWritable` is injectable for tests.
 */
export function resolveSettings({
  config = {},
  env = process.env,
  execPath = process.execPath,
  homedir = os.homedir(),
  isWritable = isWritableTarget,
} = {}) {
  const installDir = detectInstallDir(execPath)
  const home = detectHome(env, homedir)
  const profile = config.profile || 'desktop'
  const override = config.backupRoot
  const saved = readSavedBackupRoot(home)
  const defaultRoot = win32.resolve(defaultBackupRoot(installDir))
  const fallbackRoot = win32.resolve(fallbackBackupRoot(home))

  let backupRoot
  let backupRootSource
  let backupRootNote = ''
  if (override) {
    backupRoot = win32.resolve(override)
    backupRootSource = 'override'
  } else if (saved) {
    backupRoot = win32.resolve(saved)
    backupRootSource = 'saved'
  } else if (isWritable(defaultRoot)) {
    backupRoot = defaultRoot
    backupRootSource = 'default'
  } else {
    backupRoot = fallbackRoot
    backupRootSource = 'fallback'
    backupRootNote = `无法写入默认备份目录 ${defaultRoot}，已改用 ${fallbackRoot}。`
  }

  return {
    installDir,
    home,
    profile,
    profileDir: win32.join(home, 'profiles', profile),
    backupRoot,
    backupRootSource,
    backupRootNote,
    maxSaves: MAX_SAVES,
  }
}
