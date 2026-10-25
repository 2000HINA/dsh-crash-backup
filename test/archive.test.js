import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dirSize } from '../lib/archive.js'

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-archive-'))
  t.after(async () => {
    await rm(root, { recursive: true, force: true })
  })
  return root
}

test('dirSize counts nested files without following junctions', async (t) => {
  const root = await tempRoot(t)
  await mkdir(join(root, 'nested'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'abc')
  await writeFile(join(root, 'nested', 'b.txt'), 'defgh')

  const linked = await mkdtemp(join(tmpdir(), 'dsh-link-target-'))
  t.after(async () => {
    await rm(linked, { recursive: true, force: true })
  })
  await writeFile(join(linked, 'outside.txt'), 'must not count')
  await symlink(linked, join(root, 'link'), 'junction')

  assert.equal(await dirSize(root), 8)
})

test('dirSize is zero for a missing path', async (t) => {
  const root = await tempRoot(t)
  assert.equal(await dirSize(join(root, 'missing')), 0)
})
