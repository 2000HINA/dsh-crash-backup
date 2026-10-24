import test from 'node:test'
import assert from 'node:assert/strict'
import { buildRestoreCommand } from '../lib/restore.js'

test('passes the mode, the UI flag and the quoted script path to the script', () => {
  const { args } = buildRestoreCommand({
    scriptPath: 'C:\\b\\My Save\\RESTORE.ps1',
    mode: 'plugins',
  })
  const line = args.join(' ')

  assert.ok(line.includes('-Mode plugins'))
  assert.ok(line.includes('-FromUi'))
  assert.ok(line.includes('-File "C:\\b\\My Save\\RESTORE.ps1"'))
})

test('passes full mode through unchanged', () => {
  const { args } = buildRestoreCommand({ scriptPath: 'C:\\b\\RESTORE.ps1', mode: 'full' })

  assert.ok(args.join(' ').includes('-Mode full'))
})

test('rejects a mode the restore script does not support', () => {
  assert.throws(
    () => buildRestoreCommand({ scriptPath: 'C:\\b\\RESTORE.ps1', mode: 'everything' }),
    /mode/,
  )
  assert.throws(() => buildRestoreCommand({ scriptPath: 'C:\\b\\RESTORE.ps1' }), /mode/)
})

test('passes the whole start line as one /c command string, not separate spawn args', () => {
  const scriptPath = 'C:\\b\\RESTORE.ps1'
  const { file, args } = buildRestoreCommand({ scriptPath, mode: 'plugins' })

  assert.match(file, /System32[\\/]cmd\.exe$/i)
  assert.equal(args.length, 4)
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(typeof args[3], 'string')

  const line = args[3]
  // The empty title is what keeps `start` from treating the quoted
  // PowerShell path as the window title and silently doing nothing.
  assert.match(line, /^start "" "[^"]+" /)
  const powershellAt = line.search(/powershell(?:\.exe)?/i)
  const fileAt = line.search(/-File\b/)
  const scriptAt = line.indexOf(`"${scriptPath}"`)
  assert.ok(powershellAt >= 0, 'powershell must be invoked')
  assert.ok(powershellAt < fileAt, 'powershell must run before -File')
  assert.ok(fileAt < scriptAt, 'the quoted script path must follow -File')
  assert.ok(!args.includes('-NoProfile'))
  assert.ok(!args.includes(scriptPath))
})
