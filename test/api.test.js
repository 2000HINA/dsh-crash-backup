import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createHandlers } from '../lib/api.js'

const SAVE_ID = 'dsh-save-20260101-120000'
const OTHER_SAVE_ID = 'dsh-save-20260102-130000'

/** Settings the handlers receive from `resolveSettings` in the Host half. */
function makeSettings(overrides = {}) {
  return {
    installDir: 'C:\\DSH',
    home: 'C:\\Users\\me\\.dsh',
    profile: 'desktop',
    profileDir: 'C:\\Users\\me\\.dsh\\profiles\\desktop',
    backupRoot: 'C:\\Backups',
    backupRootSource: 'saved',
    maxSaves: 3,
    ...overrides,
  }
}

/** Fake IO layer plus the calls it recorded. */
function makeDeps(overrides = {}) {
  const calls = {
    init: [],
    saved: [],
    launched: [],
    deleted: [],
    opened: [],
  }
  const deps = {
    listSaves: async () => [],
    createBackup: async () => ({}),
    deleteSave: async (_settings, id) => {
      calls.deleted.push(id)
    },
    launchRestore: (options) => {
      calls.launched.push(options)
    },
    validateBackupDir: () => ({ ok: true }),
    initializeBackupRoot: async (target, metadata) => {
      calls.init.push({ target, metadata })
    },
    saveBackupRoot: async (home, target) => {
      calls.saved.push({ home, target })
    },
    pickFolder: async () => null,
    openFolder: (target) => {
      calls.opened.push(target)
    },
    readDshVersion: async () => '1.2.3',
    ...overrides,
  }
  return { deps, calls }
}

/** Poll `status` until the unref'd restore lock expires. */
async function waitForIdle(handlers, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await handlers.status()
    if (!status.busy) return status
    if (Date.now() > deadline) throw new Error('restore lock was never released')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('status reports empty saves and an idle state before any backup', async () => {
  const { deps } = makeDeps()
  const handlers = createHandlers({ settings: makeSettings(), deps })

  const body = await handlers.status()

  assert.deepEqual(body.saves, [])
  assert.equal(body.busy, false)
  assert.equal(body.job, null)
  assert.equal(body.backupRoot, 'C:\\Backups')
  assert.equal(body.maxSaves, 3)
  assert.equal(body.profile, 'desktop')
})

test('startBackup rejects with 409 while another task owns the busy flag', async () => {
  const { deps } = makeDeps({ listSaves: async () => [{ id: SAVE_ID }] })
  const handlers = createHandlers({ settings: makeSettings(), deps })

  await handlers.startRestore({ id: SAVE_ID, mode: 'full' })
  await assert.rejects(handlers.startBackup(), (error) => {
    assert.equal(error.status, 409)
    return true
  })

  const status = await handlers.status()
  assert.equal(status.busy, true)
})

test('startBackup rejects with 409 when the save cap is reached', async () => {
  const saves = [{ id: SAVE_ID }, { id: OTHER_SAVE_ID }, { id: 'dsh-save-20260103-140000' }]
  const { deps } = makeDeps({ listSaves: async () => saves })
  const handlers = createHandlers({ settings: makeSettings(), deps })

  await assert.rejects(handlers.startBackup(), (error) => {
    assert.equal(error.status, 409)
    assert.match(error.message, /上限/)
    return true
  })

  const status = await handlers.status()
  assert.equal(status.busy, false)
})

test('startBackup clears busy and records the failed phase when the job throws', async () => {
  const { deps } = makeDeps({
    createBackup: async () => {
      throw new Error('磁盘已满')
    },
  })
  const handlers = createHandlers({ settings: makeSettings(), deps })

  const { accepted, job } = await handlers.startBackup()
  assert.equal(accepted, true)
  assert.ok(job)

  await new Promise((resolve) => setTimeout(resolve, 20))
  const status = await handlers.status()
  assert.equal(status.busy, false)
  assert.equal(status.job.phase, 'failed')
  assert.equal(status.job.error, '磁盘已满')
})

test('startBackup exposes onProgress phases and holds busy until the job ends', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { deps } = makeDeps({
    createBackup: async (_settings, { onProgress }) => {
      onProgress('archive', 42)
      await gate
      return {}
    },
  })
  const handlers = createHandlers({ settings: makeSettings(), deps })

  const { accepted, job } = await handlers.startBackup()
  assert.equal(accepted, true)
  assert.ok(job)

  const running = await handlers.status()
  assert.equal(running.busy, true)
  assert.equal(running.job.phase, 'archive')
  assert.equal(running.job.percent, 42)
  await assert.rejects(handlers.startBackup(), (error) => {
    assert.equal(error.status, 409)
    return true
  })

  release()
  await new Promise((resolve) => setTimeout(resolve, 20))
  const finished = await handlers.status()
  assert.equal(finished.busy, false)
  assert.equal(finished.job.phase, 'done')
  assert.equal(finished.job.percent, 100)
})

test('startRestore rejects a malformed id and an unsupported mode with 400', async () => {
  const { deps, calls } = makeDeps()
  const handlers = createHandlers({ settings: makeSettings(), deps })

  await assert.rejects(handlers.startRestore({ id: '..\\evil', mode: 'full' }), (error) => {
    assert.equal(error.status, 400)
    return true
  })
  await assert.rejects(handlers.startRestore({ id: SAVE_ID, mode: 'everything' }), (error) => {
    assert.equal(error.status, 400)
    return true
  })

  assert.deepEqual(calls.launched, [])
  assert.equal((await handlers.status()).busy, false)
})

test('startRestore launches the restore script of the save and marks the handlers busy', async () => {
  const { deps, calls } = makeDeps({ listSaves: async () => [{ id: SAVE_ID }] })
  const handlers = createHandlers({ settings: makeSettings(), deps })

  const body = await handlers.startRestore({ id: SAVE_ID, mode: 'plugins' })

  assert.deepEqual(body, { restoring: true, id: SAVE_ID, mode: 'plugins' })
  assert.deepEqual(calls.launched, [
    {
      scriptPath: path.win32.join('C:\\Backups', SAVE_ID, 'RESTORE.ps1'),
      cwd: path.win32.join('C:\\Backups', SAVE_ID),
      mode: 'plugins',
    },
  ])
  const status = await handlers.status()
  assert.equal(status.busy, true)
  assert.equal(status.job.phase, 'restore')
})

test('startRestore rejects a save that is not in the backup root', async () => {
  const { deps, calls } = makeDeps()
  const handlers = createHandlers({ settings: makeSettings(), deps })

  await assert.rejects(handlers.startRestore({ id: SAVE_ID, mode: 'full' }), (error) => {
    assert.equal(error.status, 400)
    return true
  })
  assert.deepEqual(calls.launched, [])
  assert.equal((await handlers.status()).busy, false)
})

test('updateLocation rejects a path inside the install directory without persisting', async () => {
  const { deps, calls } = makeDeps({
    validateBackupDir: () => ({
      ok: false,
      code: 'inside-install',
      message: '备份目录不能位于 DSH 安装目录内',
    }),
  })
  const settings = makeSettings()
  const handlers = createHandlers({ settings, deps })

  await assert.rejects(handlers.updateLocation({ path: 'C:\\DSH\\backups' }), (error) => {
    assert.equal(error.status, 400)
    assert.match(error.message, /安装目录/)
    return true
  })

  assert.deepEqual(calls.saved, [])
  assert.deepEqual(calls.init, [])
  assert.equal(settings.backupRoot, 'C:\\Backups')
  assert.equal((await handlers.status()).busy, false)
})

test('updateLocation rejects paths inside home or the plugin data directory', async () => {
  for (const candidate of [
    'C:\\Users\\me\\.dsh\\backups',
    'C:\\Users\\me\\.dsh\\dsh-crash-backup\\nested',
  ]) {
    const { deps, calls } = makeDeps()
    const handlers = createHandlers({ settings: makeSettings(), deps })

    await assert.rejects(handlers.updateLocation({ path: candidate }), (error) => {
      assert.equal(error.status, 400)
      return true
    })
    assert.deepEqual(calls.saved, [])
    assert.deepEqual(calls.init, [])
  }
})

test('status reports the new backup root after updateLocation', async () => {
  const { deps, calls } = makeDeps()
  const settings = makeSettings()
  const handlers = createHandlers({ settings, deps })

  const body = await handlers.updateLocation({ path: 'D:\\DSH Backups' })

  assert.deepEqual(body, { backupRoot: 'D:\\DSH Backups' })
  assert.deepEqual(calls.saved, [{ home: settings.home, target: 'D:\\DSH Backups' }])
  assert.equal(calls.init.length, 1)
  assert.equal(calls.init[0].target, 'D:\\DSH Backups')
  assert.equal(calls.init[0].metadata.version, '1.2.3')
  assert.equal(typeof calls.init[0].metadata.createdAt, 'string')

  const status = await handlers.status()
  assert.equal(status.backupRoot, 'D:\\DSH Backups')
})

test('updateLocation validates the candidate against the install and profile dirs', async () => {
  const seen = []
  const { deps } = makeDeps({
    validateBackupDir: (candidate, context) => {
      seen.push({ candidate, context })
      return { ok: true }
    },
  })
  const settings = makeSettings()
  const handlers = createHandlers({ settings, deps })

  await handlers.updateLocation({ path: 'E:\\Saves' })

  assert.deepEqual(seen, [
    {
      candidate: 'E:\\Saves',
      context: { installDir: 'C:\\DSH', profileDir: 'C:\\Users\\me\\.dsh\\profiles\\desktop' },
    },
  ])
})

test('updateLocation rejects an empty path with 400', async () => {
  const { deps } = makeDeps()
  const handlers = createHandlers({ settings: makeSettings(), deps })

  await assert.rejects(handlers.updateLocation({ path: '   ' }), (error) => {
    assert.equal(error.status, 400)
    return true
  })
})

test('removeSave deletes the save and returns the reloaded list', async () => {
  let saves = [{ id: SAVE_ID }]
  const deleted = []
  const { deps } = makeDeps({
    listSaves: async () => saves,
    deleteSave: async (_settings, id) => {
      deleted.push(id)
      saves = []
    },
  })
  const handlers = createHandlers({ settings: makeSettings(), deps })

  const body = await handlers.removeSave({ id: SAVE_ID })

  assert.deepEqual(deleted, [SAVE_ID])
  assert.deepEqual(body, { saves: [] })
})

test('pickFolder returns the chosen path or a canceled flag', async () => {
  const picked = makeDeps({ pickFolder: async () => 'D:\\Picked Folder' })
  const pickedHandlers = createHandlers({ settings: makeSettings(), deps: picked.deps })
  assert.deepEqual(await pickedHandlers.pickFolder(), { path: 'D:\\Picked Folder' })

  const canceled = makeDeps({ pickFolder: async () => null })
  const canceledHandlers = createHandlers({ settings: makeSettings(), deps: canceled.deps })
  assert.deepEqual(await canceledHandlers.pickFolder(), { canceled: true })
})

test('openFolder opens the current backup root', async () => {
  const { deps, calls } = makeDeps()
  const handlers = createHandlers({ settings: makeSettings(), deps })

  assert.deepEqual(await handlers.openFolder(), { opened: true })
  assert.deepEqual(calls.opened, ['C:\\Backups'])
})

test('startRestore releases the lock after restoreLockMs when DSH survives', async () => {
  const { deps } = makeDeps({ listSaves: async () => [{ id: SAVE_ID }] })
  const handlers = createHandlers({ settings: makeSettings(), deps, restoreLockMs: 20 })

  await handlers.startRestore({ id: SAVE_ID, mode: 'full' })
  const locked = await handlers.status()
  assert.equal(locked.busy, true)
  assert.equal(locked.job.phase, 'restore')

  const idle = await waitForIdle(handlers)
  assert.equal(idle.busy, false)
  assert.equal(idle.job, null)
})

test('a backup cannot start while updateLocation holds the lock', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { deps, calls } = makeDeps({
    validateBackupDir: async () => {
      await gate
      return { ok: true }
    },
  })
  const settings = makeSettings()
  const handlers = createHandlers({ settings, deps })

  const updating = handlers.updateLocation({ path: 'D:\\New Root' })
  await assert.rejects(handlers.startBackup(), (error) => {
    assert.equal(error.status, 409)
    return true
  })

  release()
  assert.deepEqual(await updating, { backupRoot: 'D:\\New Root' })
  assert.equal(settings.backupRoot, 'D:\\New Root')
  assert.deepEqual(calls.saved, [{ home: settings.home, target: 'D:\\New Root' }])
  assert.equal(calls.init.length, 1)
})

test('a backup cannot start while removeSave holds the lock', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let saves = [{ id: SAVE_ID }]
  const deleted = []
  const { deps } = makeDeps({
    listSaves: async () => saves,
    deleteSave: async (_settings, id) => {
      deleted.push(id)
      await gate
      saves = []
    },
  })
  const handlers = createHandlers({ settings: makeSettings(), deps })

  const deleting = handlers.removeSave({ id: SAVE_ID })
  await assert.rejects(handlers.startBackup(), (error) => {
    assert.equal(error.status, 409)
    return true
  })

  release()
  assert.deepEqual(await deleting, { saves: [] })
  assert.deepEqual(deleted, [SAVE_ID])
  assert.equal((await handlers.status()).busy, false)
})
