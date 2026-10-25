import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const ROBOCOPY = path.join(
  typeof process.env.SystemRoot === 'string' && process.env.SystemRoot !== ''
    ? process.env.SystemRoot
    : 'C:\\Windows',
  'System32',
  'Robocopy.exe',
)

/**
 * Copy one directory tree into `target` preserving timestamps.
 *
 * `/XJ` excludes junction points: a linked plugin is recorded in the manifest
 * and rebuilt on restore, so its target must never be copied into the save.
 * `target` may already exist; robocopy merges into it without deleting.
 */
export async function copyTree(source, target) {
  if (!fs.existsSync(source)) return false
  await fsp.mkdir(target, { recursive: true })
  await runRobocopy(source, target)
  return true
}

/** Copy one file or directory, keeping the leaf name and the file timestamp. */
export async function copyEntry(source, target) {
  const info = await fsp.lstat(source)
  if (info.isDirectory() && !info.isSymbolicLink()) {
    return copyTree(source, target)
  }
  if (info.isSymbolicLink() || !info.isFile()) return false
  await fsp.mkdir(path.dirname(target), { recursive: true })
  await fsp.copyFile(source, target)
  const stat = await fsp.stat(source)
  await fsp.utimes(target, stat.atime, stat.mtime)
  return true
}

function runRobocopy(source, target) {
  return new Promise((resolve, reject) => {
    const args = [
      source,
      target,
      '/E',
      '/COPY:DAT',
      '/DCOPY:DAT',
      '/XJ',
      '/R:2',
      '/W:1',
      '/NFL',
      '/NDL',
      '/NJH',
      '/NJS',
      '/NP',
    ]
    const child = spawn(ROBOCOPY, args, { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (typeof code === 'number' && code < 8) {
        resolve()
        return
      }
      reject(
        new Error(
          `robocopy 失败（退出码 ${String(code)}）：${source} -> ${target}` +
            (stderr.trim() !== '' ? `：${stderr.trim()}` : ''),
        ),
      )
    })
  })
}
