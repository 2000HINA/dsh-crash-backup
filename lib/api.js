/**
 * Command handlers behind the settings page.
 *
 * The handlers own no transport and perform no IO themselves: every filesystem,
 * process and dialog interaction arrives through `deps`, so they can be tested
 * without DSH, Windows or a live backup root. Failures are thrown with an HTTP
 * status (`400` invalid input, `409` busy/limit); `index.js` maps them to JSON.
 */
import path from 'node:path'
import { MAX_SAVES, SAVE_PREFIX, SETTINGS_DIR_NAME } from './constants.js'
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

  async function status() {
    const saves = await deps.listSaves(settings)
    return {
      maxSaves: maxSaves(),
      backupRoot: settings.backupRoot,
      profile: settings.profile,
      saves,
      busy: state.busy,
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
      const saves = await deps.listSaves(settings)
      if (saves.length >= maxSaves()) {
        throw conflict(`备份数量已达上限（最多 ${maxSaves()} 份存档），请先删除旧存档后再备份`)
      }
    } catch (error) {
      releaseBusy(token)
      throw error
    }

    const job = { phase: 'starting', percent: 0, startedAt: new Date().toISOString() }
    state.job = job
    void runBackup(job, token)
    return { accepted: true, job }
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
      // The launch is fire-and-forget, so a missing save can only be reported
      // here, before a console opens on a script that does not exist.
      const saves = await deps.listSaves(settings)
      if (!Array.isArray(saves) || !saves.some((save) => save?.id === id)) {
        throw badRequest(`存档不存在：${id}`)
      }
      const { ps1 } = restoreScriptNames()
      const cwd = path.win32.join(settings.backupRoot, id)
      await deps.launchRestore({ scriptPath: path.win32.join(cwd, ps1), cwd, mode })
    } catch (error) {
      releaseBusy(token)
      throw error
    }

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
    // blocking every later operation until a restart.
    scheduleRestoreRelease(token)
    return { restoring: true, id, mode }
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
      if (isInside(target, settings.home)) {
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
      await deps.initializeBackupRoot(target, {
        version: version || 'unknown',
        createdAt: new Date().toISOString(),
      })
      await deps.saveBackupRoot(settings.home, target)
      settings.backupRoot = target
      settings.backupRootSource = 'saved'
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
