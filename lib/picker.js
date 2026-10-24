/**
 * Native folder picker. Windows has no dialog accessible from a plain Node
 * process, so a short PowerShell script drives Windows Forms in an STA process
 * and prints the chosen path to stdout.
 */
import { spawn } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** Quote a value for a single-quoted PowerShell string (quote doubling only). */
function psQuote(value) {
  return `'${value.replace(/'/g, "''")}'`
}

/**
 * Build the picker script. `initial` is embedded only inside a single-quoted
 * PowerShell string and CR/LF are stripped, so it cannot break out of it.
 */
function buildScript(initial) {
  const start = typeof initial === 'string' ? initial.replace(/[\r\n]/g, '').trim() : ''
  const preset = start ? `  $dialog.SelectedPath = ${psQuote(start)}\n` : ''

  return `Add-Type -AssemblyName System.Windows.Forms

# Windows PowerShell 5.1 writes redirected stdout in the OEM code page; force
# UTF-8 so Node receives Chinese paths intact.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

# Off-screen, taskbar-less owner keeps the dialog above the DSH window.
$owner = New-Object System.Windows.Forms.Form
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.FormBorderStyle = 'None'
$owner.StartPosition = 'Manual'
$owner.Left = -2000
$owner.Top = -2000
$owner.Width = 1
$owner.Height = 1
$owner.Opacity = 0
$owner.Show()

try {
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = '选择用于保存 DSH 备份的文件夹'
  $dialog.ShowNewFolderButton = $true
${preset}  $result = $dialog.ShowDialog($owner)
  if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [Console]::Out.Write($dialog.SelectedPath)
  }
} finally {
  $owner.Close()
  $owner.Dispose()
}
`
}

/**
 * Run the generated script and resolve to the selected folder, or `null` when
 * the user cancels, the script fails or `timeoutMs` elapses.
 */
function runPicker(scriptPath, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(
        'powershell',
        ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
      )
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', () => finish(null))
    child.on('close', (code) => {
      const selected = stdout.trim()
      finish(code === 0 && selected ? selected : null)
    })
  })
}

/** Show the system folder picker; cancel, failure and timeout all yield null. */
export async function pickFolder({ initial = '', timeoutMs = 180000 } = {}) {
  const scriptPath = path.join(
    os.tmpdir(),
    `dsh-pick-folder-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.ps1`,
  )

  try {
    // UTF-8 BOM so Windows PowerShell 5.1 reads the Chinese dialog text.
    await writeFile(scriptPath, `\uFEFF${buildScript(initial)}`, 'utf8')
    return await runPicker(scriptPath, timeoutMs)
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {})
  }
}
