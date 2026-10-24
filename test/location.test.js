import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKUP_ROOT_MARKER, initializeBackupRoot } from '../lib/location.js'

const META = { version: '0.1.0', createdAt: '2026-10-24T09:00:00.000Z' }

async function assertMissing(target) {
  await assert.rejects(access(target))
}

test('initializes a new backup root with a producer marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  await initializeBackupRoot(root, META)

  assert.equal((await stat(join(root, '_pre-restore'))).isDirectory(), true)
  assert.equal((await stat(join(root, '_restore-logs'))).isDirectory(), true)
  assert.deepEqual(JSON.parse(await readFile(join(root, BACKUP_ROOT_MARKER), 'utf8')), {
    producer: 'dsh-crash-backup',
    schemaVersion: 1,
  })

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

test('never overwrites an existing index, settings or readme on a second run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  await initializeBackupRoot(root, META)

  const saves = [{ id: 'dsh-save-20261024-090000' }]
  await writeFile(join(root, 'index.json'), JSON.stringify({ saves }))
  const firstSettings = await readFile(join(root, 'settings.json'), 'utf8')
  const firstReadme = await readFile(join(root, 'README.txt'), 'utf8')

  const newer = { version: '0.2.0', createdAt: '2026-10-25T09:00:00.000Z' }
  await initializeBackupRoot(root, newer)

  assert.deepEqual(JSON.parse(await readFile(join(root, 'index.json'), 'utf8')), { saves })
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), firstSettings)
  assert.equal(await readFile(join(root, 'README.txt'), 'utf8'), firstReadme)
  assert.deepEqual(JSON.parse(await readFile(join(root, BACKUP_ROOT_MARKER), 'utf8')), {
    producer: 'dsh-crash-backup',
    schemaVersion: 1,
  })
})

test('refuses a non-empty foreign folder and leaves every file untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  const readme = '这个目录是用户的，不是备份目录。\n'
  const settings = '{"owner":"user","keep":true}\n'
  await writeFile(join(root, 'README.txt'), readme)
  await writeFile(join(root, 'settings.json'), settings)
  await writeFile(join(root, 'index.json'), '{"saves":["mine"]}\n')
  await writeFile(join(root, 'notes.txt'), 'do not touch\n')

  await assert.rejects(initializeBackupRoot(root, META), (error) => {
    assert.equal(error.code, 'E_NOT_OURS')
    assert.match(error.message, /空文件夹/)
    return true
  })

  assert.equal(await readFile(join(root, 'README.txt'), 'utf8'), readme)
  assert.equal(await readFile(join(root, 'settings.json'), 'utf8'), settings)
  assert.equal(await readFile(join(root, 'index.json'), 'utf8'), '{"saves":["mine"]}\n')
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), 'do not touch\n')
  // No layout, metadata or marker may be written into a foreign folder.
  await assertMissing(join(root, BACKUP_ROOT_MARKER))
  await assertMissing(join(root, '_pre-restore'))
  await assertMissing(join(root, '_restore-logs'))
})

test('adopts a marker-less folder that only holds plugin files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  const save = join(root, 'dsh-save-20260101-120000')
  await mkdir(save)
  await writeFile(join(save, 'dsh-save-20260101-120000.zip'), 'zip')
  const index = '{"saves":[]}\n'
  await writeFile(join(root, 'index.json'), index)

  await initializeBackupRoot(root, META)

  assert.deepEqual(JSON.parse(await readFile(join(root, BACKUP_ROOT_MARKER), 'utf8')), {
    producer: 'dsh-crash-backup',
    schemaVersion: 1,
  })
  // The marker is added, but files and saves that already exist are untouched.
  assert.equal(await readFile(join(root, 'index.json'), 'utf8'), index)
  assert.deepEqual(await readdir(save), ['dsh-save-20260101-120000.zip'])
  assert.equal((await stat(join(root, 'README.txt'))).isFile(), true)
  assert.equal((await stat(join(root, 'settings.json'))).isFile(), true)
})

test('refuses a marker-less folder holding a save and a foreign file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  await mkdir(join(root, 'dsh-save-20260101-120000'))
  await writeFile(join(root, 'notes.txt'), '用户数据\n')

  await assert.rejects(initializeBackupRoot(root, META), (error) => {
    assert.equal(error.code, 'E_NOT_OURS')
    return true
  })
  await assertMissing(join(root, BACKUP_ROOT_MARKER))
  assert.equal(await readFile(join(root, 'notes.txt'), 'utf8'), '用户数据\n')
})

test('treats a folder with a malformed marker as foreign', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-root-'))
  await writeFile(join(root, BACKUP_ROOT_MARKER), '{ not json')
  await writeFile(join(root, 'README.txt'), '用户文件\n')

  await assert.rejects(initializeBackupRoot(root, META), (error) => {
    assert.equal(error.code, 'E_NOT_OURS')
    return true
  })
  assert.equal(await readFile(join(root, 'README.txt'), 'utf8'), '用户文件\n')
})
