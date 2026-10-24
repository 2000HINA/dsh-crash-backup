/**
 * Initialize a backup root: create its internal working directories and write
 * the user-facing README, the backup-root metadata and the index placeholder.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const README = `DSH 崩溃备份目录

这个目录由 DSH 插件 dsh-crash-backup 创建，用来保存 DSH 环境的压缩存档。
每个存档是一个独立的 dsh-save-* 文件夹，里面包含 .zip 压缩包、RESTORE.cmd 和 RESTORE.ps1。

DSH 崩溃或无法启动时，打开对应存档文件夹，双击 RESTORE.cmd 回档。
恢复脚本提供两种回档模式：完整回档会把安装目录、插件 profile 和用户数据一起恢复到存档状态；
仅回滚插件只恢复插件 profile，不改动安装目录和用户数据。双击后按脚本内菜单选择。

存档压缩包里就是备份时的设置与数据：安装目录 install/、插件 profile、DSH home 与 runtimes。
回档后环境会回到备份时的状态，备份之后的新改动不会保留。

默认备份目录是 DSH 安装目录所在文件夹下的 dsh-backups，可以在 DSH 设置页中改成其它位置。
本文件所在的目录就是当前使用的备份目录。

空间要求：每份存档压缩包约 1 GB；回档时还会在备份目录内解压出临时副本，
需要额外约 2.6 GB 空间。请确保备份盘有足够剩余空间，空间不足会导致回档中止。

凭据警告：存档压缩包内包含 .credentials.yaml，里面是 API Key 等登录凭据（未加密）。
请勿把存档或本目录分享、上传给他人，也不要放进公共网盘。

目录说明：
  _pre-restore/   回档前自动保存的关键配置快照
  _restore-logs/  每次回档的日志
  index.json      存档索引
  settings.json   本备份目录的基础信息（插件版本与创建时间）
`

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

  await writeFile(path.join(root, 'README.txt'), README, 'utf8')
  await writeFile(path.join(root, 'settings.json'), json(metadata), 'utf8')
  await createIfMissing(path.join(root, 'index.json'), `${JSON.stringify({ saves: [] })}\n`)
}
