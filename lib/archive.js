/**
 * Small filesystem helpers shared by the backup code. Archive creation and
 * extraction were removed when saves switched to directory copies.
 */
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Recursive byte count. Symlinks and junctions are skipped, never followed,
 * and unreadable entries are ignored.
 */
export async function dirSize(dir) {
  const root = await lstat(dir).catch(() => null)
  if (!root || root.isSymbolicLink()) return 0

  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    try {
      const info = await lstat(full)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) total += await dirSize(full)
      else if (info.isFile()) total += info.size
    } catch {
      // Unreadable entry: leave it out of the total instead of failing.
    }
  }
  return total
}
