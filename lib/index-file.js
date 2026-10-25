/**
 * `index.json` is the save list shown by the UI. It is only a cache: every
 * entry can be rebuilt from the `manifest.json` at the root of each save
 * folder.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SAVE_PREFIX } from './constants.js'

const PRODUCER = 'dsh-crash-backup'

/** Path of the index inside a backup root. */
export function indexFile(root) {
  return path.join(root, 'index.json')
}

/** Read the index; a missing or corrupt file is an empty save list. */
export async function readIndex(root) {
  try {
    const data = JSON.parse(await readFile(indexFile(root), 'utf8'))
    return { saves: Array.isArray(data?.saves) ? data.saves : [] }
  } catch {
    return { saves: [] }
  }
}

/** Replace the index atomically through a sibling `.tmp` file. */
export async function writeIndex(root, saves) {
  const target = indexFile(root)
  const tmp = `${target}.tmp`
  const body = `${JSON.stringify({ saves: Array.isArray(saves) ? saves : [] }, null, 2)}\n`
  await mkdir(root, { recursive: true })
  try {
    await writeFile(tmp, body, 'utf8')
    await rename(tmp, target)
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {})
    throw error
  }
}

/** True when the folder holds a new-format save: payload + root manifest. */
async function saveLooksComplete(dir) {
  try {
    if (!(await stat(path.join(dir, 'payload'))).isDirectory()) return false
    return (await stat(path.join(dir, 'manifest.json'))).isFile()
  } catch {
    return false
  }
}

/** Turn a save manifest into the summary stored in the index. */
function summarize(manifest, folderName) {
  return {
    id: typeof manifest.id === 'string' && manifest.id ? manifest.id : folderName,
    createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
    dshVersion: typeof manifest.dshVersion === 'string' ? manifest.dshVersion : '',
    pluginCount: Object.keys(manifest.plugins?.dependencies ?? {}).length,
    sizeBytes: manifest.totalBytes ?? 0,
    restorable: true,
    hasProfile: Boolean(manifest.contents?.hasProfile),
  }
}

/**
 * Rebuild the index from the save folders: a folder must start with the save
 * prefix, hold `payload/` + `manifest.json`, and its manifest must name this
 * producer. Broken folders are skipped, never fatal.
 */
export async function rebuildIndex(root) {
  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    entries = []
  }

  const saves = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SAVE_PREFIX)) continue
    const dir = path.join(root, entry.name)
    if (!(await saveLooksComplete(dir))) continue
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'))
      if (manifest?.producer !== PRODUCER) continue
      saves.push(summarize(manifest, entry.name))
    } catch {
      // Not a readable manifest: leave it out instead of breaking the list.
    }
  }

  saves.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
  )
  await writeIndex(root, saves)
  return saves
}
