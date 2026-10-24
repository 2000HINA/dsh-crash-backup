/**
 * Persistence of the chosen backup root and validation of candidate folders.
 * This module owns every filesystem access; lib/config.js stays path arithmetic
 * and reads persisted choices through `readSavedBackupRoot`.
 */
import path from 'node:path'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { SETTINGS_DIR_NAME } from './constants.js'

const win32 = path.win32

const MESSAGES = {
  empty: '备份目录不能为空',
  'drive-root': '不能使用磁盘根目录作为备份目录',
  'inside-install': '备份目录不能位于 DSH 安装目录内，回档时该位置会被镜像删除',
  'inside-profile': '备份目录不能位于插件 profile 目录内，回档时该位置会被镜像删除',
  'not-writable': '备份目录不可写，请选择其它位置或检查权限',
}

/** `<home>/dsh-crash-backup/settings.json` — the plugin's own data file. */
export function settingsFile(home) {
  return win32.join(home, SETTINGS_DIR_NAME, 'settings.json')
}

/** Previously saved backup root, or `null` when missing, unreadable or malformed. */
export function readSavedBackupRoot(home) {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(home), 'utf8'))
    const saved = parsed?.backupRoot
    return typeof saved === 'string' && saved.trim() ? saved.trim() : null
  } catch {
    return null
  }
}

/** Persist `backupRoot` atomically: write a sibling `.tmp` file, then rename it. */
export async function saveBackupRoot(home, backupRoot) {
  const file = settingsFile(home)
  const temporary = `${file}.tmp`
  await mkdir(win32.dirname(file), { recursive: true })
  try {
    await writeFile(temporary, `${JSON.stringify({ backupRoot }, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

/** True when `candidate` is `base` itself or below it, ignoring case. */
function isInside(candidate, base) {
  if (!base) return false
  const parent = win32.resolve(base).replace(/[\\/]+$/, '').toLowerCase()
  const target = candidate.toLowerCase()
  return target === parent || target.startsWith(parent + win32.sep)
}

/** True for `C:\` and UNC share roots, which must never hold backups. */
function isRoot(resolved) {
  return win32.parse(resolved).root.toLowerCase() === resolved.toLowerCase()
}

function reject(code) {
  return { ok: false, code, message: MESSAGES[code] }
}

/**
 * Validate a candidate backup folder: non-empty, not a drive root, outside the
 * install and profile directories, and actually writable.
 */
export function validateBackupDir(candidate, { installDir, profileDir } = {}) {
  if (typeof candidate !== 'string' || !candidate.trim()) return reject('empty')

  const resolved = win32.resolve(candidate.trim())
  if (isRoot(resolved)) return reject('drive-root')
  if (isInside(resolved, installDir)) return reject('inside-install')
  if (isInside(resolved, profileDir)) return reject('inside-profile')

  try {
    mkdirSync(resolved, { recursive: true })
    const probe = win32.join(resolved, `.dsh-crash-backup-write-test-${process.pid}-${Date.now()}`)
    writeFileSync(probe, '')
    unlinkSync(probe)
  } catch {
    return reject('not-writable')
  }

  return { ok: true }
}
