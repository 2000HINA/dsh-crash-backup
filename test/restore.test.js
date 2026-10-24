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
  const { file, args } = buildRestoreCommand({
    scriptPath: 'C:\\b\\RESTORE.ps1',
    mode: 'plugins',
  })

  assert.match(file, /System32[\\/]cmd\.exe$/i)
  assert.equal(args.length, 4)
  assert.deepEqual(args.slice(0, 3), ['/d', '/s', '/c'])
  assert.equal(typeof args[3], 'string')
  assert.ok(args[3].includes('start'))
  assert.ok(!args.includes('-NoProfile'))
  assert.ok(!args.includes('C:\\b\\RESTORE.ps1'))
})
