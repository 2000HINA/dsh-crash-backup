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
