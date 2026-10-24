/**
 * Runtime-environment detection and settings resolution.
 * Path arithmetic uses the win32 dialect so results are stable on any host;
 * the only filesystem read is the persisted backup root, via lib/settings.js.
 */
import os from 'node:os'
import path from 'node:path'
import { MAX_SAVES } from './constants.js'
import { readSavedBackupRoot } from './settings.js'

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
  return win32.join(win32.dirname(installDir), 'dsh-backups')
}

/**
 * Derive every path the Host half needs to locate backups.
 * Priority: explicit `config.backupRoot` > persisted choice > default.
 */
export function resolveSettings({
  config = {},
  env = process.env,
  execPath = process.execPath,
  homedir = os.homedir(),
}) {
  const installDir = detectInstallDir(execPath)
  const home = detectHome(env, homedir)
  const profile = config.profile || 'desktop'
  const override = config.backupRoot
  const saved = readSavedBackupRoot(home)

  return {
    installDir,
    home,
    profile,
    profileDir: win32.join(home, 'profiles', profile),
    backupRoot: win32.resolve(override || saved || defaultBackupRoot(installDir)),
    backupRootSource: override ? 'override' : saved ? 'saved' : 'default',
    maxSaves: MAX_SAVES,
  }
}
