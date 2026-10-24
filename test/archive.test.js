import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createArchive,
  dirSize,
  extractPrefix,
  listArchive,
  readArchiveEntry,
  sha256File,
  verifyArchive,
} from '../lib/archive.js'

test('keeps chinese file names inside the zip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-arc-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', '中文 说明.txt'), 'hello')
  const zip = join(root, 'out.zip')
  const { entryCount } = await createArchive({
    zipPath: zip,
    sources: [{ name: 'src', path: join(root, 'src') }],
    manifest: { id: 't' },
  })
  assert.ok(entryCount > 0)
  const entries = await listArchive(zip)
  assert.ok(entries.some((e) => e.includes('中文 说明.txt')))
  assert.equal(JSON.parse(await readArchiveEntry(zip, 'manifest.json')).id, 't')
  const dest = join(root, 'out')
  await extractPrefix(zip, 'src', dest)
  assert.deepEqual(await readdir(join(dest, 'src')), ['中文 说明.txt'])
})

test('a source name with a slash keeps its folders in the archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-arc-'))
  await mkdir(join(root, 'profile', 'desktop'), { recursive: true })
  await writeFile(join(root, 'profile', 'desktop', 'package.json'), '{}')
  await writeFile(join(root, 'version.txt'), '44.7.0')
  const zip = join(root, 'nested.zip')
  await createArchive({
    zipPath: zip,
    sources: [
      { name: 'profile/desktop', path: join(root, 'profile', 'desktop') },
      { name: 'version.txt', path: join(root, 'version.txt') },
    ],
    manifest: {},
  })

  const entries = await listArchive(zip)
  assert.ok(entries.includes('profile/desktop/package.json'))
  assert.ok(entries.includes('version.txt'))

  const dest = join(root, 'out')
  await extractPrefix(zip, 'profile/desktop', dest)
  assert.deepEqual(await readdir(join(dest, 'profile', 'desktop')), ['package.json'])
  // the staging junction must be gone and the source untouched
  assert.deepEqual(await readdir(join(root, 'profile', 'desktop')), ['package.json'])
})

test('verifyArchive names the entries an archive is missing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-arc-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'app.txt'), 'x')
  const zip = join(root, 'verify.zip')
  await createArchive({
    zipPath: zip,
    sources: [{ name: 'src', path: join(root, 'src') }],
    manifest: { id: 'v' },
  })

  assert.deepEqual(await verifyArchive(zip, ['manifest.json', './src/app.txt', 'src/']), {
    ok: true,
    missing: [],
  })
  assert.deepEqual(await verifyArchive(zip, ['manifest.json', 'src/missing.txt']), {
    ok: false,
    missing: ['src/missing.txt'],
  })
})

test('extractPrefix rejects a prefix the archive does not contain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-arc-'))
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'app.txt'), 'x')
  const zip = join(root, 'nope.zip')
  await createArchive({
    zipPath: zip,
    sources: [{ name: 'src', path: join(root, 'src') }],
    manifest: {},
  })
  await assert.rejects(extractPrefix(zip, 'missing', join(root, 'out')), /archive has no/)
})

test('dirSize counts nested files without following a junction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-size-'))
  const target = join(root, 'target')
  await mkdir(join(target, 'deep'), { recursive: true })
  await writeFile(join(target, 'big.bin'), Buffer.alloc(4096))

  const tree = join(root, 'tree')
  await mkdir(join(tree, 'nested'), { recursive: true })
  await writeFile(join(tree, 'a.txt'), Buffer.alloc(100))
  await writeFile(join(tree, 'nested', 'b.txt'), Buffer.alloc(200))

  const link = join(tree, 'link')
  await symlink(target, link, 'junction')
  try {
    assert.equal(await dirSize(tree), 300)
  } finally {
    await rm(link, { force: true })
    await rm(root, { recursive: true, force: true })
  }
})

test('sha256File hashes the file bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hash-'))
  const file = join(root, 'data.bin')
  await writeFile(file, 'abc')
  assert.equal(await sha256File(file), createHash('sha256').update('abc').digest('hex'))
})
