/**
 * Command handlers behind the settings page.
 *
 * The handlers own no transport and perform no IO themselves: every filesystem,
 * process and dialog interaction arrives through `deps`, so they can be tested
 * without DSH, Windows or a live backup root. Failures are thrown with an HTTP
 * status (`400` invalid input, `409` busy/limit); `index.js` maps them to JSON.
 */
import path from 'node:path'
import { assertModeSupported } from './backup.js'
import { BACKUP_DIR_NAME, MAX_SAVES, SAVE_PREFIX, SETTINGS_DIR_NAME } from './constants.js'
import { restoreScriptNames } from './scripts.js'

const MODES = new Set(['full', 'plugins'])
const SAVE_ID_PATTERN = new RegExp(`^${SAVE_PREFIX}\\d{8}-\\d{6}(-\\d+)?$`)
const BUSY_MESSAGE = '已有备份或回档任务正在进行，请稍后再试'
/** How long a launched restore may keep the single-flight lock claimed. */
const RESTORE_LOCK_MS = 120000

/** An Error carrying the HTTP status `index.js` should answer with. */
function apiError(status, message) {
  const error = new Error(message)
  error.status = status
  return error
}

function badRequest(message) {
  return apiError(400, message)
}

function conflict(message) {
  return apiError(409, message)
}

/** Reject anything that is not a save folder name this plugin created. */
function requireSaveId(id) {
  if (typeof id !== 'string' || !SAVE_ID_PATTERN.test(id)) {
    throw badRequest(`无效的存档 id：${String(id)}`)
  }
  return id
}

/** Normalized, case-folded path used only for containment comparisons. */
function comparable(value) {
  return path.win32.resolve(value).replace(/[\\/]+$/, '').toLowerCase()
}

/** True when `candidate` is `base` itself or below it, ignoring case. */
function isInside(candidate, base) {
  const parent = comparable(base)
  const target = comparable(candidate)
  return target === parent || target.startsWith(`${parent}${path.win32.sep}`)
}

/** Objects only; a missing or malformed body reads as no input at all. */
function payload(input) {
  return input && typeof input === 'object' && !Array.isArray(input) ? input : {}
}

/**
 * Build the handlers over one shared settings object.
 *
 * `settings` is mutated in place when the backup root moves, so `status()` and
 * the background job see the same values without another settings read.
 *
 * One lock serializes backup, restore, delete and location changes. A restore
 * cannot observe the console it launched, and its script may exit without
 * stopping DSH (the user answered `N`), so it claims the lock only for
 * `restoreLockMs`; after that a timer releases it back to idle. A newer
 * operation clears the pending timer and owns a fresh lock token, so a stale
 * timer can never release it.
 */
export function createHandlers({ settings, deps, restoreLockMs = RESTORE_LOCK_MS } = {}) {
  if (!settings || typeof settings !== 'object') {
    throw new TypeError('createHandlers requires a settings object')
  }
  if (!deps || typeof deps !== 'object') {
    throw new TypeError('createHandlers requires a deps object')
  }

  const state = { busy: false, job: null, settings }
  const lockMs =
    Number.isFinite(restoreLockMs) && restoreLockMs >= 0 ? restoreLockMs : RESTORE_LOCK_MS
  let lockOwner = null
  let restoreTimer = null
  // The restore console writes its lease after launch; once that lease has
  // been observed, its disappearance means the console is gone and the
  // in-process lock can be released without waiting for the timer.
  let restoreToken = null
  let restoreLeaseSeen = false

  function clearRestoreTimer() {
    if (restoreTimer !== null) {
      clearTimeout(restoreTimer)
      restoreTimer = null
    }
  }

  /** Claim the lock before the first await; returns the owner token. */
  function claimBusy() {
    if (state.busy) throw conflict(BUSY_MESSAGE)
    // A new operation supersedes any pending restore release.
    clearRestoreTimer()
    restoreToken = null
    restoreLeaseSeen = false
    state.busy = true
    lockOwner = Symbol('dsh-crash-backup-lock')
    return lockOwner
  }

  /** Only the operation that claimed the lock may release it. */
  function releaseBusy(token) {
    if (lockOwner !== token) return false
    lockOwner = null
    state.busy = false
    return true
  }

  /** Hold the lock for one short async operation, releasing it on the way out. */
  async function withLock(operation) {
    const token = claimBusy()
    try {
      return await operation()
    } finally {
      releaseBusy(token)
    }
  }

  /** Release a restore lock that never got an answer from its console. */
  function scheduleRestoreRelease(token) {
    clearRestoreTimer()
    restoreTimer = setTimeout(() => {
      restoreTimer = null
      if (!releaseBusy(token)) return
      restoreToken = null
      state.job = null
    }, lockMs)
    if (typeof restoreTimer.unref === 'function') restoreTimer.unref()
  }

  /** Save cap from the resolved settings, falling back to the build constant. */
  function maxSaves() {
    return Number.isInteger(settings.maxSaves) && settings.maxSaves >= 0
      ? settings.maxSaves
      : MAX_SAVES
  }

  /** `<home>/dsh-crash-backup`: the plugin's own data, never a backup root. */
  function pluginDataDir() {
    return path.win32.join(settings.home, SETTINGS_DIR_NAME)
  }

  /** `<home>/dsh-backups`: the only home subfolder allowed as a backup root. */
  function homeFallbackDir() {
    return path.win32.join(settings.home, BACKUP_DIR_NAME)
  }

  /** True while the standalone restart script owns a restore (lease file). */
  async function restoreLeasePresent() {
    if (typeof deps.restoreLeaseExists !== 'function') return false
    return Boolean(await deps.restoreLeaseExists(settings))
  }

  /** Whether the configured backup root exists, when the Host half can tell. */
  async function backupRootPresent() {
    if (typeof deps.backupRootExists !== 'function') return true
    return Boolean(await deps.backupRootExists(settings))
  }

  /** Advisory warning for a system-level condition; never fails an action. */
  async function longPathsNotice() {
    if (typeof deps.longPathsWarning !== 'function') return ''
    try {
      return String((await deps.longPathsWarning()) ?? '')
    } catch {
      return ''
    }
  }

  async function status() {
    const [saves, leased, rootExists] = await Promise.all([
      deps.listSaves(settings),
      restoreLeasePresent(),
      backupRootPresent(),
    ])
    if (leased) {
      restoreLeaseSeen = true
    } else if (restoreLeaseSeen) {
      // The console was seen running and its lease is gone: release the lock
      // now instead of keeping the page busy until the timer expires.
      restoreLeaseSeen = false
      const token = restoreToken
      if (token !== null && lockOwner === token) {
        restoreToken = null
        clearRestoreTimer()
        state.job = null
        releaseBusy(token)
      }
    }
    return {
      maxSaves: maxSaves(),
      backupRoot: settings.backupRoot,
      backupRootSource: settings.backupRootSource ?? 'default',
      backupRootNote: settings.backupRootNote ?? '',
      backupRootExists: rootExists,
      profile: settings.profile,
      saves,
      // A restore script's lease outlives the short in-process lock: while the
      // console waits at Y/N the page must stay busy instead of re-enabling
      // backup/restore after the lock timer expires.
      busy: state.busy || leased,
      job: state.job,
    }
  }

  /** Run one backup in the background, tracking phases and releasing `busy`. */
  async function runBackup(job, token) {
    try {
      await deps.createBackup(settings, {
        onProgress: (phase, percent) => {
          job.phase = phase
          job.percent = percent
        },
      })
      job.phase = 'done'
      job.percent = 100
    } catch (error) {
      job.phase = 'failed'
      job.error = error?.message ?? String(error)
    } finally {
      job.finishedAt = new Date().toISOString()
      releaseBusy(token)
    }
  }

  async function startBackup() {
    // Claimed before the first await so two requests cannot both pass the
    // check; released again below when the limit rejects the request.
    const token = claimBusy()
    try {
      if (await restoreLeasePresent()) throw conflict(BUSY_MESSAGE)
      const saves = await deps.listSaves(settings)
      if (saves.length >= maxSaves()) {
        throw conflict(`备份数量已达上限（最多 ${maxSaves()} 份存档），请先删除旧存档后再备份`)
      }
    } catch (error) {
      releaseBusy(token)
      throw error
    }

    const warning = await longPathsNotice()
    const job = { phase: 'starting', percent: 0, startedAt: new Date().toISOString() }
    state.job = job
    void runBackup(job, token)
    return { accepted: true, job, ...(warning ? { warning } : {}) }
  }

  async function startRestore(input = {}) {
    if (state.busy) throw conflict(BUSY_MESSAGE)
    const { id, mode } = payload(input)
    requireSaveId(id)
    if (!MODES.has(mode)) {
      throw badRequest(`无效的回档模式：${String(mode)}，仅支持 full 或 plugins`)
    }

    const token = claimBusy()
    try {
      if (await restoreLeasePresent()) throw conflict(BUSY_MESSAGE)
      // The launch is fire-and-forget, so a missing save or an unsupported
      // mode can only be reported here, before a console opens on a script
      // that would refuse to run.
      const saves = await deps.listSaves(settings)
      const save = Array.isArray(saves) ? saves.find((entry) => entry?.id === id) : undefined
      if (!save) {
        throw badRequest(`存档不存在：${id}`)
      }
      try {
        assertModeSupported(save, mode)
      } catch (error) {
        throw badRequest(error.message)
      }
      const { ps1 } = restoreScriptNames()
      const cwd = path.win32.join(settings.backupRoot, id)
      await deps.launchRestore({ scriptPath: path.win32.join(cwd, ps1), cwd, mode })
    } catch (error) {
      releaseBusy(token)
      throw error
    }

    const warning = await longPathsNotice()
    // The restore console now owns the environment: `busy` deliberately stays
    // set so no backup, delete or second restore can start behind its back.
    state.job = {
      phase: 'restore',
      percent: 100,
      startedAt: new Date().toISOString(),
      id,
      mode,
    }
    // A real restore exits DSH, so the timer never matters there. A canceled
    // or failed console leaves DSH alive, so the lock expires instead of
    // blocking every later operation until a restart. RESTORE.ps1's lease file
    // keeps status busy for as long as the console is actually alive, and its
    // removal releases the lock at once (see `status`).
    restoreToken = token
    scheduleRestoreRelease(token)
    return { restoring: true, id, mode, ...(warning ? { warning } : {}) }
  }

  async function removeSave(input = {}) {
    return withLock(async () => {
      const { id } = payload(input)
      requireSaveId(id)
      await deps.deleteSave(settings, id)
      return { saves: await deps.listSaves(settings) }
    })
  }

  async function updateLocation(input = {}) {
    return withLock(async () => {
      const { path: candidate } = payload(input)
      if (typeof candidate !== 'string' || !candidate.trim()) {
        throw badRequest('备份目录不能为空')
      }
      const target = path.win32.resolve(candidate.trim())

      // Checked before `validateBackupDir`, which creates and probes the
      // candidate: a rejected folder must not be created under the user's home.
      if (isInside(target, pluginDataDir())) {
        throw badRequest('备份目录不能位于插件数据目录内（会与 settings.json 冲突）')
      }
      // `<home>/dsh-backups` is the only home subfolder this plugin uses: it is
      // the documented fallback when the default root is not writable. Other
      // home folders stay rejected so a full restore cannot overwrite them.
      if (isInside(target, settings.home) && comparable(target) !== comparable(homeFallbackDir())) {
        throw badRequest('备份目录不能位于用户目录（DSH home）内')
      }

      const verdict = await deps.validateBackupDir(target, {
        installDir: settings.installDir,
        profileDir: settings.profileDir,
      })
      if (!verdict?.ok) {
        throw badRequest(verdict?.message || '备份目录不可用')
      }

      const version = await deps.readDshVersion(settings.installDir)
      try {
        await deps.initializeBackupRoot(target, {
          version: version || 'unknown',
          createdAt: new Date().toISOString(),
        })
      } catch (error) {
        // A folder holding foreign files is a user error, not a server fault:
        // report it as 400 and leave the current backup root untouched.
        if (error?.code === 'E_NOT_OURS') throw badRequest(error.message)
        throw error
      }
      await deps.saveBackupRoot(settings.home, target)
      settings.backupRoot = target
      settings.backupRootSource = 'saved'
      // A deliberate choice supersedes the reason the default root was skipped.
      settings.backupRootNote = ''
      return { backupRoot: target }
    })
  }

  async function pickFolder() {
    const selected = await deps.pickFolder({ initial: settings.backupRoot })
    return typeof selected === 'string' && selected.trim() ? { path: selected } : { canceled: true }
  }

  async function openFolder() {
    await deps.openFolder(settings.backupRoot)
    return { opened: true }
  }

  return { status, startBackup, startRestore, removeSave, updateLocation, pickFolder, openFolder }
}
