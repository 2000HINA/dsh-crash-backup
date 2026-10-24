/**
 * Initialize a backup root: create its internal working directories and write
 * the user-facing README, the backup-root metadata and the index placeholder.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { renderBackupReadme } from './scripts.js'

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`
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
 * Repeat calls are expected: README.txt and settings.json are overwritten so
 * they track the current version/time, while index.json is created only when
 * missing — it lists the user's saves and must never be reset.
 *
 * Note: this `settings.json` is backup-root metadata (version, creation time,
 * root); it is not the plugin's own settings file in `<home>/dsh-crash-backup`.
 */
export async function initializeBackupRoot(root, { version, createdAt } = {}) {
  if (typeof root !== 'string' || !root.trim()) {
    throw new TypeError('initializeBackupRoot requires a non-empty root path')
  }

  const metadata = {
    version: version ?? 'unknown',
    createdAt: createdAt ?? new Date().toISOString(),
    backupRoot: root,
  }

  await mkdir(root, { recursive: true })
  await mkdir(path.join(root, '_pre-restore'), { recursive: true })
  await mkdir(path.join(root, '_restore-logs'), { recursive: true })

  await writeFile(path.join(root, 'README.txt'), renderBackupReadme(metadata), 'utf8')
  await writeFile(path.join(root, 'settings.json'), json(metadata), 'utf8')
  await createIfMissing(path.join(root, 'index.json'), `${JSON.stringify({ saves: [] })}\n`)
}
