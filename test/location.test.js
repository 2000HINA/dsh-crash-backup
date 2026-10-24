import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeBackupRoot } from '../lib/location.js'

const META = { version: '0.1.0', createdAt: '2026-10-24T09:00:00.000Z' }

test('initializes a new backup root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  await initializeBackupRoot(root, META)

  assert.equal((await stat(join(root, '_pre-restore'))).isDirectory(), true)
  assert.equal((await stat(join(root, '_restore-logs'))).isDirectory(), true)

  const readme = await readFile(join(root, 'README.txt'), 'utf8')
  assert.match(readme, /崩溃/)
  assert.match(readme, /RESTORE\.cmd/)
  assert.match(readme, /DSH 崩溃或无法启动时，打开对应存档文件夹，双击 RESTORE\.cmd 回档/)
  assert.match(readme, /\.credentials\.yaml/)
  assert.match(readme, /dsh-backups/)
  assert.match(readme, /空间/)

  const settings = JSON.parse(await readFile(join(root, 'settings.json'), 'utf8'))
  assert.deepEqual(settings, { ...META, backupRoot: root })

  const rawIndex = await readFile(join(root, 'index.json'), 'utf8')
  assert.equal(rawIndex.trim(), '{"saves":[]}')
})

test('keeps an existing index but refreshes settings on a second run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  await initializeBackupRoot(root, META)

  const saves = [{ id: 'dsh-save-20261024-090000' }]
  await writeFile(join(root, 'index.json'), JSON.stringify({ saves }))

  const newer = { version: '0.2.0', createdAt: '2026-10-25T09:00:00.000Z' }
  await initializeBackupRoot(root, newer)

  assert.deepEqual(JSON.parse(await readFile(join(root, 'index.json'), 'utf8')), { saves })
  assert.deepEqual(JSON.parse(await readFile(join(root, 'settings.json'), 'utf8')), {
    ...newer,
    backupRoot: root,
  })
})
