/**
 * Render the files a save folder carries: the standalone PowerShell restore
 * script, its ASCII cmd launcher and the backup-root README.
 *
 * The PowerShell text is UTF-8; the caller writes it with a BOM so Windows
 * PowerShell 5.1 decodes the Chinese text correctly. The cmd launcher must
 * stay pure ASCII because cmd.exe runs it before the code page is switched.
 */

const PS1_NAME = 'RESTORE.ps1'
const CMD_NAME = 'RESTORE.cmd'

const text = (value) => (typeof value === 'string' ? value : '')

/** Single-quoted PowerShell string: only `'` needs doubling. */
function psQuote(value) {
  return `'${text(value).replace(/'/g, "''")}'`
}

/** Names of the two scripts every save folder contains. */
export function restoreScriptNames() {
  return { ps1: PS1_NAME, cmd: CMD_NAME }
}

/** ASCII launcher: switch the console to UTF-8, run the script, stay open. */
export function renderRestoreCmd() {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0RESTORE.ps1" %*',
    'set "code=%ERRORLEVEL%"',
    'pause',
    'exit /b %code%',
    '',
  ].join('\r\n')
}

/** User-facing README kept in the backup root. */
export function renderBackupReadme(meta = {}) {
  const root = text(meta.backupRoot).trim()
  const locationLine = root
    ? `当前备份目录：${root}`
    : '本文件所在的目录就是当前使用的备份目录。'

  return `DSH 崩溃备份目录

这个目录由 DSH 插件 dsh-crash-backup 创建，用来保存 DSH 环境的压缩存档。
每个存档是一个独立的 dsh-save-* 文件夹，里面包含 .zip 压缩包、RESTORE.cmd 和 RESTORE.ps1。

DSH 崩溃或无法启动时，打开对应存档文件夹，双击 RESTORE.cmd 回档。
恢复脚本提供两种回档模式：完整回档会把安装目录、插件 profile 和用户数据一起恢复到存档状态；
仅回滚插件只恢复插件 profile，不改动安装目录和用户数据。双击后按脚本内菜单选择。

存档压缩包里就是备份时的设置与数据：安装目录 install/、插件 profile、DSH home 与 runtimes。
回档后环境会回到备份时的状态，备份之后的新改动不会保留。

默认备份目录是 DSH 安装目录所在文件夹下的 dsh-backups，可以在 DSH 设置页中改成其它位置。
${locationLine}

空间要求：每份存档压缩包约 1 GB；回档时还会在备份目录内解压出临时副本，
需要额外约 2.6 GB 空间。请确保备份盘有足够剩余空间，空间不足会导致回档中止。

凭据警告：存档压缩包内包含 .credentials.yaml，里面是 API Key 等登录凭据（未加密）。
请勿把存档或本目录分享、上传给他人，也不要放进公共网盘。

目录说明：
  _pre-restore/   回档前自动保存的关键配置快照
  _restore-logs/  每次回档的日志
  _restore-tmp/   回档时的临时解压目录（成功后自动清理）
  index.json      存档索引
  settings.json   本备份目录的基础信息（插件版本与创建时间）
`
}

/**
 * Standalone RESTORE.ps1 for one save.
 *
 * The script must keep working when DSH cannot start: it has no dependency on
 * the plugin, checks everything before touching a target, asks for a clear
 * Y/N confirmation, snapshots the current configuration, stops a running DSH
 * only after approval, restores by mirror/overwrite and always ends with
 * Wait-AnyKey. `-Mode plugins` is a deliberate safe stub until plugin-only
 * rollback is implemented.
 */
export function renderRestorePs1(meta = {}) {
  const hasProfile = meta.hasProfile === true
  const profile = text(meta.profile) || 'desktop'

  return String.raw`#Requires -Version 5.1
<#
  DeepSeek Harness 崩溃恢复脚本（RESTORE.ps1）
  由 dsh-crash-backup 插件在创建存档时生成，请勿手工修改。
  双击同目录的 RESTORE.cmd 运行，也可以直接执行：
      .\RESTORE.ps1 -Mode full
#>
[CmdletBinding()]
param(
    [ValidateSet('full', 'plugins')]
    [string]$Mode = 'full',
    [switch]$FromUi,
    [string]$InstallDirOverride = '',
    [string]$UserDshOverride = '',
    [string]$BackupRootOverride = ''
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# 存档信息（生成脚本时写入）
# ---------------------------------------------------------------------------
$SaveId = ${psQuote(meta.id)}
$SaveCreatedAt = ${psQuote(meta.createdAt)}
$SavedDshVersion = ${psQuote(meta.dshVersion)}
$SavedInstallDir = ${psQuote(meta.installDir)}
$SavedHome = ${psQuote(meta.home)}
$SavedProfile = ${psQuote(profile)}
$SavedBackupRoot = ${psQuote(meta.backupRoot)}
$HasProfile = ${hasProfile ? '$true' : '$false'}
$PayloadRoot = $PSScriptRoot

# 允许覆盖：整个备份目录被移动、DSH 装到别处时脚本仍可使用。
$InstallDir = if ($InstallDirOverride) { $InstallDirOverride } else { $SavedInstallDir }
$HomeDir = if ($UserDshOverride) { $UserDshOverride } else { $SavedHome }
$BackupRoot = if ($BackupRootOverride) { $BackupRootOverride } else { $SavedBackupRoot }
if (-not $BackupRootOverride -and -not (Test-Path -LiteralPath $BackupRoot -PathType Container)) {
    # 存档文件夹的父目录就是备份目录（兼容整个备份目录被移动/重命名）。
    $BackupRoot = Split-Path -Parent $PayloadRoot
}
$ProfileDir = Join-Path (Join-Path $HomeDir 'profiles') $SavedProfile
$SelfPluginDir = Join-Path $ProfileDir 'node_modules\dsh-crash-backup'

# ---------------------------------------------------------------------------
# 结束前必须停留：崩溃场景下窗口不能一闪而过
# ---------------------------------------------------------------------------
function Wait-AnyKey {
    param([string]$Prompt = '按任意键退出...')
    Write-Host ''
    Write-Host $Prompt -ForegroundColor Yellow
    try {
        # 输入被重定向（脚本由其它程序启动）时没有可用的 RawUI。
        if ([Console]::IsInputRedirected) { throw 'input is redirected' }
        [void]$Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
    } catch {
        # 无控制台或输入被重定向时没有 RawUI，退回 Read-Host。
        try {
            [void](Read-Host '按任意键继续')
        } catch {
        }
    }
}

# ---------------------------------------------------------------------------
# 日志：<backupRoot>\_restore-logs\restore-<id>-<timestamp>.log
# ---------------------------------------------------------------------------
$script:LogPath = $null
$script:LogDir = Join-Path $BackupRoot '_restore-logs'
$script:TempDir = $null

function Write-Log {
    param([string]$Message)
    $line = '[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Host $line
    if ($script:LogPath) {
        try {
            Add-Content -LiteralPath $script:LogPath -Value $line -Encoding UTF8
        } catch {
            # 日志写不进去不能影响回档本身。
        }
    }
}

$logStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:LogPath = Join-Path $script:LogDir ('restore-{0}-{1}.log' -f $SaveId, $logStamp)
try {
    New-Item -ItemType Directory -Path $script:LogDir -Force | Out-Null
} catch {
    Write-Host ('无法创建日志目录：{0}' -f $script:LogDir) -ForegroundColor Yellow
}

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------
function Format-Size {
    param([int64]$Bytes)
    if ($Bytes -lt 0) { return '未知' }
    if ($Bytes -ge 1099511627776) { return ('{0:N1} TB' -f ($Bytes / 1099511627776)) }
    if ($Bytes -ge 1073741824) { return ('{0:N1} GB' -f ($Bytes / 1073741824)) }
    if ($Bytes -ge 1048576) { return ('{0:N1} MB' -f ($Bytes / 1048576)) }
    return ('{0:N0} KB' -f ($Bytes / 1024))
}

function Get-FreeBytes {
    param([string]$Path)
    try {
        $root = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($Path))
        if (-not $root -or $root.StartsWith('\\')) { return [int64]-1 }
        $drive = Get-PSDrive -Name $root.Substring(0, 1) -ErrorAction Stop
        if ($null -eq $drive.Free) { return [int64]-1 }
        return [int64]$drive.Free
    } catch {
        return [int64]-1
    }
}

function Assert-SafeDirectory {
    param([string]$Path, [string]$Label)
    if (-not $Path) { throw ('{0} 为空，回档中止。' -f $Label) }
    $full = [IO.Path]::GetFullPath($Path)
    $root = [IO.Path]::GetPathRoot($full)
    if ($full -eq $root) { throw ('{0} 不能是磁盘根目录：{1}' -f $Label, $Path) }
}

function Get-DshProcesses {
    param([string]$Root)
    $result = @()
    $prefix = $Root
    while ($prefix.EndsWith('\') -or $prefix.EndsWith('/')) {
        $prefix = $prefix.Substring(0, $prefix.Length - 1)
    }
    $prefix = $prefix + '\'
    foreach ($process in @(Get-Process -ErrorAction SilentlyContinue)) {
        $path = $null
        try { $path = $process.Path } catch { $path = $null }
        if ($path -and $path.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            $result += $process
        }
    }
    return $result
}

function Invoke-Robocopy {
    param(
        [string]$Source,
        [string]$Destination,
        [switch]$Mirror,
        [string[]]$ExcludeDirs = @()
    )
    if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
        throw ('缺少要恢复的目录：{0}' -f $Source)
    }
    if (-not (Test-Path -LiteralPath $Destination)) {
        New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    }
    $arguments = @($Source, $Destination)
    if ($Mirror) { $arguments += '/MIR' } else { $arguments += '/E' }
    if ($ExcludeDirs.Count -gt 0) {
        $arguments += '/XD'
        $arguments += $ExcludeDirs
    }
    $arguments += @('/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    & robocopy @arguments | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ge 8) {
        throw ('robocopy 失败（退出码 {0}）：{1} -> {2}' -f $exitCode, $Source, $Destination)
    }
    Write-Log ('已恢复 {0}（robocopy 退出码 {1}）' -f $Destination, $exitCode)
}

try {
    # -----------------------------------------------------------------------
    # 存档信息展示
    # -----------------------------------------------------------------------
    $CurrentDshVersion = 'unknown'
    try {
        $versionFile = Join-Path $InstallDir 'version'
        if (Test-Path -LiteralPath $versionFile -PathType Leaf) {
            $rawVersion = Get-Content -LiteralPath $versionFile -Raw -ErrorAction Stop
            if ($rawVersion) { $CurrentDshVersion = $rawVersion.Trim() }
        }
    } catch {
        $CurrentDshVersion = 'unknown'
    }

    Write-Host ''
    Write-Host '================================================' -ForegroundColor Cyan
    Write-Host ' DeepSeek Harness 崩溃恢复 - 完整回档' -ForegroundColor Cyan
    Write-Host '================================================' -ForegroundColor Cyan
    Write-Log ('存档 ID：{0}' -f $SaveId)
    Write-Log ('存档时间：{0}' -f $SaveCreatedAt)
    Write-Log ('存档时的 DSH 版本：{0}' -f $SavedDshVersion)
    Write-Log ('当前 DSH 版本：{0}' -f $CurrentDshVersion)
    Write-Log ('安装目录：{0}' -f $InstallDir)
    Write-Log ('用户目录：{0}' -f $HomeDir)
    Write-Log ('Profile：{0}' -f $SavedProfile)
    Write-Log ('备份目录：{0}' -f $BackupRoot)
    Write-Log ('脚本目录：{0}' -f $PayloadRoot)
    Write-Log ('回档模式：{0}' -f $Mode)
    if ($FromUi) { Write-Log '本次回档由 DSH 设置页启动。' }
    if ($HasProfile) {
        Write-Log '存档包含插件 profile。'
    } else {
        Write-Log '存档不包含插件 profile，将跳过 profile 恢复。'
    }
    if ($CurrentDshVersion -ne 'unknown' -and $SavedDshVersion -and $CurrentDshVersion -ne $SavedDshVersion) {
        Write-Host ('注意：存档版本 {0} 与当前版本 {1} 不同，回档后可能出现插件加载失败。' -f $SavedDshVersion, $CurrentDshVersion) -ForegroundColor Yellow
        Write-Log '存档与当前 DSH 版本不一致。'
    }

    # -----------------------------------------------------------------------
    # 模式守卫：插件级回档尚未启用，必须安全退出且不修改任何文件
    # -----------------------------------------------------------------------
    if ($Mode -eq 'plugins') {
        Write-Host ''
        Write-Host '插件级回档尚未启用：本脚本目前只支持完整回档。' -ForegroundColor Yellow
        Write-Host '未修改任何文件。' -ForegroundColor Yellow
        Write-Log '插件级回档尚未启用，脚本安全退出。'
        Wait-AnyKey
        exit 2
    }

    # -----------------------------------------------------------------------
    # 确认：任何修改之前必须得到明确的 Y/y
    # -----------------------------------------------------------------------
    Write-Host ''
    Write-Host '警告：回档后当前 DSH 状态无法恢复。' -ForegroundColor Red
    Write-Host ('即将把 DSH 恢复到存档 {0} 的状态。' -f $SaveId) -ForegroundColor Yellow
    $confirm = ''
    try {
        $confirm = Read-Host '是否继续？输入 Y 继续，输入 N 或其它内容取消 [Y/N]'
    } catch {
        $confirm = ''
    }
    if ($confirm -notmatch '^[Yy]$') {
        Write-Host '已取消回档：未修改任何文件。' -ForegroundColor Yellow
        Write-Log '用户取消回档，未修改任何文件。'
        Wait-AnyKey
        exit 0
    }
    Write-Log '用户确认继续回档。'

    # -----------------------------------------------------------------------
    # 回档前校验：目录、压缩包、tar.exe 与磁盘空间
    # -----------------------------------------------------------------------
    Assert-SafeDirectory -Path $BackupRoot -Label '备份目录'
    Assert-SafeDirectory -Path $InstallDir -Label '安装目录'
    Assert-SafeDirectory -Path $ProfileDir -Label '插件 profile 目录'
    Assert-SafeDirectory -Path $HomeDir -Label '用户目录'

    Write-Log '开始回档前校验...'
    $ZipPath = Join-Path $PayloadRoot ('{0}.zip' -f $SaveId)
    if (-not (Test-Path -LiteralPath $ZipPath -PathType Leaf)) {
        $zipCandidate = Get-ChildItem -LiteralPath $PayloadRoot -Filter '*.zip' -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($zipCandidate) {
            $ZipPath = $zipCandidate.FullName
            Write-Log ('未找到 {0}.zip，改用同目录压缩包：{1}' -f $SaveId, $ZipPath)
        } else {
            throw ('找不到存档压缩包：{0}' -f $ZipPath)
        }
    }
    Write-Log ('存档压缩包：{0}' -f $ZipPath)

    $TarPath = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $TarPath -PathType Leaf)) {
        throw ('系统缺少 tar.exe：{0}（需要 Windows 10 1803 或更高版本）' -f $TarPath)
    }
    Write-Log ('使用系统 tar：{0}' -f $TarPath)

    $archiveEntries = @(& $TarPath -tf $ZipPath 2>$null)
    if ($LASTEXITCODE -ne 0) {
        throw '无法读取存档压缩包，文件可能已损坏。'
    }
    $hasManifest = $false
    foreach ($entry in $archiveEntries) {
        $normalized = ([string]$entry) -replace '^\./', ''
        if ($normalized -eq 'manifest.json') { $hasManifest = $true }
    }
    if (-not $hasManifest) {
        throw '存档中缺少 manifest.json，压缩包不完整。'
    }

    $zipBytes = (Get-Item -LiteralPath $ZipPath).Length
    $estimatedBytes = [int64]($zipBytes * 3) + 536870912
    $freeBackup = Get-FreeBytes $BackupRoot
    if ($freeBackup -ge 0 -and $freeBackup -lt $estimatedBytes) {
        throw ('备份目录所在磁盘空间不足：需要约 {0}，当前可用 {1}。' -f (Format-Size $estimatedBytes), (Format-Size $freeBackup))
    }
    $freeInstall = Get-FreeBytes $InstallDir
    if ($freeInstall -ge 0 -and $freeInstall -lt 268435456) {
        throw ('安装目录所在磁盘空间不足：至少需要 256 MB 可用空间，当前可用 {0}。' -f (Format-Size $freeInstall))
    }
    Write-Log ('空间校验通过：备份盘可用 {0}，安装盘可用 {1}。' -f (Format-Size $freeBackup), (Format-Size $freeInstall))

    # -----------------------------------------------------------------------
    # 回档前快照：当前关键配置另存，失败则中止
    # -----------------------------------------------------------------------
    $snapshotStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $SnapshotRoot = Join-Path (Join-Path $BackupRoot '_pre-restore') $snapshotStamp
    $snapshotItems = @(
        @{ Source = (Join-Path $HomeDir 'cordis.patch.yml'); Destination = (Join-Path $SnapshotRoot 'home\cordis.patch.yml') },
        @{ Source = (Join-Path $HomeDir 'settings.yaml'); Destination = (Join-Path $SnapshotRoot 'home\settings.yaml') },
        @{ Source = (Join-Path $ProfileDir 'package.json'); Destination = (Join-Path $SnapshotRoot 'profile\package.json') },
        @{ Source = (Join-Path $ProfileDir 'pnpm-lock.yaml'); Destination = (Join-Path $SnapshotRoot 'profile\pnpm-lock.yaml') },
        @{ Source = (Join-Path $ProfileDir 'cordis.patch.yml'); Destination = (Join-Path $SnapshotRoot 'profile\cordis.patch.yml') }
    )
    New-Item -ItemType Directory -Path $SnapshotRoot -Force | Out-Null
    $savedFiles = 0
    foreach ($item in $snapshotItems) {
        if (Test-Path -LiteralPath $item.Source -PathType Leaf) {
            $parent = Split-Path -Parent $item.Destination
            if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            Copy-Item -LiteralPath $item.Source -Destination $item.Destination -Force
            $savedFiles++
        }
    }
    if ($savedFiles -eq 0) {
        Write-Log ('警告：没有找到可快照的配置文件（快照目录：{0}）。' -f $SnapshotRoot)
    } else {
        Write-Log ('回档前配置快照：{0}（{1} 个文件）' -f $SnapshotRoot, $savedFiles)
    }

    # -----------------------------------------------------------------------
    # 停止正在运行的 DSH（按可执行文件路径识别，先询问）
    # -----------------------------------------------------------------------
    $dshProcesses = @(Get-DshProcesses -Root $InstallDir)
    if ($dshProcesses.Count -gt 0) {
        Write-Host ''
        Write-Host '检测到 DeepSeek Harness 正在运行，回档前必须关闭：' -ForegroundColor Yellow
        foreach ($process in $dshProcesses) {
            Write-Host ('  PID {0}  {1}' -f $process.Id, $process.ProcessName) -ForegroundColor Yellow
            Write-Log ('检测到 DSH 进程：PID {0} {1}' -f $process.Id, $process.ProcessName)
        }
        $stopAnswer = ''
        try {
            $stopAnswer = Read-Host '是否结束这些进程并继续回档？[Y/N]'
        } catch {
            $stopAnswer = ''
        }
        if ($stopAnswer -notmatch '^[Yy]$') {
            Write-Host '已取消回档：未修改任何文件。' -ForegroundColor Yellow
            Write-Log '用户拒绝结束 DSH 进程，回档中止，未修改任何文件。'
            Wait-AnyKey
            exit 0
        }
        foreach ($process in $dshProcesses) {
            try {
                Stop-Process -Id $process.Id -Force -ErrorAction Stop
            } catch {
                Write-Log ('结束进程失败：PID {0} {1}' -f $process.Id, $_.Exception.Message)
            }
        }
        Start-Sleep -Seconds 2
        $remaining = @(Get-DshProcesses -Root $InstallDir)
        if ($remaining.Count -gt 0) {
            throw ('仍有 {0} 个 DSH 进程未能结束，回档中止。' -f $remaining.Count)
        }
        Write-Log '已结束 DSH 进程，可以开始恢复。'
    } else {
        Write-Log '未检测到运行中的 DSH 进程。'
    }

    # -----------------------------------------------------------------------
    # 解压到 <backupRoot>\_restore-tmp\<id>，再镜像/覆盖恢复
    # -----------------------------------------------------------------------
    $script:TempDir = Join-Path (Join-Path $BackupRoot '_restore-tmp') $SaveId
    if (Test-Path -LiteralPath $script:TempDir) {
        Remove-Item -LiteralPath $script:TempDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $script:TempDir -Force | Out-Null
    Write-Log ('解压存档到：{0}' -f $script:TempDir)
    & $TarPath -xf $ZipPath -C $script:TempDir
    if ($LASTEXITCODE -ne 0) {
        throw ('tar 解压失败（退出码 {0}）。' -f $LASTEXITCODE)
    }

    $extractedInstall = Join-Path $script:TempDir 'install'
    if (-not (Test-Path -LiteralPath $extractedInstall -PathType Container)) {
        throw '解压后缺少 install 目录，存档不完整，回档中止。'
    }
    $extractedProfile = Join-Path (Join-Path $script:TempDir 'profile') $SavedProfile
    if ($HasProfile -and -not (Test-Path -LiteralPath $extractedProfile -PathType Container)) {
        throw ('解压后缺少 profile/{0} 目录，存档不完整，回档中止。' -f $SavedProfile)
    }

    Write-Log '恢复安装目录（镜像）...'
    Invoke-Robocopy -Source $extractedInstall -Destination $InstallDir -Mirror

    if ($HasProfile) {
        # robocopy 的 /XD 对深度 1 的目标目录有效，嵌套目录在 /MIR 清理时
        # 仍可能被删除。因此 profile 顶层先排除整个 node_modules，再单独
        # 镜像 node_modules，让本插件目录成为该次镜像的深度 1 排除项。
        $profileNodeModules = Join-Path $ProfileDir 'node_modules'
        Write-Log '恢复插件 profile（镜像；node_modules 单独恢复）...'
        Invoke-Robocopy -Source $extractedProfile -Destination $ProfileDir -Mirror -ExcludeDirs @($SelfPluginDir, $profileNodeModules)
        $extractedNodeModules = Join-Path $extractedProfile 'node_modules'
        if (Test-Path -LiteralPath $extractedNodeModules -PathType Container) {
            Write-Log '恢复 profile 的 node_modules（镜像，排除本插件目录）...'
            Invoke-Robocopy -Source $extractedNodeModules -Destination $profileNodeModules -Mirror -ExcludeDirs @($SelfPluginDir)
        } else {
            Write-Log '存档未包含 profile 的 node_modules，保留现有依赖。'
        }
    } else {
        Write-Log '存档不包含插件 profile，跳过 profile 恢复。'
    }

    $extractedHome = Join-Path $script:TempDir 'home'
    if (Test-Path -LiteralPath $extractedHome -PathType Container) {
        Write-Log '恢复用户目录（覆盖）...'
        Invoke-Robocopy -Source $extractedHome -Destination $HomeDir -ExcludeDirs @('dsh-crash-backup')
    } else {
        Write-Log '存档不包含用户目录，跳过。'
    }

    $extractedRuntimes = Join-Path $script:TempDir 'runtimes'
    if (Test-Path -LiteralPath $extractedRuntimes -PathType Container) {
        $runtimesDir = Join-Path $HomeDir 'dsh-runtimes'
        Write-Log ('恢复运行时依赖（覆盖）：{0}' -f $runtimesDir)
        Invoke-Robocopy -Source $extractedRuntimes -Destination $runtimesDir
    } else {
        Write-Log '存档不包含运行时依赖，跳过。'
    }

    # -----------------------------------------------------------------------
    # 按 manifest.json 的 links 重建 junction
    # -----------------------------------------------------------------------
    $manifestPath = Join-Path $script:TempDir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw '解压后缺少 manifest.json，无法重建插件依赖链接。'
    }
    $manifest = $null
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $manifest = $null
    }
    if (-not $manifest) {
        throw '无法解析 manifest.json，回档中止。'
    }

    $links = @()
    if ($manifest.links) { $links = @($manifest.links) }
    foreach ($link in $links) {
        $relativePath = [string]$link.path
        $target = ([string]$link.target).TrimEnd([char[]]@('\', '/'))
        if (-not $relativePath -or -not $target) { continue }
        $destination = Join-Path $ProfileDir ($relativePath -replace '/', '\')
        if (-not [IO.Path]::IsPathRooted($target)) {
            $target = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $destination) $target))
        }
        $parent = Split-Path -Parent $destination
        if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
        if (Test-Path -LiteralPath $destination) {
            $existing = Get-Item -LiteralPath $destination -Force
            if ($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                & cmd.exe /c rmdir $destination | Out-Null
            } else {
                Remove-Item -LiteralPath $destination -Recurse -Force
            }
        }
        & cmd.exe /c mklink /J $destination $target | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw ('重建 junction 失败：{0} -> {1}' -f $destination, $target)
        }
        Write-Log ('已重建链接：{0} -> {1}' -f $destination, $target)
    }

    if (-not (Test-Path -LiteralPath $SelfPluginDir)) {
        Write-Host '警告：回档后未找到 dsh-crash-backup 插件目录，请重新安装本插件。' -ForegroundColor Yellow
        Write-Log '警告：回档后插件目录不存在，需要重新安装 dsh-crash-backup。'
    }

    # -----------------------------------------------------------------------
    # 成功：清理临时解压目录并提示重启 DSH
    # -----------------------------------------------------------------------
    try {
        if (Test-Path -LiteralPath $script:TempDir) {
            Remove-Item -LiteralPath $script:TempDir -Recurse -Force -ErrorAction Stop
        }
    } catch {
        Write-Log ('警告：无法清理临时目录 {0}，可稍后手动删除。' -f $script:TempDir)
    }

    Write-Host ''
    Write-Host '回档完成。' -ForegroundColor Green
    Write-Host '请关闭所有 DSH 窗口并重新启动 DeepSeek Harness。' -ForegroundColor Green
    Write-Host ('日志文件：{0}' -f $script:LogPath) -ForegroundColor DarkGray
    Write-Log '回档完成，请重启 DSH。'
    Wait-AnyKey '回档完成，按任意键退出...'
    exit 0
} catch {
    # -----------------------------------------------------------------------
    # 失败：打印原因与日志路径，停留后以非零状态退出
    # -----------------------------------------------------------------------
    $failure = $_.Exception.Message
    Write-Host ''
    Write-Host ('回档失败：{0}' -f $failure) -ForegroundColor Red
    Write-Log ('回档失败：{0}' -f $failure)
    if ($script:LogPath) {
        Write-Host ('日志文件：{0}' -f $script:LogPath) -ForegroundColor Yellow
    }
    if ($script:TempDir) {
        try {
            if (Test-Path -LiteralPath $script:TempDir) {
                Remove-Item -LiteralPath $script:TempDir -Recurse -Force -ErrorAction Stop
                Write-Host '已清理临时解压目录。' -ForegroundColor Yellow
            }
        } catch {
            Write-Host ('临时目录未能清理：{0}' -f $script:TempDir) -ForegroundColor Yellow
        }
    }
    Wait-AnyKey '回档失败，按任意键退出...'
    exit 1
}
`
}
