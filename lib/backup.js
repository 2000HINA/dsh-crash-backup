/**
 * Backup lifecycle: create a save folder (zip + restore scripts), list the
 * saves, delete one and clean up leftovers from interrupted backups.
 *
 * A save is assembled in `<backupRoot>/<id>.partial` and only renamed to
 * `<id>` once the archive and both restore scripts are complete, so a folder
 * whose name does not end in `.partial` is always a complete save.
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
import { createArchive, dirSize, verifyArchive } from './archive.js'
import { MAX_SAVES, SAVE_PREFIX, SETTINGS_DIR_NAME } from './constants.js'
import { readIndex, rebuildIndex } from './index-file.js'
import { buildManifest, readDshVersion, readProfilePlugins, scanProfileLinks } from './manifest.js'
import { renderRestoreCmd, renderRestorePs1, restoreScriptNames } from './scripts.js'
import { validateBackupDir } from './settings.js'

const BOM = '\uFEFF'
const MIN_FREE_BYTES = 2 * 1024 ** 3
const SAVE_ID_PATTERN = /^dsh-save-\d{8}-\d{6}(-\d+)?$/
const RENAME_ATTEMPTS = 8
const DELETE_ATTEMPTS = 6

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

/** True when the folder holds at least one zip file; unreadable counts as true. */
async function containsZip(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
  } catch {
    // An unreadable folder is not provably empty, so it is left alone.
    return true
  }
}

/** The single zip inside a save folder, or null when it is not exactly one. */
async function saveZipPath(dir) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const zips = entries.filter(
    (entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'),
  )
  return zips.length === 1 ? path.join(dir, zips[0].name) : null
}

/** Build the archive source list plus the manifest `contents` flags. */
async function collectSources(settings, profile) {
  const sources = [{ name: 'install', path: settings.installDir }]
  sources.push({ name: `profile/${profile}`, path: settings.profileDir })

  let hasOthers = false
  for (const name of ['dsh-tui', 'headless']) {
    const dir = path.join(settings.home, 'profiles', name)
    if (!(await pathExists(dir))) continue
    sources.push({ name: `profile/others/${name}`, path: dir })
    hasOthers = true
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
 * Create one save: validate the environment, archive every source into
 * `<id>.partial/<id>.zip`, add the restore scripts, then publish the folder.
 * Returns the manifest written into the archive.
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

  await cleanupOrphans(settings)
  notify('checking', 1)

  await assertDirectory(installDir, 'DSH 安装目录')
  await assertDirectory(profileDir, '插件 profile 目录')

  const backupDirCheck = validateBackupDir(backupRoot, { installDir, profileDir })
  if (!backupDirCheck.ok) throw new Error(backupDirCheck.message)

  // The archive would read the zip it is writing, or overwrite the plugin's
  // own settings.json. Both live below the DSH home.
  const pluginDataDir = path.join(home, SETTINGS_DIR_NAME)
  if (isInside(backupRoot, pluginDataDir)) {
    throw new Error(
      `备份目录不能位于插件数据目录内（会与 settings.json 冲突）：${pluginDataDir}`,
    )
  }
  if (isInside(backupRoot, home)) {
    throw new Error(`备份目录不能位于用户目录（DSH home）内：${home}`)
  }

  const saves = await listSaves(settings)
  if (saves.length >= MAX_SAVES) {
    throw new Error(
      `备份数量已达上限（limit ${MAX_SAVES}，最多保存 ${MAX_SAVES} 份存档），` +
        '请先删除旧存档后再备份',
    )
  }

  await assertFreeSpace(backupRoot)

  const createdAt = new Date().toISOString()
  const id = await nextSaveId(backupRoot)
  const partial = path.join(backupRoot, `${id}.partial`)
  await mkdir(partial, { recursive: true })

  try {
    const links = await scanProfileLinks(profileDir)
    const dshVersion = await readDshVersion(installDir)
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

    notify('archive', 10)
    const zipPath = path.join(partial, `${id}.zip`)
    await createArchive({ zipPath, sources, manifest })

    const required = ['manifest.json', 'install/', `profile/${profile}/`]
    const verification = await verifyArchive(zipPath, required)
    if (!verification.ok) {
      throw new Error(`存档校验失败，压缩包缺少：${verification.missing.join('、')}`)
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
    await rebuildIndex(backupRoot)
    notify('done', 100)
    return manifest
  } catch (error) {
    // A failed backup must not leave a partial folder behind; it is never
    // listed as a save, but the next run would have to clean it up.
    await rm(partial, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

/**
 * Saves shown by the UI, newest first. The index is a cache: when it is empty
 * or missing but save folders exist, it is rebuilt; stale entries are dropped.
 */
export async function listSaves(settings) {
  const root = settings?.backupRoot
  if (typeof root !== 'string' || !root.trim()) return []

  let saves = (await readIndex(root)).saves
  if (saves.length === 0) {
    let entries = []
    try {
      entries = await readdir(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    if (entries.some((entry) => entry.isDirectory() && entry.name.startsWith(SAVE_PREFIX))) {
      saves = await rebuildIndex(root)
    }
  }

  const available = []
  for (const save of saves) {
    if (!save || typeof save.id !== 'string' || !save.id) continue
    if (!save.id.startsWith(SAVE_PREFIX) || /[\\/]/.test(save.id)) continue
    if (save.id.endsWith('.partial')) continue
    if (!(await saveZipPath(path.join(root, save.id)))) continue
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

/** Remove interrupted `.partial` folders and save folders that have no zip. */
export async function cleanupOrphans(settings) {
  const root = settings?.backupRoot
  if (typeof root !== 'string' || !root.trim()) return

  let entries = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    // Directory junctions are not `isDirectory()` here, so links are left
    // untouched instead of being followed.
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    if (entry.name.endsWith('.partial')) {
      await rm(full, { recursive: true, force: true }).catch(() => {})
      continue
    }
    if (!entry.name.startsWith(SAVE_PREFIX)) continue
    if (await containsZip(full)) continue
    await rm(full, { recursive: true, force: true }).catch(() => {})
  }
}
