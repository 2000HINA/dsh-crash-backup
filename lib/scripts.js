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
  _restore-in-progress.json  回档脚本运行期间的占用标记（脚本结束自动删除）
  index.json      存档索引
  settings.json   本备份目录的基础信息（插件版本与创建时间）
  .dsh-crash-backup.json  本插件用来识别自己备份目录的标记文件（请勿删除）
`
}

/**
 * Standalone RESTORE.ps1 for one save.
 *
 * The script must keep working when DSH cannot start: it has no dependency on
 * the plugin, checks everything before touching a target, asks for a clear
 * Y/N confirmation, snapshots the current configuration, stops a running DSH
 * only after approval, restores by mirror/overwrite and always ends with
 * Wait-AnyKey. Without an explicit -Mode the script first asks for the restore
 * mode through a 1/2 menu; `-Mode plugins` restores the plugin profile only and
 * never writes the installation, the user data or the runtimes.
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

# 显式传入 -Mode（设置页或自动化调用）时跳过模式菜单；双击 RESTORE.cmd 时
# 没有参数，脚本先让用户选择回档方式。
$ModeExplicit = $PSBoundParameters.ContainsKey('Mode')

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
            [void](Read-Answer '按任意键继续')
        } catch {
        }
    }
}

# 读取一个 Y/N 回答。输入被重定向时不使用 Read-Host（它可能与重定向流
# 争用同一个缓冲区并返回空串）；同一读者读到 EOF 时按“取消”处理。
function Read-Answer {
    param([string]$Prompt)
    try {
        if ([Console]::IsInputRedirected) {
            Write-Host $Prompt
            if ([Console]::In.Peek() -lt 0) { return '' }
            return [string][Console]::In.ReadLine()
        }
        return [string](Read-Host $Prompt)
    } catch {
        return ''
    }
}

# ---------------------------------------------------------------------------
# 日志：<backupRoot>\_restore-logs\restore-<id>-<timestamp>.log
# ---------------------------------------------------------------------------
$script:LogPath = $null
$script:LogDir = Join-Path $BackupRoot '_restore-logs'
$script:TempDir = $null
# RESTORE.ps1 运行期间写入的租约文件（设置页据此保持 busy）。
$script:LeasePath = $null

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
    $arguments += @('/XJ', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
    & robocopy @arguments | Out-Null
    $exitCode = $LASTEXITCODE
    if ($exitCode -ge 8) {
        throw ('robocopy 失败（退出码 {0}）：{1} -> {2}' -f $exitCode, $Source, $Destination)
    }
    Write-Log ('已恢复 {0}（robocopy 退出码 {1}）' -f $Destination, $exitCode)
}

# 列出 Root 下所有目录联接/符号链接（不跟随链接），KeepPath 自身不列入。
function Get-LiveLinkPaths {
    param([string]$Root, [string]$KeepPath)
    $found = @()
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $found }
    $keepFull = ''
    if ($KeepPath) { $keepFull = [IO.Path]::GetFullPath($KeepPath) }
    $queue = New-Object System.Collections.Queue
    $queue.Enqueue($Root)
    while ($queue.Count -gt 0) {
        $dir = [string]$queue.Dequeue()
        foreach ($item in @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)) {
            $full = [IO.Path]::GetFullPath($item.FullName)
            if ($keepFull -and $full.Equals($keepFull, [System.StringComparison]::OrdinalIgnoreCase)) { continue }
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                $found += $full
            } elseif ($item.PSIsContainer) {
                $queue.Enqueue($full)
            }
        }
    }
    return $found
}

# 只删除链接本身，绝不递归进入目标目录。
function Remove-LiveLinkPath {
    param([string]$Path)
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
        throw ('不是目录链接，拒绝删除：{0}' -f $Path)
    }
    if ($item.PSIsContainer) {
        [System.IO.Directory]::Delete($Path, $false)
    } else {
        [System.IO.File]::Delete($Path)
    }
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
    Write-Host ' DeepSeek Harness 崩溃恢复' -ForegroundColor Cyan
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
    # Windows 长路径支持：未启用时深层目录可能失败，仅提示，不回档中止
    # -----------------------------------------------------------------------
    $LongPathsEnabled = $null
    try {
        $longPathsValue = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' -Name 'LongPathsEnabled' -ErrorAction Stop
        $LongPathsEnabled = [int]$longPathsValue.LongPathsEnabled
    } catch {
        $LongPathsEnabled = $null
    }
    if ($LongPathsEnabled -eq 0) {
        Write-Host '警告：Windows 长路径支持未启用（LongPathsEnabled=0）。备份或回档包含深层目录时可能因路径过长失败；建议把 HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled 设为 1 并重启后再操作。' -ForegroundColor Yellow
        Write-Log '警告：Windows 长路径支持未启用（LongPathsEnabled=0），继续回档。'
    }

    # -----------------------------------------------------------------------
    # 模式选择：未显式传 -Mode 时（双击 RESTORE.cmd）由用户选择回档方式
    # -----------------------------------------------------------------------
    if (-not $ModeExplicit) {
        Write-Host ''
        Write-Host '============================' -ForegroundColor Cyan
        Write-Host '请选择回档方式' -ForegroundColor Cyan
        Write-Host '  1. 完整回档（恢复 DSH 安装、插件与用户配置）' -ForegroundColor Cyan
        Write-Host '  2. 仅回滚插件（只恢复插件，不动 DSH 与用户数据）' -ForegroundColor Cyan
        Write-Host '============================' -ForegroundColor Cyan
        while ($true) {
            if ([Console]::IsInputRedirected) {
                # 输入被重定向时 Read-Host 会与外层争用同一缓冲区，改用
                # Console.In 逐行读取；读到 EOF 返回 $null，按取消处理。
                Write-Host '输入 1 或 2'
                $choice = [Console]::In.ReadLine()
            } else {
                $choice = [string](Read-Host '输入 1 或 2')
            }
            if ($null -eq $choice) {
                Write-Host '已取消回档：未修改任何文件。' -ForegroundColor Yellow
                Write-Log '输入结束，未选择回档方式，回档取消。'
                Wait-AnyKey
                exit 0
            }
            $choice = $choice.Trim()
            if ($choice -eq '1') { $Mode = 'full'; break }
            if ($choice -eq '2') { $Mode = 'plugins'; break }
            Write-Host '输入无效：请重新输入 1 或 2。' -ForegroundColor Yellow
        }
    }
    $ModeLabel = if ($Mode -eq 'plugins') { '仅回滚插件' } else { '完整回档' }
    Write-Log ('回档模式：{0}' -f $Mode)

    # -----------------------------------------------------------------------
    # 回档租约：确认之前写入，所有退出路径（finally）删除。
    # 设置页只要看到该文件就保持 busy，避免 120 秒进程内锁在用户停留于
    # Y/N 提示时提前释放，让第二个回档/备份并发启动。
    # -----------------------------------------------------------------------
    $script:LeasePath = Join-Path $BackupRoot '_restore-in-progress.json'
    try {
        $leaseBody = [ordered]@{
            id = $SaveId
            mode = $Mode
            startedAt = (Get-Date).ToString('o')
            pid = $PID
        } | ConvertTo-Json -Compress
        Set-Content -LiteralPath $script:LeasePath -Value $leaseBody -Encoding UTF8 -ErrorAction Stop
        Write-Log ('回档进行中标记：{0}' -f $script:LeasePath)
    } catch {
        throw ('无法写入回档进行中标记：{0}（{1}）。回档中止。' -f $script:LeasePath, $_.Exception.Message)
    }

    # -----------------------------------------------------------------------
    # 仅回滚插件：说明恢复范围，并在 DSH 版本不一致时提示兼容性风险
    # -----------------------------------------------------------------------
    if ($Mode -eq 'plugins') {
        Write-Host ''
        Write-Host '仅回滚插件：只恢复插件 profile（package.json、锁文件、patch 与 node_modules）。' -ForegroundColor Yellow
        Write-Host 'DSH 安装目录、用户数据与插件数据保持不变，DSH 版本也不会回退。' -ForegroundColor Yellow
        Write-Log '仅回滚插件：只恢复插件 profile；插件数据、用户数据、安装目录与 DSH 版本保持不变。'
        if ($CurrentDshVersion -ne 'unknown' -and $SavedDshVersion -and $CurrentDshVersion -ne $SavedDshVersion) {
            Write-Host ('兼容性警告：存档 DSH 版本 {0} 与当前版本 {1} 不同，回档后的插件可能无法加载；如遇到问题请改用完整回档。' -f $SavedDshVersion, $CurrentDshVersion) -ForegroundColor Yellow
            Write-Log ('兼容性警告：DSH 版本不一致（存档 {0}，当前 {1}），继续执行仅插件回档。' -f $SavedDshVersion, $CurrentDshVersion)
        }
    }

    # -----------------------------------------------------------------------
    # 确认：任何修改之前必须得到明确的 Y/y
    # -----------------------------------------------------------------------
    Write-Host ''
    Write-Host '警告：回档后当前 DSH 状态无法恢复。' -ForegroundColor Red
    Write-Host ('即将执行：{0}' -f $ModeLabel) -ForegroundColor Yellow
    Write-Host ('即将把 DSH 恢复到存档 {0} 的状态。' -f $SaveId) -ForegroundColor Yellow
    $confirm = Read-Answer '是否继续？输入 Y 继续，输入 N 或其它内容取消 [Y/N]'
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

    # 注意：Windows PowerShell 5.1 在 $ErrorActionPreference = 'Stop' 下会把
    # 原生命令的 stderr 当成终止错误。这里临时放宽，先拿到退出码，再用自己的
    # 可读文案中止，避免把 tar 的英文报错直接抛给用户。
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $archiveEntries = @(& $TarPath -tf $ZipPath 2>$null)
        $tarListExit = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $previousErrorAction
    }
    if ($tarListExit -ne 0) {
        throw '无法读取存档压缩包，文件可能已损坏。'
    }
    $hasManifest = $false
    $hasProfileEntry = $false
    $profileEntry = 'profile/{0}' -f $SavedProfile
    foreach ($entry in $archiveEntries) {
        $normalized = ([string]$entry) -replace '^\./', ''
        if ($normalized -eq 'manifest.json') { $hasManifest = $true }
        if ($normalized -eq $profileEntry -or $normalized -eq ($profileEntry + '/') -or $normalized.StartsWith($profileEntry + '/')) {
            $hasProfileEntry = $true
        }
    }
    if (-not $hasManifest) {
        throw '存档中缺少 manifest.json，压缩包不完整。'
    }
    if ($Mode -eq 'plugins' -and (-not $HasProfile -or -not $hasProfileEntry)) {
        throw ('存档不包含插件 profile（{0}），无法仅回滚插件。未修改任何文件。' -f $profileEntry)
    }

    $zipBytes = (Get-Item -LiteralPath $ZipPath).Length
    $estimatedBytes = [int64]($zipBytes * 3) + 536870912
    $freeBackup = Get-FreeBytes $BackupRoot
    if ($freeBackup -ge 0 -and $freeBackup -lt $estimatedBytes) {
        throw ('备份目录所在磁盘空间不足：需要约 {0}，当前可用 {1}。' -f (Format-Size $estimatedBytes), (Format-Size $freeBackup))
    }

    # 每个恢复目标所在卷至少需要 256 MB 可用空间：完整回档检查安装目录、
    # profile 与用户目录；仅插件模式只写 profile，不检查安装目录。
    $MinimumTargetBytes = [int64]268435456
    $spaceTargets = @(@{ Path = $ProfileDir; Label = '插件 profile 目录' })
    if ($Mode -eq 'full') {
        $spaceTargets += @{ Path = $InstallDir; Label = '安装目录' }
        $spaceTargets += @{ Path = $HomeDir; Label = '用户目录' }
    }
    $checkedVolumes = @{}
    foreach ($spaceTarget in $spaceTargets) {
        $spaceFullPath = [IO.Path]::GetFullPath($spaceTarget.Path)
        $spaceVolume = [IO.Path]::GetPathRoot($spaceFullPath).ToUpperInvariant()
        if ($checkedVolumes.ContainsKey($spaceVolume)) { continue }
        $checkedVolumes[$spaceVolume] = $true
        $freeTarget = Get-FreeBytes $spaceTarget.Path
        if ($freeTarget -ge 0 -and $freeTarget -lt $MinimumTargetBytes) {
            throw ('{0}所在磁盘空间不足：至少需要 256 MB 可用空间，当前可用 {1}。' -f $spaceTarget.Label, (Format-Size $freeTarget))
        }
        Write-Log ('空间校验：{0} 可用 {1}。' -f $spaceTarget.Label, (Format-Size $freeTarget))
    }
    Write-Log ('空间校验通过：备份盘可用 {0}。' -f (Format-Size $freeBackup))

    # -----------------------------------------------------------------------
    # 回档前快照：当前关键配置另存，失败则中止
    # -----------------------------------------------------------------------
    $snapshotStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    if ($Mode -eq 'plugins') {
        # 仅插件模式：只快照当前 profile 的三个配置文件。
        $SnapshotRoot = Join-Path (Join-Path $BackupRoot '_pre-restore') ('{0}-plugins' -f $snapshotStamp)
        $snapshotItems = @(
            @{ Source = (Join-Path $ProfileDir 'package.json'); Destination = (Join-Path $SnapshotRoot 'package.json') },
            @{ Source = (Join-Path $ProfileDir 'pnpm-lock.yaml'); Destination = (Join-Path $SnapshotRoot 'pnpm-lock.yaml') },
            @{ Source = (Join-Path $ProfileDir 'cordis.patch.yml'); Destination = (Join-Path $SnapshotRoot 'cordis.patch.yml') }
        )
    } else {
        # 完整回档：快照 home 与 profile 的关键配置。
        $SnapshotRoot = Join-Path (Join-Path $BackupRoot '_pre-restore') $snapshotStamp
        $snapshotItems = @(
            @{ Source = (Join-Path $HomeDir 'cordis.patch.yml'); Destination = (Join-Path $SnapshotRoot 'home\cordis.patch.yml') },
            @{ Source = (Join-Path $HomeDir 'settings.yaml'); Destination = (Join-Path $SnapshotRoot 'home\settings.yaml') },
            @{ Source = (Join-Path $ProfileDir 'package.json'); Destination = (Join-Path $SnapshotRoot 'profile\package.json') },
            @{ Source = (Join-Path $ProfileDir 'pnpm-lock.yaml'); Destination = (Join-Path $SnapshotRoot 'profile\pnpm-lock.yaml') },
            @{ Source = (Join-Path $ProfileDir 'cordis.patch.yml'); Destination = (Join-Path $SnapshotRoot 'profile\cordis.patch.yml') }
        )
    }
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
    # 停止正在运行的 DSH（按可执行文件路径识别，先询问，确认后重新检测）
    # -----------------------------------------------------------------------
    $detectedProcesses = @(Get-DshProcesses -Root $InstallDir)
    if ($detectedProcesses.Count -gt 0) {
        Write-Host ''
        Write-Host '检测到 DeepSeek Harness 正在运行，回档前必须关闭：' -ForegroundColor Yellow
        foreach ($process in $detectedProcesses) {
            Write-Host ('  PID {0}  {1}' -f $process.Id, $process.ProcessName) -ForegroundColor Yellow
            Write-Log ('检测到 DSH 进程：PID {0} {1}' -f $process.Id, $process.ProcessName)
        }
        $stopAnswer = Read-Answer '是否结束这些进程并继续回档？[Y/N]'
        if ($stopAnswer -notmatch '^[Yy]$') {
            Write-Host '已取消回档：未修改任何文件。' -ForegroundColor Yellow
            Write-Log '用户拒绝结束 DSH 进程，回档中止，未修改任何文件。'
            Wait-AnyKey
            exit 0
        }
        # 等待用户输入期间进程可能退出、PID 也可能被复用，确认后必须重新读取。
        $dshProcesses = @(Get-DshProcesses -Root $InstallDir)
        if ($dshProcesses.Count -eq 0) {
            Write-Log 'DSH 进程已自行退出，继续回档。'
        } else {
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
        }
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
    if ($Mode -eq 'plugins') {
        # 只解出插件 profile 与 manifest.json；安装目录、用户目录与运行时都不解压。
        $profileMember = 'profile/{0}' -f $SavedProfile
        & $TarPath -xf $ZipPath -C $script:TempDir $profileMember
        if ($LASTEXITCODE -ne 0) {
            throw ('tar 解压插件 profile 失败（退出码 {0}）。' -f $LASTEXITCODE)
        }
        & $TarPath -xf $ZipPath -C $script:TempDir 'manifest.json'
        if ($LASTEXITCODE -ne 0) {
            throw ('tar 解压 manifest.json 失败（退出码 {0}）。' -f $LASTEXITCODE)
        }
    } else {
        & $TarPath -xf $ZipPath -C $script:TempDir
        if ($LASTEXITCODE -ne 0) {
            throw ('tar 解压失败（退出码 {0}）。' -f $LASTEXITCODE)
        }
    }

    if ($Mode -eq 'full') {
        $extractedInstall = Join-Path $script:TempDir 'install'
        if (-not (Test-Path -LiteralPath $extractedInstall -PathType Container)) {
            throw '解压后缺少 install 目录，存档不完整，回档中止。'
        }
    }
    $extractedProfile = Join-Path (Join-Path $script:TempDir 'profile') $SavedProfile
    if ($HasProfile -and -not (Test-Path -LiteralPath $extractedProfile -PathType Container)) {
        throw ('解压后缺少 profile/{0} 目录，存档不完整，回档中止。' -f $SavedProfile)
    }

    # -----------------------------------------------------------------------
    # 先校验 manifest 与 links，再做任何 robocopy：损坏的存档不能造成半恢复
    # -----------------------------------------------------------------------
    $manifestPath = Join-Path $script:TempDir 'manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw '解压后缺少 manifest.json，无法重建插件依赖链接，回档中止。'
    }
    $manifest = $null
    try {
        $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
        $manifest = $null
    }
    if (-not $manifest) {
        throw '无法解析 manifest.json，存档可能已损坏，回档中止。'
    }
    if ($manifest.links -isnot [System.Array]) {
        throw 'manifest.json 的 links 不是数组，存档可能已损坏，回档中止。'
    }
    $profileFull = [IO.Path]::GetFullPath($ProfileDir)
    $profilePrefix = $profileFull
    while ($profilePrefix.EndsWith('\') -or $profilePrefix.EndsWith('/')) {
        $profilePrefix = $profilePrefix.Substring(0, $profilePrefix.Length - 1)
    }
    $profilePrefix = $profilePrefix + '\'
    $LinkRecords = @()
    $linkExclusions = @()
    foreach ($link in @($manifest.links)) {
        $relativePath = [string]$link.path
        $target = ([string]$link.target).TrimEnd([char[]]@('\', '/'))
        if (-not $relativePath -or -not $target) {
            throw 'manifest.json 中存在缺少 path 或 target 的链接，回档中止。'
        }
        if ([IO.Path]::IsPathRooted($relativePath)) {
            throw ('manifest.json 中的链接路径无效：{0}' -f $relativePath)
        }
        $destination = [IO.Path]::GetFullPath((Join-Path $ProfileDir ($relativePath -replace '/', '\')))
        if (-not $destination.StartsWith($profilePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw ('manifest.json 中的链接指向 profile 之外，回档中止：{0}' -f $relativePath)
        }
        $LinkRecords += [pscustomobject]@{
            Destination = $destination
            Target = $target
        }
        $linkExclusions += $destination
    }
    Write-Log ('manifest 校验通过：{0} 个链接待重建。' -f $LinkRecords.Count)

    $profilesDir = Join-Path $HomeDir 'profiles'
    $profileNodeModules = Join-Path $ProfileDir 'node_modules'

    # 任何 profile 镜像之前，先移除现存目录链接本身（保留链接目标）。
    # /XD 对嵌套目录不可靠，先断开链接可保证 robocopy 不可能写到 profile 之外。
    if ($HasProfile) {
        $liveLinks = @(Get-LiveLinkPaths -Root $profileNodeModules -KeepPath $SelfPluginDir)
        if ($liveLinks.Count -gt 0) {
            Write-Log ('移除 {0} 个现有目录链接，避免 robocopy 写入链接目标...' -f $liveLinks.Count)
            foreach ($liveLink in $liveLinks) {
                Remove-LiveLinkPath -Path $liveLink
                if ($linkExclusions -notcontains $liveLink) { $linkExclusions += $liveLink }
            }
        }
    }

    if ($Mode -eq 'full') {
        Write-Log '恢复安装目录（镜像）...'
        Invoke-Robocopy -Source $extractedInstall -Destination $InstallDir -Mirror
    }

    if ($HasProfile) {
        # /XD 的绝对路径只可靠保护镜像根下第一层目录，且源目录也包含该目录时
        # 可能失效；这里同时按名称排除 node_modules 与本插件，node_modules 再
        # 单独镜像，使本插件目录成为那次镜像的第一层排除项。
        Write-Log '恢复插件 profile（镜像；node_modules 单独恢复）...'
        Invoke-Robocopy -Source $extractedProfile -Destination $ProfileDir -Mirror -ExcludeDirs @($SelfPluginDir, $profileNodeModules, 'node_modules', 'dsh-crash-backup')
        $extractedNodeModules = Join-Path $extractedProfile 'node_modules'
        if (Test-Path -LiteralPath $extractedNodeModules -PathType Container) {
            $nodeModulesExclusions = @($SelfPluginDir, 'dsh-crash-backup') + $linkExclusions
            Write-Log '恢复 profile 的 node_modules（镜像，排除本插件与所有链接路径）...'
            Invoke-Robocopy -Source $extractedNodeModules -Destination $profileNodeModules -Mirror -ExcludeDirs $nodeModulesExclusions
        } else {
            Write-Log '存档未包含 profile 的 node_modules，保留现有依赖。'
        }
    } else {
        Write-Log '存档不包含插件 profile，跳过 profile 恢复。'
    }

    if ($Mode -eq 'full') {
        $extractedHome = Join-Path $script:TempDir 'home'
        if (Test-Path -LiteralPath $extractedHome -PathType Container) {
            Write-Log '恢复用户目录（覆盖，排除 profiles 与 dsh-crash-backup）...'
            Invoke-Robocopy -Source $extractedHome -Destination $HomeDir -ExcludeDirs @('dsh-crash-backup', $profilesDir, 'profiles')
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

        # 其它 profile（dsh-tui、headless）只归档配置文件：逐文件覆盖复制到
        # <home>\profiles\<name>\，存档里没有的文件保持现状（不做镜像删除）。
        $extractedOthers = Join-Path (Join-Path $script:TempDir 'profile') 'others'
        if (Test-Path -LiteralPath $extractedOthers -PathType Container) {
            Write-Log '恢复其它 profile 的配置文件（覆盖复制，仅复制存档中存在的文件）...'
            foreach ($otherProfileDir in @(Get-ChildItem -LiteralPath $extractedOthers -Directory -Force -ErrorAction SilentlyContinue)) {
                $otherTargetDir = Join-Path (Join-Path $HomeDir 'profiles') $otherProfileDir.Name
                $otherFiles = @(Get-ChildItem -LiteralPath $otherProfileDir.FullName -File -Force -ErrorAction SilentlyContinue)
                if ($otherFiles.Count -eq 0) { continue }
                New-Item -ItemType Directory -Path $otherTargetDir -Force | Out-Null
                foreach ($otherFile in $otherFiles) {
                    Copy-Item -LiteralPath $otherFile.FullName -Destination (Join-Path $otherTargetDir $otherFile.Name) -Force
                }
                Write-Log ('已恢复其它 profile 配置：{0}（{1} 个文件）' -f $otherTargetDir, $otherFiles.Count)
            }
        } else {
            Write-Log '存档不包含其它 profile 的配置，跳过。'
        }
    }

    # -----------------------------------------------------------------------
    # 按预先校验过的 links 重建 junction
    # New-Item -ItemType Junction 等价于 cmd /c mklink /J "<dest>" "<target>"，
    # 但不受 cmd.exe 的引号与 & 解析规则影响。
    # -----------------------------------------------------------------------
    if ($HasProfile) {
        $skippedLinks = 0
        foreach ($record in $LinkRecords) {
            $destination = $record.Destination
            $target = $record.Target
            if (-not [IO.Path]::IsPathRooted($target)) {
                $target = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $destination) $target))
            }
            # 链接目标可能在备份之后被删除（例如插件源码目录被移动）：此时
            # junction 无法创建。跳过该链接并继续，不能因此让整个回档失败。
            if (-not (Test-Path -LiteralPath $target)) {
                Write-Host ('警告：链接目标不存在，已跳过：{0} -> {1}' -f $destination, $target) -ForegroundColor Yellow
                Write-Log ('警告：链接目标不存在，跳过重建：{0} -> {1}' -f $destination, $target)
                $skippedLinks++
                continue
            }
            $parent = Split-Path -Parent $destination
            if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
            if (Test-Path -LiteralPath $destination) {
                $existing = Get-Item -LiteralPath $destination -Force
                if (($existing.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    Remove-LiveLinkPath -Path $destination
                } else {
                    Remove-Item -LiteralPath $destination -Recurse -Force
                }
            }
            try {
                New-Item -ItemType Junction -Path $destination -Target $target -ErrorAction Stop | Out-Null
            } catch {
                throw ('重建 junction 失败：{0} -> {1}（{2}）' -f $destination, $target, $_.Exception.Message)
            }
            Write-Log ('已重建链接：{0} -> {1}' -f $destination, $target)
        }
        if ($skippedLinks -gt 0) {
            Write-Host ('警告：{0} 个链接因目标不存在被跳过，相关插件可能需要重新安装。' -f $skippedLinks) -ForegroundColor Yellow
            Write-Log ('警告：{0} 个链接目标不存在，已跳过重建。' -f $skippedLinks)
        }
    } elseif ($LinkRecords.Count -gt 0) {
        Write-Log '存档不包含 profile，跳过链接重建。'
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
    if ($Mode -eq 'plugins') {
        Write-Host '插件回档完成：插件 profile 已恢复到存档状态。' -ForegroundColor Green
        Write-Host 'DSH 安装目录与用户数据未被改动；请关闭所有 DSH 窗口并重新启动 DeepSeek Harness，以加载回档后的插件。' -ForegroundColor Green
    } else {
        Write-Host '回档完成。' -ForegroundColor Green
        Write-Host '请关闭所有 DSH 窗口并重新启动 DeepSeek Harness。' -ForegroundColor Green
    }
    Write-Host ('日志文件：{0}' -f $script:LogPath) -ForegroundColor DarkGray
    if ($Mode -eq 'plugins') {
        Write-Log '仅插件回档完成，请重启 DSH 加载回档后的插件。'
    } else {
        Write-Log '回档完成，请重启 DSH。'
    }
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
} finally {
    # 所有退出路径（成功、取消、失败）都删除租约，让设置页恢复空闲。
    if ($script:LeasePath) {
        try {
            Remove-Item -LiteralPath $script:LeasePath -Force -ErrorAction Stop
        } catch {
            if (Test-Path -LiteralPath $script:LeasePath) {
                Write-Host ('警告：无法删除回档进行中标记，请手动删除：{0}' -f $script:LeasePath) -ForegroundColor Yellow
            }
        }
    }
}
`
}
