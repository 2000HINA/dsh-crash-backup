/**
 * Initialize a backup root: refuse foreign folders, then create its internal
 * working directories and the user-facing files.
 *
 * A folder is only recognized as a backup root when it carries the marker file
 * `.dsh-crash-backup.json`. Without the marker a non-empty folder is treated as
 * someone else's data and is never written to, so picking an arbitrary folder
 * in the settings page cannot destroy user files. Every file is created with
 * the exclusive `wx` flag: an existing README/settings/index is left untouched.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { renderBackupReadme } from './scripts.js'

/** Marker that proves a folder was created by this plugin. */
export const BACKUP_ROOT_MARKER = '.dsh-crash-backup.json'

const MARKER_CONTENT = { producer: 'dsh-crash-backup', schemaVersion: 1 }

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

/** Error for a non-empty folder that carries no backup-root marker. */
function notOurs(root) {
  const error = new Error(
    `所选文件夹不是空的，也不是 dsh-crash-backup 的备份目录：${root}。` +
      '为避免覆盖其中的文件，请选择一个空文件夹作为备份目录',
  )
  error.code = 'E_NOT_OURS'
  return error
}

/** True when `root` carries a readable marker written by this plugin. */
async function hasMarker(root) {
  try {
    const data = JSON.parse(await readFile(path.join(root, BACKUP_ROOT_MARKER), 'utf8'))
    return data?.producer === MARKER_CONTENT.producer
  } catch {
    return false
  }
}

/** Create `file` only when absent; an existing file is never touched. */
async function createIfMissing(file, contents) {
  try {
    await writeFile(file, contents, { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
}

/**
 * Create the layout and files of a backup root.
 *
 * Repeat calls are expected and safe: a folder carrying this plugin's marker
 * is accepted and every file is created only when missing, so README.txt,
 * settings.json and index.json are never overwritten. A non-empty folder
 * without the marker throws an error with `code: 'E_NOT_OURS'`.
 *
 * Note: this `settings.json` is backup-root metadata (version, creation time,
 * root); it is not the plugin's own settings file in `<home>/dsh-crash-backup`.
 */
export async function initializeBackupRoot(root, { version, createdAt } = {}) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new TypeError('initializeBackupRoot requires a non-empty root path')
  }

  await mkdir(root, { recursive: true })
  const entries = await readdir(root)
  if (entries.length > 0 && !(await hasMarker(root))) throw notOurs(root)

  // Creates the marker on a new/empty folder; an existing marker is kept.
  await createIfMissing(path.join(root, BACKUP_ROOT_MARKER), json(MARKER_CONTENT))
  await mkdir(path.join(root, '_pre-restore'), { recursive: true })
  await mkdir(path.join(root, '_restore-logs'), { recursive: true })

  const metadata = {
    version: version ?? 'unknown',
    createdAt: createdAt ?? new Date().toISOString(),
    backupRoot: root,
  }
  await createIfMissing(path.join(root, 'README.txt'), renderBackupReadme(metadata))
  await createIfMissing(path.join(root, 'settings.json'), json(metadata))
  await createIfMissing(path.join(root, 'index.json'), `${JSON.stringify({ saves: [] })}\n`)
}
