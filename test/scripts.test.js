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

// 守卫分支独有的输出行：`$ModeLabel = if ($Mode -eq 'plugins')` 也包含
// `if ($Mode -eq 'plugins')`，用它定位守卫会误命中那一行。
const PLUGINS_GUARD = "Write-Host '插件级回档尚未启用：本脚本目前只支持完整回档。'"
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

test('restore script refuses plugin mode without touching the environment', () => {
  const ps1 = renderRestorePs1(meta)
  assert.match(ps1, /插件级回档尚未启用/)
  assert.match(ps1, /exit 2/)
  assert.match(ps1, /#Requires -Version 5\.1/)
  assert.match(ps1, /\[ValidateSet\('full', 'plugins'\)\]/)
  assert.match(ps1, /\$PayloadRoot = \$PSScriptRoot/)
  assert.match(ps1, /manifest\.json/)
})

test('restore script offers a mode menu only without explicit -Mode', () => {
  const ps1 = renderRestorePs1(meta)
  assert.ok(ps1.includes("$ModeExplicit = $PSBoundParameters.ContainsKey('Mode')"))
  assert.ok(ps1.includes(MENU_GATE))

  // 菜单及 1/2 循环必须整体位于 `-not $ModeExplicit` 分支内：从守卫条件
  // 到分支后的下一条语句之间取值，而不是只断言文本存在。
  const menuGate = ps1.indexOf(MENU_GATE)
  const menuEnd = ps1.indexOf(MENU_END)
  const guardStart = ps1.indexOf(PLUGINS_GUARD)
  assert.ok(menuGate > 0, 'menu must be gated on explicit -Mode')
  assert.ok(ps1.slice(menuGate, menuGate + 40).includes('$ModeExplicit'))
  assert.ok(menuEnd > menuGate, 'menu branch end marker is missing')
  assert.ok(guardStart > menuEnd, 'menu must run before the plugins guard')
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

test('explicit -Mode skips the menu and the plugins guard exits 2 before confirmation', () => {
  const ps1 = renderRestorePs1(meta)
  assert.match(ps1, /\[ValidateSet\('full', 'plugins'\)\]/)
  assert.match(ps1, /\[string\]\$Mode = 'full'/)

  // 菜单被 `-not $ModeExplicit` 分支包住，显式传 -Mode 时不会进入。
  const menuGate = ps1.indexOf(MENU_GATE)
  const menuEnd = ps1.indexOf(MENU_END)
  const menu = ps1.indexOf('请选择回档方式')
  assert.ok(menuGate > 0, 'menu gate is missing')
  assert.ok(menu > menuGate && menu < menuEnd, 'menu must sit inside the explicit-mode gate')

  // 用守卫独有的输出行定位，避免误命中 `$ModeLabel` 那一行；守卫必须在
  // 确认提示之前以 exit 2 结束。
  const guard = ps1.indexOf(PLUGINS_GUARD)
  const confirmPrompt = ps1.indexOf('$confirm = Read-Answer')
  const exitTwo = ps1.indexOf('exit 2', guard)
  assert.ok(guard > 0, 'plugins guard is missing')
  assert.ok(guard < confirmPrompt, 'plugins guard must exit before the confirmation')
  assert.ok(exitTwo > guard && exitTwo < confirmPrompt, 'the guard must exit 2 before the confirmation')
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
