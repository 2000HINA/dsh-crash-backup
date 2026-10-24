import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createArchive } from '../lib/archive.js'
import { indexFile, readIndex, rebuildIndex, writeIndex } from '../lib/index-file.js'
import { buildManifest } from '../lib/manifest.js'

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-index-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

function manifestFor({ id, createdAt, dshVersion, dependencies, totalBytes, hasProfile }) {
  return buildManifest({
    id,
    createdAt,
    dshVersion,
    profile: 'desktop',
    plugins: { dependencies: dependencies ?? {}, bundles: [] },
    totalBytes,
    contents: { hasInstall: true, hasProfile },
  })
}

async function saveArchive(root, manifest) {
  const dir = join(root, manifest.id)
  await mkdir(dir, { recursive: true })
  await createArchive({
    zipPath: join(dir, `${manifest.id}.zip`),
    sources: [],
    manifest,
  })
  return dir
}

test('writeIndex and readIndex round-trip the save list', async (t) => {
  const root = await tempRoot(t)
  const saves = [
    {
      id: 'dsh-save-20261024-090000',
      createdAt: '2026-10-24T09:00:00.000Z',
      dshVersion: '44.7.0',
      pluginCount: 1,
      sizeBytes: 100,
      restorable: true,
      hasProfile: true,
    },
  ]

  await writeIndex(root, saves)
  assert.deepEqual(await readIndex(root), { saves })
  assert.match(await readFile(indexFile(root), 'utf8'), /\n {2}"saves": \[/)

  // The rename must replace an existing index instead of failing on Windows.
  await writeIndex(root, [])
  assert.deepEqual(await readIndex(root), { saves: [] })
})

test('a missing or corrupt index reads as an empty list', async (t) => {
  const root = await tempRoot(t)
  assert.deepEqual(await readIndex(root), { saves: [] })

  await writeFile(indexFile(root), '{ not json')
  assert.deepEqual(await readIndex(root), { saves: [] })
})

test('rebuildIndex lists archives newest first and skips unreadable saves', async (t) => {
  const root = await tempRoot(t)
  const old = manifestFor({
    id: 'dsh-save-20261024-080000',
    createdAt: '2026-10-24T08:00:00.000Z',
    dshVersion: '44.7.0',
    dependencies: { 'dsh-ops': '0.3.0', other: '1.0.0' },
    totalBytes: 1234,
    hasProfile: true,
  })
  const newer = manifestFor({
    id: 'dsh-save-20261024-100000',
    createdAt: '2026-10-24T10:00:00.000Z',
    dshVersion: '44.8.0',
    totalBytes: 2048,
    hasProfile: false,
  })
  await saveArchive(root, old)
  await saveArchive(root, newer)

  // A save folder whose zip cannot be read is skipped, not fatal.
  const broken = join(root, 'dsh-save-20261024-110000')
  await mkdir(broken, { recursive: true })
  await writeFile(join(broken, 'dsh-save-20261024-110000.zip'), 'not a zip')

  // A valid zip produced by something else is skipped too.
  const foreign = manifestFor({
    id: 'dsh-save-20261024-120000',
    createdAt: '2026-10-24T12:00:00.000Z',
    dshVersion: '44.9.0',
    totalBytes: 10,
  })
  foreign.producer = 'someone-else'
  await saveArchive(root, foreign)

  // Folders outside the save prefix are ignored.
  await mkdir(join(root, 'notes'))

  const saves = await rebuildIndex(root)
  assert.deepEqual(
    saves.map((save) => save.id),
    ['dsh-save-20261024-100000', 'dsh-save-20261024-080000'],
  )
  assert.deepEqual(saves[0], {
    id: 'dsh-save-20261024-100000',
    createdAt: '2026-10-24T10:00:00.000Z',
    dshVersion: '44.8.0',
    pluginCount: 0,
    sizeBytes: 2048,
    restorable: true,
    hasProfile: false,
  })
  assert.equal(saves[1].pluginCount, 2)
  assert.equal(saves[1].sizeBytes, 1234)
  assert.equal(saves[1].hasProfile, true)

  // The rebuilt list is written to the index before it is returned.
  assert.deepEqual(await readIndex(root), { saves })
})

test('rebuildIndex writes an empty index when there are no saves', async (t) => {
  const root = await tempRoot(t)
  assert.deepEqual(await rebuildIndex(root), [])
  assert.deepEqual(JSON.parse(await readFile(indexFile(root), 'utf8')), { saves: [] })
})
