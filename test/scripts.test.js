import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  renderBackupReadme,
  renderRestoreCmd,
  renderRestorePs1,
  restoreScriptNames,
} from '../lib/scripts.js'

const meta = {
  id: 'dsh-save-20261024-090000',
  createdAt: '2026-10-24T09:00:00.000Z',
  dshVersion: '44.7.0',
  installDir: 'C:\\tool\\dsh',
  home: 'C:\\Users\\a\\.dsh',
  profile: 'desktop',
  backupRoot: 'C:\\tool\\dsh-backups',
  hasProfile: true,
}

// 仅插件分支独有的文案与结构锚点：菜单里的「2. 仅回滚插件…」不含这些更长
// 文本，因此不会误命中菜单行；`$ModeLabel` 也包含 `$Mode -eq 'plugins'`，
// 定位分支时必须使用整行文案而不是条件表达式。
const PLUGIN_SCOPE =
  "Write-Host '仅回滚插件：只恢复插件 profile（package.json、锁文件、patch 与 node_modules）。'"
const PLUGIN_PREFLIGHT =
  "if ($Mode -eq 'plugins' -and (-not $HasProfile -or -not $hasProfileEntry))"
const PLUGIN_SNAPSHOT = "('{0}-plugins' -f $snapshotStamp)"
const FULL_GATE = "if ($Mode -eq 'full') {"
const MENU_GATE = 'if (-not $ModeExplicit)'
const MENU_END = "$ModeLabel = if ($Mode -eq 'plugins')"

const POWERSHELL = join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
)

test('restore script asks before touching anything', () => {
  const ps1 = renderRestorePs1(meta)
  assert.match(ps1, /是否继续/)
  assert.match(ps1, /ReadKey/)
  assert.match(ps1, /任意键/)
  assert.match(ps1, /-Mode/)
  assert.match(ps1, /robocopy/i)
  assert.match(ps1, /\/XD/i)
  assert.match(ps1, /mklink/i)
  assert.match(ps1, /DeepSeek Harness/)
  assert.match(ps1, /Read-Host/)
  assert.match(ps1, /_restore-tmp/)
  assert.match(ps1, /_pre-restore/)
})

test('plugins mode is a real restore branch instead of the old exit-2 stub', () => {
  const ps1 = renderRestorePs1(meta)
  assert.equal(ps1.includes('插件级回档尚未启用'), false)
  assert.equal(ps1.includes('exit 2'), false)
  assert.match(ps1, /#Requires -Version 5\.1/)
  assert.match(ps1, /\[ValidateSet\('full', 'plugins'\)\]/)
  assert.match(ps1, /\$PayloadRoot = \$PSScriptRoot/)
  assert.match(ps1, /manifest\.json/)
  assert.ok(ps1.includes(PLUGIN_SCOPE), 'plugins mode must print its restore scope')
  assert.ok(ps1.includes(PLUGIN_PREFLIGHT), 'plugins mode must preflight the archive profile')
})

test('plugins mode warns about its limited scope and DSH version risk', () => {
  const ps1 = renderRestorePs1(meta)
  const scope = ps1.indexOf(PLUGIN_SCOPE)
  const confirm = ps1.indexOf('$confirm = Read-Answer')
  assert.ok(scope > 0, 'plugins scope warning is missing')
  assert.ok(scope < confirm, 'plugins scope warning must come before the confirmation')

  const block = ps1.slice(scope, confirm)
  assert.match(block, /安装目录/)
  assert.match(block, /用户数据/)
  assert.match(block, /插件数据/)
  assert.match(block, /DSH 版本/)
  assert.match(block, /兼容性警告/)
  assert.ok(
    block.includes('$CurrentDshVersion -ne $SavedDshVersion'),
    'the compatibility warning must compare the current and saved DSH versions',
  )
})

test('plugins mode preflights the archive profile before the first write', () => {
  const ps1 = renderRestorePs1(meta)
  const preflight = ps1.indexOf(PLUGIN_PREFLIGHT)
  const snapshot = ps1.indexOf('$snapshotStamp = Get-Date')
  const extract = ps1.indexOf('$script:TempDir = Join-Path (Join-Path $BackupRoot')
  const install = ps1.indexOf('Invoke-Robocopy -Source $extractedInstall')

  assert.ok(preflight > 0, 'plugins profile preflight is missing')
  assert.ok(ps1.includes('& $TarPath -tf $ZipPath'), 'the preflight must list archive members')
  assert.ok(ps1.includes('$hasProfileEntry = $true'), 'the profile member must be detected')
  assert.ok(preflight < snapshot, 'the preflight must run before the snapshot')
  assert.ok(preflight < extract, 'the preflight must run before extraction')
  assert.ok(preflight < install, 'the preflight must run before any robocopy')

  const preflightBlock = ps1.slice(preflight, ps1.indexOf('\n    }', preflight))
  assert.match(preflightBlock, /throw/)

  // Missing profile / hasProfile=false exits 1 after Wait-AnyKey.
  const catchBlock = ps1.slice(ps1.lastIndexOf('} catch {'))
  assert.ok(catchBlock.includes('Wait-AnyKey'))
  assert.ok(catchBlock.includes('exit 1'))
})

test('plugins mode snapshots only the profile config with a -plugins suffix', () => {
  const ps1 = renderRestorePs1(meta)
  const snapshotStamp = ps1.indexOf('$snapshotStamp = Get-Date')
  const pluginStart = ps1.indexOf("if ($Mode -eq 'plugins') {", snapshotStamp)
  const elseStart = ps1.indexOf('} else {', pluginStart)
  const snapshotEnd = ps1.indexOf('New-Item -ItemType Directory -Path $SnapshotRoot', elseStart)
  assert.ok(snapshotStamp > 0, 'the snapshot block is missing')
  assert.ok(pluginStart > snapshotStamp, 'the plugin snapshot branch is missing')
  assert.ok(elseStart > pluginStart, 'the full snapshot branch is missing')
  assert.ok(snapshotEnd > elseStart, 'the snapshot block is not closed')

  const pluginSnapshot = ps1.slice(pluginStart, elseStart)
  assert.ok(pluginSnapshot.includes(PLUGIN_SNAPSHOT), 'the snapshot must use <timestamp>-plugins')
  for (const name of ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml']) {
    assert.ok(
      pluginSnapshot.includes(`Join-Path $ProfileDir '${name}'`),
      `the plugin snapshot is missing ${name}`,
    )
  }
  assert.equal(pluginSnapshot.includes('$HomeDir'), false, 'the plugin snapshot must not read home')

  const fullSnapshot = ps1.slice(elseStart, snapshotEnd)
  assert.ok(fullSnapshot.includes("Join-Path $HomeDir 'cordis.patch.yml'"))
  assert.ok(fullSnapshot.includes("Join-Path $HomeDir 'settings.yaml'"))
})

test('plugins mode extracts only the profile and manifest, never install/home/runtimes', () => {
  const ps1 = renderRestorePs1(meta)
  const profileMember = ps1.indexOf("$profileMember = 'profile/{0}' -f $SavedProfile")
  const fullExtract = ps1.indexOf('& $TarPath -xf $ZipPath -C $script:TempDir\n')
  assert.ok(profileMember > 0, 'plugin-only extraction is missing')
  assert.ok(fullExtract > profileMember, 'full extraction must stay in the else branch')

  const pluginExtract = ps1.slice(profileMember, fullExtract)
  assert.ok(pluginExtract.includes('& $TarPath -xf $ZipPath -C $script:TempDir $profileMember'))
  assert.ok(pluginExtract.includes("& $TarPath -xf $ZipPath -C $script:TempDir 'manifest.json'"))
  for (const forbidden of ['$extractedInstall', '$extractedHome', '$extractedRuntimes']) {
    assert.equal(pluginExtract.includes(forbidden), false, `${forbidden} must not be extracted`)
  }
})

test('install, home and runtimes restores are unreachable in plugins mode', () => {
  const ps1 = renderRestorePs1(meta)

  function guardedBlock(marker) {
    const markerIndex = ps1.indexOf(marker)
    assert.ok(markerIndex > 0, `${marker} is missing`)
    const gate = ps1.lastIndexOf(FULL_GATE, markerIndex)
    assert.ok(gate > 0, `${marker} must sit inside a full-mode guard`)
    const end = ps1.indexOf('\n    }', gate)
    assert.ok(end > markerIndex, `the full-mode guard around ${marker} must close`)
    return { gate, end }
  }

  const install = guardedBlock('Invoke-Robocopy -Source $extractedInstall')
  const home = guardedBlock('Invoke-Robocopy -Source $extractedHome')
  const runtimes = guardedBlock('Invoke-Robocopy -Source $extractedRuntimes')
  assert.ok(install.end < home.gate, 'install and home/runtimes need separate full-mode guards')
  assert.ok(home.end > runtimes.gate, 'home and runtimes share one full-mode guard')

  const profile = ps1.indexOf('Invoke-Robocopy -Source $extractedProfile')
  assert.ok(profile > install.end, 'profile restore must stay outside the full-only install guard')
})

test('restore script offers a mode menu only without explicit -Mode', () => {
  const ps1 = renderRestorePs1(meta)
  assert.ok(ps1.includes("$ModeExplicit = $PSBoundParameters.ContainsKey('Mode')"))
  assert.ok(ps1.includes(MENU_GATE))

  // 菜单及 1/2 循环必须整体位于 `-not $ModeExplicit` 分支内：从守卫条件
  // 到分支后的下一条语句之间取值，而不是只断言文本存在。
  const menuGate = ps1.indexOf(MENU_GATE)
  const menuEnd = ps1.indexOf(MENU_END)
  const branchStart = ps1.indexOf(PLUGIN_SCOPE)
  assert.ok(menuGate > 0, 'menu must be gated on explicit -Mode')
  assert.ok(ps1.slice(menuGate, menuGate + 40).includes('$ModeExplicit'))
  assert.ok(menuEnd > menuGate, 'menu branch end marker is missing')
  assert.ok(branchStart > menuEnd, 'menu must run before the plugins branch')
  const menuBlock = ps1.slice(menuGate, menuEnd)

  assert.match(menuBlock, /请选择回档方式/)
  assert.ok(menuBlock.includes('  1. 完整回档（恢复 DSH 安装、插件与用户配置）'))
  assert.ok(menuBlock.includes('  2. 仅回滚插件（只恢复插件，不动 DSH 与用户数据）'))
  assert.ok(menuBlock.includes('输入 1 或 2'))
  assert.ok(menuBlock.includes('while ($true)'), 'the menu must loop until a valid answer')

  const one = menuBlock.indexOf("$choice -eq '1'")
  const two = menuBlock.indexOf("$choice -eq '2'")
  assert.ok(one > 0, 'choice 1 must be handled')
  assert.ok(two > one, 'choice 2 must be handled after choice 1')
  assert.ok(menuBlock.indexOf("$Mode = 'full'") > one, 'choice 1 must map to full mode')
  assert.ok(menuBlock.indexOf("$Mode = 'plugins'") > two, 'choice 2 must map to plugins mode')
  assert.ok(menuBlock.includes('break'), 'the menu loop must exit after a valid choice')

  // EOF 必须在 Trim 之前判定：空串（空行）重新询问，$null（EOF）取消。
  const eofCheck = menuBlock.indexOf('$null -eq $choice')
  const trim = menuBlock.indexOf('$choice = $choice.Trim()')
  assert.ok(eofCheck > 0 && trim > eofCheck, 'EOF must be handled before trimming the answer')
  assert.ok(menuBlock.includes('[Console]::In.ReadLine()'), 'redirected input must use Console.In')
  assert.ok(menuBlock.includes('已取消回档'), 'EOF must cancel the restore')
  assert.ok(menuBlock.includes('Wait-AnyKey'))
  assert.ok(menuBlock.includes('exit 0'))
})

test('mode menu comes before the Y/N confirmation, which names the chosen mode', () => {
  const ps1 = renderRestorePs1(meta)
  const menu = ps1.indexOf('请选择回档方式')
  const question = ps1.indexOf('输入 1 或 2')
  const confirmPrompt = ps1.indexOf('$confirm = Read-Answer')
  const modeLine = ps1.indexOf('即将执行：')
  assert.ok(menu > 0, 'mode menu is missing')
  assert.ok(question > menu, 'menu must ask for 1 or 2')
  assert.ok(confirmPrompt > question, 'confirmation must come after the mode choice')
  assert.ok(modeLine > 0, 'confirmation must name the chosen mode')
  assert.ok(modeLine < confirmPrompt, 'the mode line belongs to the confirmation block')
  assert.ok(
    ps1.includes("Write-Host ('即将执行：{0}' -f $ModeLabel)"),
    'the confirmation must interpolate $ModeLabel',
  )
  assert.ok(ps1.includes("$ModeLabel = if ($Mode -eq 'plugins') { '仅回滚插件' } else { '完整回档' }"))
})

test('explicit -Mode skips the menu and plugins mode enters the real branch', () => {
  const ps1 = renderRestorePs1(meta)
  assert.match(ps1, /\[ValidateSet\('full', 'plugins'\)\]/)
  assert.match(ps1, /\[string\]\$Mode = 'full'/)

  // 菜单被 `-not $ModeExplicit` 分支包住，显式传 -Mode 时不会进入。
  const menuGate = ps1.indexOf(MENU_GATE)
  const menuEnd = ps1.indexOf(MENU_END)
  const menu = ps1.indexOf('请选择回档方式')
  assert.ok(menuGate > 0, 'menu gate is missing')
  assert.ok(menu > menuGate && menu < menuEnd, 'menu must sit inside the explicit-mode gate')

  // 显式 plugins 不再安全退出：范围提示必须出现在确认之前，旧 stub 必须消失。
  const scope = ps1.indexOf(PLUGIN_SCOPE)
  const confirmPrompt = ps1.indexOf('$confirm = Read-Answer')
  assert.ok(scope > 0, 'plugins scope warning is missing')
  assert.ok(scope < confirmPrompt, 'plugins scope warning must come before the confirmation')
  assert.equal(ps1.includes('插件级回档尚未启用'), false)
  assert.equal(ps1.includes('exit 2'), false)
})

test('manifest links are validated before the first robocopy', () => {
  const ps1 = renderRestorePs1(meta)
  const linksCheck = ps1.indexOf('$manifest.links -isnot [System.Array]')
  const containmentCheck = ps1.indexOf('StartsWith($profilePrefix')
  const firstRobocopy = ps1.indexOf('Invoke-Robocopy -Source $extractedInstall')
  assert.ok(linksCheck > 0, 'links array validation is missing')
  assert.ok(containmentCheck > linksCheck, 'link path containment must follow the shape check')
  assert.ok(firstRobocopy > containmentCheck, 'manifest validation must run before robocopy')
  assert.match(ps1, /指向 profile 之外/)
  assert.match(ps1, /\[IO\.Path\]::IsPathRooted\(\$relativePath\)/)
})

test('node_modules restore excludes every manifest link path', () => {
  const ps1 = renderRestorePs1(meta)
  assert.ok(ps1.includes('$linkExclusions += $destination'))
  assert.ok(ps1.includes("$nodeModulesExclusions = @($SelfPluginDir, 'dsh-crash-backup') + $linkExclusions"))
  assert.ok(ps1.includes('-ExcludeDirs $nodeModulesExclusions'))
  assert.match(ps1, /Get-LiveLinkPaths -Root \$profileNodeModules -KeepPath \$SelfPluginDir/)
  assert.match(ps1, /Remove-LiveLinkPath -Path \$liveLink/)
  assert.ok(
    ps1.indexOf('Remove-LiveLinkPath -Path $liveLink') <
      ps1.indexOf('Invoke-Robocopy -Source $extractedInstall'),
    'live links must be removed before the first robocopy',
  )
})

test('home copy cannot override the restored profile', () => {
  const ps1 = renderRestorePs1(meta)
  assert.match(ps1, /-ExcludeDirs @\('dsh-crash-backup', \$profilesDir, 'profiles'\)/)
})

test('restore script rebuilds junctions without cmd quoting traps', () => {
  const ps1 = renderRestorePs1(meta)
  assert.match(ps1, /New-Item -ItemType Junction/)
  assert.match(ps1, /Remove-LiveLinkPath/)
  assert.equal(ps1.includes('cmd.exe /c mklink'), false)
  assert.equal(ps1.includes('cmd.exe /c rmdir'), false)
})

test('processes are re-detected after confirmation and prompts are guarded', () => {
  const ps1 = renderRestorePs1(meta)
  const prompt = ps1.indexOf('$stopAnswer = Read-Answer')
  const redetect = ps1.indexOf('$dshProcesses = @(Get-DshProcesses -Root $InstallDir)')
  assert.ok(prompt > 0, 'process confirmation prompt is missing')
  assert.ok(redetect > prompt, 'DSH processes must be re-detected after confirmation')
  assert.match(ps1, /\[Console\]::IsInputRedirected/)
  assert.match(ps1, /function Read-Answer/)
  assert.match(ps1, /\[System\.IO\.Directory\]::Delete/)
})

test('restore script embeds save metadata as literal strings', () => {
  const ps1 = renderRestorePs1({ ...meta, installDir: "C:\\O'Brien\\dsh" })
  assert.ok(ps1.includes("$SavedInstallDir = 'C:\\O''Brien\\dsh'"))
  assert.ok(ps1.includes("$SaveId = 'dsh-save-20261024-090000'"))
})

test('cmd entry switches to utf8 code page', () => {
  assert.match(renderRestoreCmd(), /chcp 65001/)
})

test('cmd entry stays ascii and calls ps1', () => {
  const cmd = renderRestoreCmd()
  assert.match(cmd, /RESTORE\.ps1/)
  assert.equal(/[^\x00-\x7F]/.test(cmd), false)
})

test('restore script names are stable', () => {
  assert.deepEqual(restoreScriptNames(), { ps1: 'RESTORE.ps1', cmd: 'RESTORE.cmd' })
})

test('backup readme explains restore, modes and credential risk', () => {
  const readme = renderBackupReadme(meta)
  assert.match(readme, /崩溃/)
  assert.match(readme, /完整回档/)
  assert.match(readme, /仅回滚插件/)
  assert.match(readme, /\.credentials\.yaml/)
  assert.match(readme, /RESTORE\.cmd/)
  assert.match(readme, /dsh-backups/)
  assert.match(readme, /空间/)
})

test(
  'generated restore script parses as PowerShell',
  { skip: !existsSync(POWERSHELL) },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-scripts-'))
    t.after(async () => {
      await rm(dir, { recursive: true, force: true })
    })

    const file = join(dir, 'RESTORE.ps1')
    await writeFile(file, `\uFEFF${renderRestorePs1(meta)}`, 'utf8')

    // Same check the brief prescribes; production writes the BOM, this test
    // feeds a BOM-prefixed file to PowerShell exactly like the save folder.
    const command =
      `$t=[IO.File]::ReadAllText('${file.replace(/'/g, "''")}'); ` +
      `[void][ScriptBlock]::Create($t); 'OK'`
    const result = spawnSync(POWERSHELL, ['-NoProfile', '-Command', command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    })

    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /OK/)
  },
)
