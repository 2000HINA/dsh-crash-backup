/**
 * Pure runtime-environment detection. No filesystem access.
 * All path arithmetic uses the win32 dialect so results are stable on any host.
 */
import path from 'node:path'
import { MAX_SAVES } from './constants.js'

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
 * `config.backupRoot` is an explicit user choice; otherwise the default applies.
 */
export function resolveSettings({
  config = {},
  env = process.env,
  execPath = process.execPath,
  homedir,
}) {
  const installDir = detectInstallDir(execPath)
  const home = detectHome(env, homedir)
  const profile = config.profile || 'desktop'
  const override = config.backupRoot

  return {
    installDir,
    home,
    profile,
    profileDir: win32.join(home, 'profiles', profile),
    backupRoot: win32.resolve(override || defaultBackupRoot(installDir)),
    backupRootSource: override ? 'override' : 'default',
    maxSaves: MAX_SAVES,
  }
}
