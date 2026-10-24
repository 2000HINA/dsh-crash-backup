/**
 * Backup manifest: the `manifest.json` stored inside every archive, the
 * Markdown summary for humans, and the small readers that fill it in.
 */
import { readlinkSync } from 'node:fs'
import { lstat, readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

const PRODUCER = 'dsh-crash-backup'
const CONTENTS_KEYS = ['hasInstall', 'hasProfile', 'hasOthers', 'hasHome', 'hasRuntimes']
const MAX_LINK_DEPTH = 3

const str = (value) => (typeof value === 'string' ? value : '')

/** Build the manifest exactly as it is written inside an archive. */
export function buildManifest(input = {}) {
  const contents = input.contents ?? {}
  return {
    schemaVersion: 1,
    producer: PRODUCER,
    id: str(input.id),
    createdAt: str(input.createdAt) || new Date().toISOString(),
    dshVersion: str(input.dshVersion),
    profile: str(input.profile),
    installDir: str(input.installDir),
    home: str(input.home),
    backupRoot: str(input.backupRoot),
    plugins: { dependencies: { ...(input.plugins?.dependencies ?? {}) }, bundles: [...(input.plugins?.bundles ?? [])] },
    contents: Object.fromEntries(CONTENTS_KEYS.map((key) => [key, contents[key] === true])),
    links: (input.links ?? []).map((link) => ({ path: str(link?.path), target: str(link?.target) })),
    totalBytes: Number.isFinite(input.totalBytes) ? input.totalBytes : 0,
  }
}

/** Human readable byte count for the Markdown summary. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const unit = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1))
  const value = bytes / 1024 ** unit
  return `${unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Windows-style display path; filesystem work must use `node:path`. */
function displayPath(value) {
  const text = str(value)
  return text ? path.win32.normalize(text) : 'unknown'
}

/** Markdown summary kept next to the save for humans. */
export function renderManifestMd(manifest) {
  const dependencies = Object.entries(manifest.plugins?.dependencies ?? {})
  const bundles = manifest.plugins?.bundles ?? []
  const included = CONTENTS_KEYS.filter((key) => manifest.contents?.[key] === true)
  const size = Number.isFinite(manifest.totalBytes) ? manifest.totalBytes : 0
  const table =
    dependencies.length > 0
      ? dependencies.map(([name, version]) => `| ${name} | ${version} |`)
      : ['| （无） | - |']
  const lines = [
    `# DSH 备份清单：${manifest.id || 'unknown'}`,
    '',
    `- 创建时间：${manifest.createdAt || 'unknown'}`,
    `- DSH 版本：${manifest.dshVersion || 'unknown'}`,
    `- Profile：${manifest.profile || 'unknown'}`,
    `- 大小：${formatBytes(size)}（${size} 字节）`,
    `- 插件：${dependencies.length} 个`,
    `- 链接：${manifest.links?.length ?? 0} 个`,
    `- 包含内容：${included.length > 0 ? included.join('、') : '（无）'}`,
    `- Bundles：${bundles.length > 0 ? bundles.join('、') : '（无）'}`,
    `- 安装目录：\`${displayPath(manifest.installDir)}\``,
    `- 用户目录：\`${displayPath(manifest.home)}\``,
    `- 备份目录：\`${displayPath(manifest.backupRoot)}\``,
    '',
    '## 插件',
    '',
    '| 插件 | 版本 |',
    '| --- | --- |',
    ...table,
  ]
  return `${lines.join('\n')}\n`
}

/** Read `<installDir>/version`; '' when it is missing or unreadable. */
export async function readDshVersion(installDir) {
  try {
    return (await readFile(path.join(installDir, 'version'), 'utf8')).trim()
  } catch {
    return ''
  }
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read dependencies and bundles from `<profileDir>/package.json`; never throws. */
export async function readProfilePlugins(profileDir) {
  try {
    const pkg = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    return {
      dependencies: isRecord(pkg?.dependencies) ? pkg.dependencies : {},
      bundles: Array.isArray(bundles)
        ? bundles.filter((name) => typeof name === 'string')
        : [],
    }
  } catch {
    return { dependencies: {}, bundles: [] }
  }
}

/**
 * List the links below `<profileDir>/node_modules` as profile-relative paths
 * with forward slashes. Links are reported but never followed, unreadable
 * entries are skipped and the walk is bounded to three levels.
 */
export async function scanProfileLinks(profileDir) {
  const links = []

  const walk = async (dir, depth) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) {
        try {
          links.push({
            path: path.relative(profileDir, full).split(path.sep).join('/'),
            target: readlinkSync(full),
          })
        } catch {
          // Unreadable link: skip it rather than failing the whole scan.
        }
      } else if (info.isDirectory() && depth < MAX_LINK_DEPTH) {
        await walk(full, depth + 1)
      }
    }
  }

  await walk(path.join(profileDir, 'node_modules'), 1)
  return links.sort((a, b) => a.path.localeCompare(b.path))
}
