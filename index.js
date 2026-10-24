/**
 * Host half: wire the backup handlers to the browser HTTP carrier.
 *
 * All state lives in `lib/api.js`; this file only resolves the runtime paths,
 * registers one exact route per handler and enforces the transport rules the
 * settings page relies on (same-origin mutations, small JSON bodies).
 */
import { spawn } from 'node:child_process'
import os from 'node:os'
import { API_ROUTE } from './lib/constants.js'
import { createHandlers } from './lib/api.js'
import { resolveSettings } from './lib/config.js'
import { createBackup, deleteSave, listSaves } from './lib/backup.js'
import { initializeBackupRoot } from './lib/location.js'
import { readDshVersion } from './lib/manifest.js'
import { pickFolder } from './lib/picker.js'
import { launchRestore } from './lib/restore.js'
import { saveBackupRoot, validateBackupDir } from './lib/settings.js'

const MAX_BODY_BYTES = 4096

/** Open Explorer on the backup root; the window must outlive this process. */
function openFolder(target) {
  const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

function httpError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

/** Write one JSON payload; `body` is serialized exactly once. */
function sendJson(response, status, body) {
  const data = JSON.stringify(body)
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
  })
  response.end(data)
}

/** True when a `host[:port]` authority names this machine's loopback. */
function loopbackAuthority(host) {
  if (typeof host !== 'string' || !host) return false
  const lower = host.toLowerCase()
  if (lower.startsWith('[')) {
    const end = lower.indexOf(']')
    return end > 0 && lower.slice(0, end + 1) === '[::1]'
  }
  const name = lower.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost'
}

/**
 * The fence every mutating route shares: the Host header (which a rebinding
 * page cannot forge) must be loopback, the browser must not call this
 * cross-site, and a present Origin must match the Host. An absent Origin is a
 * non-browser client: browsers send it on every POST, same-origin included.
 */
function sameOrigin(request) {
  const host = request.headers.host
  if (!loopbackAuthority(host)) return false
  if (String(request.headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site') {
    return false
  }
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** Read a JSON object from the request, rejecting bodies over 4 KB. */
async function readJsonBody(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw httpError(413, '请求体超过 4 KB 上限')
    chunks.push(buffer)
  }
  if (size === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw httpError(400, '请求体不是合法的 JSON')
  }
}

/** Build one exact route around a handler and its transport rules. */
function route({ method, path, status = 200, mutating = false, handle }) {
  return {
    kind: 'exact',
    path,
    handler: async (request, response) => {
      try {
        if ((request.method ?? 'GET').toUpperCase() !== method) {
          sendJson(response, 405, { error: '请求方法不允许' })
          return
        }
        if (mutating && !sameOrigin(request)) {
          sendJson(response, 403, { error: '仅接受同源请求' })
          return
        }
        const input = method === 'GET' ? {} : await readJsonBody(request)
        if (input === null || typeof input !== 'object' || Array.isArray(input)) {
          throw httpError(400, '请求体必须是 JSON 对象')
        }
        sendJson(response, status, await handle(input))
      } catch (error) {
        if (response.headersSent) {
          response.end()
          return
        }
        sendJson(response, Number.isInteger(error?.status) ? error.status : 500, {
          error: error?.message ?? String(error),
        })
      }
    },
  }
}

export function apply(ctx, config = {}) {
  let handlers = null

  /** Resolve the runtime paths and handlers on first use, not on import. */
  function resolveHandlers() {
    if (handlers) return handlers
    const settings = resolveSettings({
      config,
      execPath: process.execPath,
      homedir: os.homedir(),
    })
    handlers = createHandlers({
      settings,
      restoreLockMs: config.restoreLockMs,
      deps: {
        listSaves,
        createBackup,
        deleteSave,
        launchRestore,
        validateBackupDir,
        initializeBackupRoot,
        saveBackupRoot,
        pickFolder,
        openFolder,
        readDshVersion,
      },
    })
    return handlers
  }

  ctx.inject(['webServer'], (hostCtx) => {
    hostCtx.effect(() => {
      const api = resolveHandlers()
      const routes = [
        route({
          method: 'GET',
          path: `${API_ROUTE}/status`,
          handle: () => api.status(),
        }),
        route({
          method: 'POST',
          path: `${API_ROUTE}/backup`,
          status: 202,
          mutating: true,
          handle: () => api.startBackup(),
        }),
        route({
          method: 'POST',
          path: `${API_ROUTE}/restore`,
          status: 202,
          mutating: true,
          handle: (input) => api.startRestore(input),
        }),
        route({
          method: 'POST',
          path: `${API_ROUTE}/delete`,
          mutating: true,
          handle: (input) => api.removeSave(input),
        }),
        route({
          method: 'POST',
          path: `${API_ROUTE}/location`,
          mutating: true,
          handle: (input) => api.updateLocation(input),
        }),
        route({
          method: 'POST',
          path: `${API_ROUTE}/pick-folder`,
          mutating: true,
          handle: () => api.pickFolder(),
        }),
        route({
          method: 'POST',
          path: `${API_ROUTE}/open-folder`,
          mutating: true,
          handle: () => api.openFolder(),
        }),
      ]
      const disposers = routes.map((definition) => hostCtx.webServer.register(definition))
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'dsh-crash-backup: api routes')
  })
}
