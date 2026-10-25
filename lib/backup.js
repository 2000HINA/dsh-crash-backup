/**
 * Backup lifecycle: create a save folder (payload copy + restore scripts),
 * list the saves, delete one and clean up stale staging left by interrupted
 * backups.
 *
 * A save is assembled in `<backupRoot>/<id>.partial` and only renamed to
 * `<id>` once the payload copy and both restore scripts are complete, so a
 * folder whose name ends in `.partial` is the only kind of leftover assembly;
 * every other `dsh-save-*` folder is either a complete save or an old-format
 * save this plugin leaves untouched.
 */
import {
  access,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { dirSize } from './archive.js'
import { longPathsWarning } from './config.js'
import { copyEntry } from './copy.js'
import { BACKUP_DIR_NAME, MAX_SAVES, SAVE_PREFIX, SETTINGS_DIR_NAME } from './constants.js'
import { readIndex, rebuildIndex } from './index-file.js'
import { initializeBackupRoot } from './location.js'
import { buildManifest, readDshVersion, readProfilePlugins, scanProfileLinks } from './manifest.js'
import { renderRestoreCmd, renderRestorePs1, restoreScriptNames } from './scripts.js'
import { validateBackupDir } from './settings.js'

const BOM = '\uFEFF'
const MIN_FREE_BYTES = 2 * 1024 ** 3
const SAVE_ID_PATTERN = /^dsh-save-\d{8}-\d{6}(-\d+)?$/
const RENAME_ATTEMPTS = 8
const DELETE_ATTEMPTS = 6
/** A `.partial` folder younger than this may belong to a backup still writing. */
const STALE_PARTIAL_MS = 30 * 60 * 1000
/** Removal failures that mean the folder is still held by another process. */
const BUSY_REMOVE_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Classify an `fs.rm` failure code: `'gone'` when the folder no longer exists,
 * `'busy'` when another process still holds it, `'error'` for anything
 * unexpected. Exported so the classifier itself is covered by tests.
 */
export function classifyRemoveError(code) {
  if (code === 'ENOENT') return 'gone'
  if (BUSY_REMOVE_CODES.has(code)) return 'busy'
  return 'error'
}

/**
 * Reject a restore mode the save cannot support. `save` may be an index
 * summary (`hasProfile` at the top level) or an archive manifest
 * (`contents.hasProfile`), so both shapes are accepted.
 */
export function assertModeSupported(save, mode) {
  if (mode !== 'plugins') return
  const hasProfile = save?.hasProfile === true || save?.contents?.hasProfile === true
  if (!hasProfile) {
    throw new Error('存档不包含插件 profile，无法仅回滚插件')
  }
}

/**
 * Files archived for the other profiles (`dsh-tui`, `headless`). Only their
 * configuration is restorable; their `node_modules` is deliberately excluded.
 */
const OTHER_PROFILE_FILES = [
  'cordis.patch.yml',
  'cordis.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
]

/**
 * Files and folders copied from the DSH home. `profiles`, `sessions`,
 * `attachments` and `cache` are deliberately absent: profiles are archived as
 * their own sources and the other three are large or transient.
 */
const HOME_ITEMS = [
  'AGENTS.md',
  'cordis.patch.yml',
  'settings.yaml',
  '.credentials.yaml',
  'skills',
  'storages',
  'pet.json',
  'skin-center',
  'skin-center-active.json',
  'task-board',
  'whale-audio',
  'whale-roles',
  'dsh-usage',
  'llm-deepseek',
  'remote-web-ui-devices.json',
  '.agent-presets',
]

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Normalized, case-folded path used only for containment comparisons. */
function comparable(value) {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}

/** True when `candidate` is `base` itself or below it, ignoring case. */
function isInside(candidate, base) {
  const parent = comparable(base)
  const target = comparable(candidate)
  return target === parent || target.startsWith(`${parent}${path.sep}`)
}

/** True for an existing path; never throws. */
async function pathExists(target) {
  try {
    await access(target)
    return true
  } catch {
    return false
  }
}

/** True for an existing regular file; never throws. */
async function pathIsFile(target) {
  try {
    return (await stat(target)).isFile()
  } catch {
    return false
  }
}

/** Fail with a readable message when a required directory is missing. */
async function assertDirectory(dir, label) {
  let info = null
  try {
    info = await stat(dir)
  } catch {
    info = null
  }
  if (!info || !info.isDirectory()) {
    throw new Error(`${label}不存在或不是文件夹：${dir}。请确认 DSH 安装完整后再备份`)
  }
}

/** Reject when the backup volume has less than 2 GiB free; advisory without statfs. */
async function assertFreeSpace(dir) {
  let stats
  try {
    stats = await statfs(dir)
  } catch {
    // The archive writer reports the real error; a missing statfs is not fatal.
    return
  }
  const free = Number(stats?.bavail) * Number(stats?.bsize)
  if (!Number.isFinite(free)) return
  if (free < MIN_FREE_BYTES) {
    const available = (free / 1024 ** 3).toFixed(1)
    throw new Error(
      `备份目录所在磁盘空间不足：至少需要 2 GB 可用空间，当前可用 ${available} GB。请清理磁盘后再备份`,
    )
  }
}

/** Local `yyyyMMdd-HHmmss` stamp used in save ids. */
function timeStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('')
}

/** First free `<SAVE_PREFIX><stamp>` id, appending `-2`, `-3`, ... on collision. */
async function nextSaveId(root) {
  const base = `${SAVE_PREFIX}${timeStamp()}`
  let id = base
  let suffix = 2
  while (
    (await pathExists(path.join(root, id))) ||
    (await pathExists(path.join(root, `${id}.partial`)))
  ) {
    id = `${base}-${suffix}`
    suffix += 1
  }
  return id
}

/**
 * A publishable save has a `payload/` directory and a top-level
 * `manifest.json`. The manifest's producer is checked by the index rebuild,
 * which also skips foreign folders.
 */
async function saveLooksComplete(dir) {
  if (!(await pathExists(path.join(dir, 'payload')))) return false
  return pathIsFile(path.join(dir, 'manifest.json'))
}

/**
 * Names of folders that can hold a save: no `.partial` staging and exactly one
 * zip inside, i.e. the folders `rebuildIndex` is willing to index. Folders
 * without a zip are left out so a damaged leftover cannot force a rebuild on
 * every `listSaves` call.
 */
async function listSaveFolderNames(root) {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const names = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SAVE_PREFIX)) continue
    if (entry.name.endsWith('.partial')) continue
    if (await saveLooksComplete(path.join(root, entry.name))) names.push(entry.name)
  }
  return names
}

/** Build the archive source list plus the manifest `contents` flags. */
async function collectSources(settings, profile) {
  const sources = [{ name: 'install', path: settings.installDir }]
  sources.push({ name: `profile/${profile}`, path: settings.profileDir })

  let hasOthers = false
  for (const name of ['dsh-tui', 'headless']) {
    for (const file of OTHER_PROFILE_FILES) {
      const full = path.join(settings.home, 'profiles', name, file)
      if (!(await pathIsFile(full))) continue
      sources.push({ name: `profile/others/${name}/${file}`, path: full })
      hasOthers = true
    }
  }

  let hasHome = false
  for (const item of HOME_ITEMS) {
    const full = path.join(settings.home, item)
    if (!(await pathExists(full))) continue
    sources.push({ name: `home/${item}`, path: full })
    hasHome = true
  }

  let hasRuntimes = false
  const runtimes = path.join(settings.home, 'dsh-runtimes')
  if (await pathExists(runtimes)) {
    sources.push({ name: 'runtimes', path: runtimes })
    hasRuntimes = true
  }

  return {
    sources,
    contents: {
      hasInstall: true,
      hasProfile: true,
      hasOthers,
      hasHome,
      hasRuntimes,
    },
  }
}

/** Rename the partial folder; Windows can briefly lock it (antivirus, indexer). */
async function renameWithRetry(source, target) {
  let lastError = null
  for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt += 1) {
    try {
      await rename(source, target)
      return
    } catch (error) {
      lastError = error
      if (attempt < RENAME_ATTEMPTS) await delay(300 * attempt)
    }
  }
  throw new Error(
    `无法完成存档目录重命名：${path.basename(source)} -> ${path.basename(target)}` +
      `（${lastError?.message ?? 'unknown'}）。目录可能被其它程序占用，请重试`,
  )
}

/**
 * Create one save: validate the environment, copy every source into
 * `<id>.partial/payload`, add the manifest and restore scripts, then publish
 * the folder. Returns the manifest written next to the payload.
 */
export async function createBackup(settings, { onProgress } = {}) {
  for (const key of ['installDir', 'profileDir', 'home', 'backupRoot']) {
    if (typeof settings?.[key] !== 'string' || !settings[key].trim()) {
      throw new TypeError(`createBackup requires a non-empty settings.${key}`)
    }
  }

  const installDir = settings.installDir
  const profileDir = settings.profileDir
  const home = settings.home
  const backupRoot = settings.backupRoot
  const profile =
    typeof settings.profile === 'string' && settings.profile.trim()
      ? settings.profile.trim()
      : 'desktop'
  const notify = (stage, percent) => {
    if (typeof onProgress === 'function') onProgress(stage, percent)
  }

  // Advisory only: a disabled long-path setting may break deep backups later,
  // but must never block a backup that would otherwise succeed.
  const longPathWarning = longPathsWarning()
  if (longPathWarning) console.warn(`[dsh-crash-backup] ${longPathWarning}`)

  await cleanupOrphans(settings)
  notify('checking', 1)

  await assertDirectory(installDir, 'DSH 安装目录')
  await assertDirectory(profileDir, '插件 profile 目录')

  const backupDirCheck = validateBackupDir(backupRoot, { installDir, profileDir })
  if (!backupDirCheck.ok) throw new Error(backupDirCheck.message)

  // The archive would read the zip it is writing, or overwrite the plugin's
  // own settings.json. Both live below the DSH home. `<home>/dsh-backups` is
  // the documented fallback root and is not archived, so it is allowed.
  const pluginDataDir = path.join(home, SETTINGS_DIR_NAME)
  if (isInside(backupRoot, pluginDataDir)) {
    throw new Error(
      `备份目录不能位于插件数据目录内（会与 settings.json 冲突）：${pluginDataDir}`,
    )
  }
  const homeFallback = path.join(home, BACKUP_DIR_NAME)
  if (isInside(backupRoot, home) && comparable(backupRoot) !== comparable(homeFallback)) {
    throw new Error(`备份目录不能位于用户目录（DSH home）内：${home}`)
  }

  // Count folders, not index entries: a crash between publishing a save and
  // updating the index must not let another backup exceed the cap.
  const saveCount = (await listSaveFolderNames(backupRoot)).length
  if (saveCount >= MAX_SAVES) {
    throw new Error(
      `备份数量已达上限（limit ${MAX_SAVES}，最多保存 ${MAX_SAVES} 份存档），` +
        '请先删除旧存档后再备份',
    )
  }

  await assertFreeSpace(backupRoot)

  const createdAt = new Date().toISOString()
  const dshVersion = await readDshVersion(installDir)
  // Make the root self-describing before the first save is published. An
  // auto-created root otherwise has no marker, so choosing it in 更改目录 is
  // refused as foreign. This is idempotent and never overwrites existing files;
  // a marker-less root that already has this plugin's saves is adopted.
  await initializeBackupRoot(backupRoot, { version: dshVersion || 'unknown', createdAt })

  const id = await nextSaveId(backupRoot)
  const partial = path.join(backupRoot, `${id}.partial`)
  await mkdir(partial, { recursive: true })

  try {
    const links = await scanProfileLinks(profileDir)
    const plugins = await readProfilePlugins(profileDir)
    const { sources, contents } = await collectSources({ installDir, profileDir, home }, profile)

    let totalBytes = 0
    for (const source of sources) totalBytes += await dirSize(source.path)

    const manifest = buildManifest({
      id,
      createdAt,
      dshVersion,
      profile,
      installDir,
      home,
      backupRoot,
      plugins,
      links,
      contents,
      totalBytes,
    })

    notify('copy', 10)
    for (const source of sources) {
      const target = path.join(partial, 'payload', ...source.name.split('/'))
      await copyEntry(source.path, target)
    }

    await writeFile(
      path.join(partial, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    )
    for (const required of ['payload/install', `payload/profile/${profile}`, 'manifest.json']) {
      const requiredPath = path.join(partial, ...required.split('/'))
      if (!(await pathExists(requiredPath))) {
        throw new Error(`存档校验失败，缺少：${required}`)
      }
    }

    notify('scripts', 90)
    const names = restoreScriptNames()
    const restoreMeta = {
      id,
      createdAt,
      dshVersion,
      installDir,
      home,
      profile,
      backupRoot,
      hasProfile: contents.hasProfile,
    }
    await writeFile(path.join(partial, names.ps1), `${BOM}${renderRestorePs1(restoreMeta)}`, 'utf8')
    await writeFile(path.join(partial, names.cmd), renderRestoreCmd(), 'utf8')

    await renameWithRetry(partial, path.join(backupRoot, id))

    // The save is published at this point: an index write failure must not be
    // reported as a backup failure. listSaves reconciles a stale index by
    // comparing it with the folders on disk.
    try {
      await rebuildIndex(backupRoot)
    } catch {
      // Best effort after publish.
    }

    notify('done', 100)
    return manifest
  } catch (error) {
    // A failed backup must not leave a partial folder behind; it is never
    // listed as a save, but the next run would have to clean it up.
    await rm(partial, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/** True when the index names exactly the save folders found on disk. */
function indexMatchesFolders(saves, folders) {
  if (saves.length !== folders.length) return false
  const folderSet = new Set(folders)
  const seen = new Set()
  for (const save of saves) {
    if (!save || typeof save.id !== 'string' || !save.id) return false
    if (seen.has(save.id) || !folderSet.has(save.id)) return false
    seen.add(save.id)
  }
  return seen.size === folderSet.size
}

/**
 * Saves shown by the UI, newest first. The index is a cache: when its ids do
 * not match the `dsh-save-*` folders on disk it is rebuilt, so a crash between
 * publishing a save and updating the index cannot hide it. Entries whose folder
 * is gone or is not a complete new-format save is dropped.
 */
export async function listSaves(settings) {
  const root = settings?.backupRoot
  if (typeof root !== 'string' || !root.trim()) return []

  const folders = await listSaveFolderNames(root)
  let saves = (await readIndex(root)).saves
  if (!indexMatchesFolders(saves, folders)) {
    try {
      saves = await rebuildIndex(root)
    } catch {
      // Listing must keep working from the cached index when the rebuild
      // cannot be written back (read-only volume, stale index.json, ...).
    }
  }

  const available = []
  for (const save of saves) {
    if (!save || typeof save.id !== 'string' || !save.id) continue
    if (!save.id.startsWith(SAVE_PREFIX) || /[\\/]/.test(save.id)) continue
    if (save.id.endsWith('.partial')) continue
    if (!(await saveLooksComplete(path.join(root, save.id)))) continue
    available.push(save)
  }

  return available.sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id),
  )
}

/** Delete one save folder, then rebuild the index. */
export async function deleteSave(settings, id) {
  if (typeof id !== 'string' || !SAVE_ID_PATTERN.test(id)) {
    throw new Error(`无效的存档 id：${String(id)}`)
  }
  const root = settings?.backupRoot
  if (typeof root !== 'string' || !root.trim()) {
    throw new Error('备份目录未设置，无法删除存档')
  }

  let rootReal
  try {
    rootReal = await realpath(root)
  } catch {
    throw new Error(`备份目录不存在：${root}`)
  }

  const target = path.join(rootReal, id)
  let info = null
  try {
    info = await lstat(target)
  } catch {
    info = null
  }
  if (!info) throw new Error(`存档不存在：${id}`)
  if (info.isSymbolicLink()) {
    throw new Error(`拒绝删除存档 ${id}：存档目录是符号链接或目录联接`)
  }
  if (!info.isDirectory()) throw new Error(`拒绝删除存档 ${id}：不是文件夹`)

  let targetReal
  try {
    targetReal = await realpath(target)
  } catch {
    throw new Error(`存档不存在：${id}`)
  }
  // A junction could resolve outside the backup root; only a direct child of
  // the real backup root may be removed recursively.
  if (
    comparable(path.dirname(targetReal)) !== comparable(rootReal) ||
    path.basename(targetReal).toLowerCase() !== id.toLowerCase()
  ) {
    throw new Error(`拒绝删除存档 ${id}：目录不在备份根目录下`)
  }

  let lastError = null
  for (let attempt = 1; attempt <= DELETE_ATTEMPTS; attempt += 1) {
    try {
      await rm(targetReal, { recursive: true, force: true })
      lastError = null
      break
    } catch (error) {
      lastError = error
      if (attempt < DELETE_ATTEMPTS) await delay(200 * attempt)
    }
  }
  if (lastError) {
    throw new Error(
      `无法删除存档 ${id}：${lastError.message}。文件可能正被其它程序占用，请关闭后重试`,
    )
  }

  await rebuildIndex(rootReal)
}

/**
 * Remove one orphan folder. `fs.rm` failures are classified: `'gone'` means it
 * was removed concurrently, `'busy'` means another process still holds it and
 * it is left for the next sweep, while any unexpected error is surfaced instead
 * of being silently treated as an in-use folder.
 */
async function removeOrphan(dir, name) {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch (error) {
    const verdict = classifyRemoveError(error?.code)
    if (verdict === 'gone') return
    if (verdict === 'busy') {
      // Antivirus, Explorer or a running restore still has the folder open.
      return
    }
    throw new Error(
      `清理残留存档失败：${name}（${error?.code ?? 'unknown'}）：${error?.message ?? String(error)}`,
    )
  }
}

/**
 * Remove stale `.partial` staging folders only.
 *
 * Complete save folders are never touched: a legacy `dsh-save-slots` save is a
 * `dsh-save-*` folder holding `payload/` and `MANIFEST.json` with no zip, and
 * the spec requires old-format saves to be neither deleted nor migrated.
 *
 * Candidates are `lstat`ed before use: a junction reports as a directory to
 * `readdir` on some Node/Windows combinations, so entries that are links are
 * skipped rather than read through or deleted. Only `.partial` folders older
 * than 30 minutes are stale; a fresh one may belong to a concurrent backup.
 * Folders still held by another process are left alone; unexpected removal
 * errors are surfaced.
 */
export async function cleanupOrphans(settings) {
  const root = settings?.backupRoot
  if (typeof root !== 'string' || !root.trim()) return

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    // A missing backup root needs no cleanup; a locked one is reported by the
    // backup itself when it starts writing.
    return
  }

  const now = Date.now()
  for (const entry of entries) {
    if (!entry.name.startsWith(SAVE_PREFIX) || !entry.name.endsWith('.partial')) continue
    const full = path.join(root, entry.name)

    let info
    try {
      info = await lstat(full)
    } catch {
      // The entry vanished between readdir and lstat: nothing to clean.
      continue
    }
    // Never follow or delete a link: a junction may point at real user data.
    if (info.isSymbolicLink() || !info.isDirectory()) continue
    if (now - info.mtimeMs < STALE_PARTIAL_MS) continue
    await removeOrphan(full, entry.name)
  }
}
