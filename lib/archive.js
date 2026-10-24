/**
 * Archive engine.
 *
 * The Windows bsdtar writes filenames in the current ANSI code page, not in
 * UTF-8, even when the zip stores them as UTF-8 (`hdrcharset=UTF-8`). Every
 * line tar prints on stdout is therefore decoded with the system code page;
 * file contents returned by `readArchiveEntry` stay UTF-8.
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { copyFile, lstat, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const TAR_PATH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')

/** Mapping from Windows ANSI code pages to WHATWG TextDecoder labels. */
const WINDOWS_CHARSETS = {
  874: 'windows-874',
  932: 'shift_jis',
  936: 'gbk',
  949: 'euc-kr',
  950: 'big5',
  1250: 'windows-1250',
  1251: 'windows-1251',
  1252: 'windows-1252',
  1253: 'windows-1253',
  1254: 'windows-1254',
  1255: 'windows-1255',
  1256: 'windows-1256',
  1257: 'windows-1257',
  1258: 'windows-1258',
  54936: 'gb18030',
  65001: 'utf-8',
}

/** Windows tar.exe is resolved lazily so importing this module never fails. */
function assertTar() {
  if (fs.existsSync(TAR_PATH)) return
  throw new Error(`Windows tar.exe not found at ${TAR_PATH}; it is required for backup archives`)
}

/** Read the ANSI code page from the registry; 0 when it cannot be determined. */
function readAnsiCodePage() {
  try {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe')
    const result = spawnSync(
      reg,
      ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
      { windowsHide: true, encoding: 'utf8' },
    )
    const match = /ACP\s+REG_SZ\s+(\S+)/.exec(result.stdout ?? '')
    if (!match) return 0
    return /^0x/i.test(match[1]) ? Number.parseInt(match[1], 16) : Number(match[1])
  } catch {
    return 0
  }
}

let tarDecoder

/** Decoder for tar's textual output (listing, error messages). */
function decodeTarText(buffer) {
  if (!tarDecoder) {
    const label = WINDOWS_CHARSETS[readAnsiCodePage()] || 'utf-8'
    try {
      tarDecoder = new TextDecoder(label)
    } catch {
      tarDecoder = new TextDecoder('utf-8')
    }
  }
  return tarDecoder.decode(buffer)
}

/** Run tar and resolve with its stdout buffer; reject with its stderr text. */
function runTar(args) {
  assertTar()
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(TAR_PATH, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      reject(new Error(`failed to start ${TAR_PATH}: ${error.message}`))
      return
    }

    const stdout = []
    const stderr = []
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }

    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', (error) => fail(new Error(`failed to run ${TAR_PATH}: ${error.message}`)))
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        const message = decodeTarText(Buffer.concat(stderr)).trim()
        reject(new Error(message || `tar exited with code ${code}`))
        return
      }
      resolve(Buffer.concat(stdout))
    })
  })
}

/** Strip a leading `./`; trailing slashes are only stripped for comparisons. */
function withoutDotSlash(entry) {
  return entry.startsWith('./') ? entry.slice(2) : entry
}

/** Normalize a member name or caller-supplied prefix for comparisons. */
function comparisonKey(entry) {
  return withoutDotSlash(entry).replace(/\/+$/, '')
}

/** Raw listing exactly as tar spells it, one entry per line. */
async function listArchiveRaw(zipPath) {
  const stdout = await runTar(['-tf', path.resolve(zipPath)])
  return decodeTarText(stdout)
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.length > 0)
}

/** Archive member names without the leading `./`; the `.` root entry is dropped. */
export async function listArchive(zipPath) {
  const entries = []
  for (const line of await listArchiveRaw(zipPath)) {
    const entry = withoutDotSlash(line)
    if (entry) entries.push(entry)
  }
  return entries
}

/**
 * Pick the archive member to hand to `tar -x`: the exact file first, then the
 * directory entry itself (tar extracts it recursively), then a child entry.
 */
function pickMember(rawEntries, prefix) {
  const named = rawEntries.map((raw) => ({ raw, name: withoutDotSlash(raw) }))
  const exact = named.find((entry) => entry.name === prefix)
  if (exact) return exact.raw
  const directory = named.find((entry) => entry.name === `${prefix}/`)
  if (directory) return directory.raw
  const child = named.find((entry) => entry.name.startsWith(`${prefix}/`))
  return child ? child.raw : null
}

/** Validate a source name and resolve it below the staging directory. */
function stagingTarget(staging, name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('source.name must be a non-empty string')
  }
  if (name.includes('\\')) {
    throw new Error(`source.name must use forward slashes: ${name}`)
  }
  const parts = name.split('/')
  if (path.isAbsolute(name) || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`source.name must stay inside the staging directory: ${name}`)
  }
  return path.join(staging, ...parts)
}

/** Remove the staging junctions first, then the staging tree; never throw. */
function cleanupStaging(staging, links) {
  for (const link of links) {
    try {
      fs.rmSync(link, { recursive: false, force: true })
    } catch {
      // force already ignores most failures; a lingering link is removed with
      // the staging tree below, which unlinks it instead of following it.
    }
  }
  try {
    fs.rmSync(staging, { recursive: true, force: true })
  } catch {
    // Cleanup must never mask the error (or the result) of the archive itself.
  }
}

/**
 * Stage the sources under a temporary directory, zip that directory and
 * return the number of archive entries.
 *
 * Directories are staged as junctions so tar walks their contents without
 * copying gigabytes first; files are copied. The staging tree is always
 * removed afterwards and the source paths are never touched.
 */
export async function createArchive({ zipPath, sources, manifest, onProgress } = {}) {
  assertTar()
  if (typeof zipPath !== 'string' || zipPath === '') {
    throw new TypeError('createArchive requires a non-empty zipPath')
  }
  if (!Array.isArray(sources)) {
    throw new TypeError('createArchive requires a sources array')
  }

  const staging = path.join(
    os.tmpdir(),
    `dsh-arch-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  )
  const links = []

  try {
    await mkdir(staging, { recursive: true })
    onProgress?.('staging', 5)

    for (const source of sources) {
      const dest = stagingTarget(staging, source.name)
      await mkdir(path.dirname(dest), { recursive: true })
      const info = await stat(source.path)
      if (info.isDirectory()) {
        // A junction needs an absolute target and needs no admin rights.
        fs.symlinkSync(path.resolve(source.path), dest, 'junction')
        links.push(dest)
      } else if (info.isFile()) {
        await copyFile(source.path, dest)
      } else {
        throw new Error(`unsupported backup source: ${source.path}`)
      }
    }

    await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    onProgress?.('compress', 20)
    await runTar([
      '--options',
      'hdrcharset=UTF-8',
      '-a',
      '-c',
      '-f',
      path.resolve(zipPath),
      '-C',
      staging,
      '.',
    ])

    onProgress?.('verify', 90)
    const entries = await listArchive(zipPath)
    onProgress?.('done', 100)
    return { entryCount: entries.length }
  } finally {
    cleanupStaging(staging, links)
  }
}

/** Extract the archive subtree below `prefix` into `destDir`. */
export async function extractPrefix(zipPath, prefix, destDir) {
  assertTar()
  const wanted = comparisonKey(prefix)
  if (!wanted) throw new Error(`archive has no ${prefix}`)

  const member = pickMember(await listArchiveRaw(zipPath), wanted)
  if (!member) throw new Error(`archive has no ${prefix}`)

  const dest = path.resolve(destDir)
  await mkdir(dest, { recursive: true })
  await runTar(['-xf', path.resolve(zipPath), '-C', dest, member])
}

/** Read one archive member as UTF-8 text; `name` may carry a leading `./`. */
export async function readArchiveEntry(zipPath, name) {
  assertTar()
  const wanted = comparisonKey(name)
  const rawEntries = await listArchiveRaw(zipPath)
  const member =
    rawEntries.find((entry) => withoutDotSlash(entry) === wanted) ??
    rawEntries.find((entry) => comparisonKey(entry) === wanted)
  if (!member) throw new Error(`archive has no ${name}`)

  const stdout = await runTar(['-xOf', path.resolve(zipPath), member])
  return stdout.toString('utf8')
}

/** Check that every required entry is present; names are compared normalized. */
export async function verifyArchive(zipPath, requiredEntries) {
  const present = new Set((await listArchive(zipPath)).map(comparisonKey))
  const missing = (requiredEntries ?? []).filter((entry) => !present.has(comparisonKey(entry)))
  return { ok: missing.length === 0, missing }
}

/** Lowercase SHA-256 of a file, streamed so large archives are not buffered. */
export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

/**
 * Recursive byte count. Symlinks and junctions are skipped, never followed,
 * and unreadable entries are ignored.
 */
export async function dirSize(dir) {
  const root = await lstat(dir).catch(() => null)
  if (!root || root.isSymbolicLink()) return 0

  let total = 0
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(dir, entry.name)
    try {
      const info = await lstat(full)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) total += await dirSize(full)
      else if (info.isFile()) total += info.size
    } catch {
      // Unreadable entry: leave it out of the total instead of failing.
    }
  }
  return total
}
