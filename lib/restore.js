/**
 * Start the standalone restore script in its own console.
 * The restore must outlive this process, so the child is detached, its stdio
 * is ignored and the reference is dropped immediately.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

const win32 = path.win32
const MODES = new Set(['full', 'plugins'])

/** Windows directory, falling back to the usual install location. */
function systemRoot() {
  return process.env.SystemRoot || process.env.windir || 'C:\\Windows'
}

/** Full PowerShell path when present, otherwise let PATH resolve it. */
function powershellExe() {
  const full = win32.join(
    systemRoot(),
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  )
  return existsSync(full) ? full : 'powershell'
}

/**
 * Build the `cmd.exe` invocation that opens a new console and runs the restore
 * script. `start` is a cmd builtin, so the whole start line must be a single
 * `/c` argument; the script path is quoted because it may contain spaces.
 */
export function buildRestoreCommand({ scriptPath, mode } = {}) {
  if (!MODES.has(mode)) {
    throw new TypeError(`mode must be "full" or "plugins", got ${JSON.stringify(mode)}`)
  }
  if (typeof scriptPath !== 'string' || !scriptPath.trim()) {
    throw new TypeError('scriptPath must be a non-empty string')
  }

  const line = [
    'start ""',
    `"${powershellExe()}"`,
    '-NoProfile',
    '-ExecutionPolicy Bypass',
    `-File "${scriptPath}"`,
    '-FromUi',
    `-Mode ${mode}`,
  ].join(' ')

  return {
    file: win32.join(systemRoot(), 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', line],
  }
}

/**
 * Open the restore console and return at once. Spawn failures are ignored:
 * a console that never appears cannot be recovered from here.
 */
export function launchRestore({ scriptPath, cwd, mode }) {
  const { file, args } = buildRestoreCommand({ scriptPath, mode })
  const child = spawn(file, args, {
    cwd,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: true,
  })
  child.on('error', () => {})
  child.unref()
}
