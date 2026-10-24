window.__ModuleLoader__.load({
  id: 'dsh-crash-backup',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
    const h = React.createElement
    const NS = 'dsh-crash-backup'

    /** Same-origin endpoints served by `index.js`; the tests pin these. */
    const API = {
      status: '/dsh-crash-backup/api/status',
      backup: '/dsh-crash-backup/api/backup',
      restore: '/dsh-crash-backup/api/restore',
      delete: '/dsh-crash-backup/api/delete',
      location: '/dsh-crash-backup/api/location',
      pickFolder: '/dsh-crash-backup/api/pick-folder',
      openFolder: '/dsh-crash-backup/api/open-folder',
    }

    /** Phases during which the progress bar is meaningful. */
    const ACTIVE_PHASES = new Set(['starting', 'checking', 'archive', 'scripts', 'restore'])
    const PHASE_KEYS = {
      starting: 'phaseStarting',
      checking: 'phaseChecking',
      archive: 'phaseArchive',
      scripts: 'phaseScripts',
      done: 'phaseDone',
      failed: 'phaseFailed',
      restore: 'phaseRestore',
    }

    /**
     * Restore scopes offered by the confirm dialog, in display order. A mode
     * without an `enabled` predicate always applies; `unavailableKey` replaces
     * the scope description with the reason a save cannot use it.
     */
    const RESTORE_MODES = [
      { value: 'full', labelKey: 'modeFull', descKey: 'modeFullDesc' },
      {
        value: 'plugins',
        labelKey: 'modePlugins',
        descKey: 'modePluginsDesc',
        unavailableKey: 'modePluginsUnavailable',
        enabled: (save) => save?.hasProfile === true,
      },
    ]

    /** Whether one save can use `mode`; a mode without a predicate always can. */
    function modeEnabled(mode, save) {
      return typeof mode?.enabled === 'function' ? mode.enabled(save) : true
    }

    /** The mode entry behind a stored value; unknown values fall back to the first. */
    function modeEntry(value) {
      return RESTORE_MODES.find((mode) => mode.value === value) ?? RESTORE_MODES[0]
    }

    const zh = {
      nav: '存档',
      title: '存档',
      desc: '把当前 DSH 环境压缩成单个存档，崩溃后可用独立脚本完整回档。只有手动点击才会备份，DSH 不会自动创建。',
      crashHint: 'DSH 崩溃或无法启动时，打开备份目录，双击任一存档里的 RESTORE.cmd 即可回档。',
      pathLabel: '备份目录',
      folderMissing: '备份目录不存在；下一次备份会自动重新创建。',
      credentialWarning: '存档压缩包包含 .credentials.yaml（API Key 等登录凭据，未加密）。请勿把存档或备份目录分享、上传给他人，也不要放进公共网盘。',
      count: '已保存 {count}/{max}',
      backup: '备份当前环境',
      backingUp: '正在备份…',
      empty: '还没有存档。只有手动点击“备份当前环境”时才会创建，DSH 不会自动备份。',
      openFolder: '打开文件夹',
      changeFolder: '更改目录',
      choosingFolder: '选择目录…',
      version: 'DSH {version}',
      versionUnknown: 'DSH 版本未知',
      plugins: '{count} 个插件',
      restore: '回滚',
      delete: '删除',
      restoreConfirmTitle: '回滚到这个存档？',
      restoreConfirmBody: '回滚会先关闭 DSH，再按选定的范围运行存档里的 RESTORE.cmd。未保存的内容会丢失，完成后需要手动重新启动 DSH。',
      restoreModeLabel: '回档范围',
      modeFull: '完整回档',
      modeFullDesc: '恢复 DSH 安装目录、插件与用户配置。DSH 会先关闭。',
      modePlugins: '仅回滚插件',
      modePluginsDesc: '只恢复插件 profile（package.json、锁文件、patch 与 node_modules），不改 DSH 安装与用户数据；插件数据不回退。',
      modeUnavailable: '当前存档不支持此模式',
      modePluginsUnavailable: '该存档缺少插件内容，无法仅回滚插件。',
      deleteConfirmTitle: '删除这个存档？',
      deleteConfirmBody: '存档文件夹（含回退脚本）会被永久删除，无法恢复。',
      cancel: '取消',
      confirmRestore: '确认回滚',
      confirmDelete: '永久删除',
      restoreStartedFull: '正在完整回档，DSH 即将关闭。完成后需要手动重新启动 DSH；若脚本被取消，稍后可以重试。',
      restoreStartedPlugins: '正在仅回滚插件，DSH 即将关闭。完成后需要手动重新启动 DSH 以加载回档后的插件；若脚本被取消，稍后可以重试。',
      backupDone: '备份完成。',
      backupFailed: '备份失败。',
      deleteDone: '存档已删除。',
      locationDone: '备份目录已更新。旧目录中的存档仍然保留，不会被移动或删除。',
      loadFailed: '读取存档列表失败：{error}',
      actionFailed: '操作失败：{error}',
      retry: '重试',
      processing: '正在处理…',
      phaseStarting: '准备备份',
      phaseChecking: '检查环境',
      phaseArchive: '压缩安装目录与插件',
      phaseScripts: '写入回退脚本',
      phaseDone: '完成',
      phaseFailed: '失败',
      phaseRestore: '正在回档，DSH 即将关闭',
    }

    const en = {
      nav: 'Saves',
      title: 'Saves',
      desc: 'Compress the current DSH environment into one save that an independent script can restore after a crash. Backups only happen when you click the button; DSH never creates one automatically.',
      crashHint: 'If DSH crashes or cannot start, open the backup folder and double-click RESTORE.cmd inside any save to restore it.',
      pathLabel: 'Backup folder',
      folderMissing: 'The backup folder does not exist; the next backup creates it again.',
      credentialWarning: 'Save archives include .credentials.yaml with API keys and other credentials in plain text. Never share or upload saves or the backup folder.',
      count: '{count}/{max} saved',
      backup: 'Back up now',
      backingUp: 'Backing up…',
      empty: 'No saves yet. A backup is only created when you click “Back up now”; DSH never backs up automatically.',
      openFolder: 'Open folder',
      changeFolder: 'Change folder',
      choosingFolder: 'Choosing folder…',
      version: 'DSH {version}',
      versionUnknown: 'DSH version unknown',
      plugins: '{count} plugins',
      restore: 'Restore',
      delete: 'Delete',
      restoreConfirmTitle: 'Restore this save?',
      restoreConfirmBody: 'Restoring first closes DSH, then RESTORE.cmd in the save runs with the selected scope. Unsaved work is lost, and DSH must be started manually afterwards.',
      restoreModeLabel: 'Restore scope',
      modeFull: 'Full restore',
      modeFullDesc: 'Restores the DSH install directory, plugins and user configuration. DSH is closed first.',
      modePlugins: 'Plugins only',
      modePluginsDesc: 'Restores only the plugin profile (package.json, lockfile, patch and node_modules). The DSH install, user data and plugin data are left untouched.',
      modeUnavailable: 'This mode is not available for this save',
      modePluginsUnavailable: 'This save has no plugin profile, so plugins-only restore is unavailable.',
      deleteConfirmTitle: 'Delete this save?',
      deleteConfirmBody: 'The save folder, including its restore script, is permanently deleted.',
      cancel: 'Cancel',
      confirmRestore: 'Restore',
      confirmDelete: 'Delete permanently',
      restoreStartedFull: 'Full restore is starting and DSH is about to close. Start DSH manually afterwards. If the script is cancelled, try again later.',
      restoreStartedPlugins: 'Plugins-only restore is starting and DSH is about to close. Start DSH manually afterwards to load the restored plugins. If the script is cancelled, try again later.',
      backupDone: 'Backup complete.',
      backupFailed: 'Backup failed.',
      deleteDone: 'Save deleted.',
      locationDone: 'Backup folder updated. Saves in the old folder are kept and are not moved or deleted.',
      loadFailed: 'Could not load saves: {error}',
      actionFailed: 'Action failed: {error}',
      retry: 'Retry',
      processing: 'Working…',
      phaseStarting: 'Preparing backup',
      phaseChecking: 'Checking environment',
      phaseArchive: 'Compressing install and plugins',
      phaseScripts: 'Writing restore script',
      phaseDone: 'Done',
      phaseFailed: 'Failed',
      phaseRestore: 'Restoring; DSH is about to close',
    }

    const DICTS = { zh, en }

    const CSS = `
.dcb-wrap { display:flex; flex-direction:column; gap:16px; color:var(--dsw-alias-label-primary); font-size:13px; }
.dcb-head { display:flex; align-items:flex-start; justify-content:space-between; gap:20px; }
.dcb-head-main { min-width:0; }
.dcb-title { margin:0 0 6px; font-size:16px; font-weight:600; line-height:1.4; }
.dcb-desc { margin:0 0 8px; max-width:640px; color:var(--dsw-alias-label-secondary); line-height:1.6; }
.dcb-hint { margin:0; max-width:640px; color:var(--dsw-alias-label-tertiary); line-height:1.6; }
.dcb-head-right { display:flex; flex-direction:column; align-items:flex-end; gap:8px; flex:0 0 auto; }
.dcb-count { font-size:12px; color:var(--dsw-alias-label-tertiary); font-variant-numeric:tabular-nums; }
.dcb-dir { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:12px 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.dcb-dir-info { display:flex; flex-direction:column; gap:4px; min-width:0; }
.dcb-dir-label { font-size:11px; color:var(--dsw-alias-label-tertiary); }
.dcb-dir-path { font-size:12px; font-family:ui-monospace, SFMono-Regular, Consolas, monospace; color:var(--dsw-alias-label-secondary); word-break:break-all; }
.dcb-dir-note { font-size:11px; line-height:1.5; color:var(--dsw-alias-label-tertiary); }
.dcb-dir-note-warn { color:var(--dsw-alias-state-warn-primary); }
.dcb-dir-actions { display:flex; gap:8px; flex:0 0 auto; }
.dcb-btn { appearance:none; border:1px solid var(--dsw-alias-border-l2); background:transparent; color:var(--dsw-alias-label-primary); border-radius:8px; padding:6px 12px; font-size:12px; line-height:1.5; cursor:pointer; font-family:inherit; transition:background .15s, border-color .15s, opacity .15s; }
.dcb-btn:hover:not(:disabled) { background:var(--dsw-alias-bg-layer-2); }
.dcb-btn:disabled { opacity:.45; cursor:not-allowed; }
.dcb-btn-primary { background:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); color:#fff; }
.dcb-btn-primary:hover:not(:disabled) { background:var(--dsw-alias-brand-primary); filter:brightness(1.06); }
.dcb-btn-danger { color:var(--dsw-alias-state-error-primary); }
.dcb-btn-danger:hover:not(:disabled) { background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent); }
.dcb-list { display:flex; flex-direction:column; gap:10px; }
.dcb-card { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:14px 16px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.dcb-card-info { min-width:0; }
.dcb-card-title { font-size:14px; font-weight:600; }
.dcb-card-meta { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }
.dcb-card-id { margin-top:4px; font-size:11px; color:var(--dsw-alias-label-tertiary); font-family:ui-monospace, SFMono-Regular, Consolas, monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dcb-card-actions { display:flex; gap:8px; flex:0 0 auto; }
.dcb-empty { padding:28px 20px; border:1px dashed var(--dsw-alias-border-l1); border-radius:12px; color:var(--dsw-alias-label-tertiary); text-align:center; line-height:1.7; }
.dcb-banner { padding:10px 14px; border-radius:10px; font-size:12px; line-height:1.6; }
.dcb-banner-error { display:flex; align-items:center; justify-content:space-between; gap:12px; color:var(--dsw-alias-state-error-primary); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 9%, transparent); }
.dcb-banner-text { min-width:0; }
.dcb-retry { flex:0 0 auto; }
.dcb-banner-ok { color:var(--dsw-alias-state-success-primary); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 9%, transparent); }
.dcb-banner-warn { color:var(--dsw-alias-state-warn-primary); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); }
.dcb-warn { margin:0; padding:10px 14px; border-radius:10px; font-size:12px; line-height:1.6; color:var(--dsw-alias-state-warn-primary); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); }
.dcb-progress { display:flex; flex-direction:column; gap:6px; }
.dcb-progress-label { font-size:12px; color:var(--dsw-alias-label-secondary); }
.dcb-progress-track { height:6px; border-radius:999px; background:var(--dsw-alias-bg-layer-2); overflow:hidden; }
.dcb-progress-fill { height:100%; border-radius:999px; background:var(--dsw-alias-brand-primary); transition:width .4s ease; }
.dcb-backdrop { position:fixed; inset:0; z-index:1200; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(0,0,0,.38); }
.dcb-modal { width:min(480px, 100%); border-radius:14px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-overlay); box-shadow:0 18px 50px rgba(0,0,0,.28); padding:20px; display:flex; flex-direction:column; gap:12px; }
.dcb-modal-title { font-size:15px; font-weight:600; }
.dcb-modal-body { font-size:13px; line-height:1.65; color:var(--dsw-alias-label-secondary); }
.dcb-modal-target { font-size:11px; color:var(--dsw-alias-label-tertiary); word-break:break-all; }
.dcb-modal-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:4px; }
.dcb-modes { display:flex; flex-direction:column; gap:8px; }
.dcb-mode { display:flex; align-items:flex-start; gap:10px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; cursor:pointer; }
.dcb-mode-selected { border-color:var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent); }
.dcb-mode-disabled { opacity:.5; cursor:not-allowed; }
.dcb-mode input { margin:3px 0 0; }
.dcb-mode-text { display:flex; flex-direction:column; gap:2px; }
.dcb-mode-title { font-size:13px; font-weight:600; }
.dcb-mode-desc { font-size:12px; color:var(--dsw-alias-label-secondary); line-height:1.55; }
`

    function Section(props) {
      const t = props.t
      const [status, setStatus] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [warning, setWarning] = useState('')
      const [pending, setPending] = useState('')
      const [confirm, setConfirm] = useState(null)
      const [restoreMode, setRestoreMode] = useState('full')
      const [retryCount, setRetryCount] = useState(0)
      const [backupPoll, setBackupPoll] = useState(false)
      const startedRef = useRef(false)

      const load = useCallback(
        async (options = {}) => {
          try {
            const body = await request(API.status)
            setStatus(body)
            if (!options.quiet) setError('')
            return body
          } catch (loadError) {
            if (!options.quiet) {
              setError(fmt(t('loadFailed'), { error: messageOf(loadError) }))
            }
            return null
          }
        },
        [t],
      )

      useEffect(() => {
        load().catch(() => {})
      }, [load])

      // A failed first read must not leave every control disabled: retry with
      // a bounded backoff (2 s, 4 s, 8 s, then 8 s) until one read succeeds.
      useEffect(() => {
        if (status !== null || !error) return undefined
        const timer = setTimeout(
          () => {
            setRetryCount((count) => count + 1)
            load().catch(() => {})
          },
          Math.min(8000, 2000 * 2 ** retryCount),
        )
        return () => clearTimeout(timer)
      }, [status, error, retryCount, load])

      const saves = Array.isArray(status?.saves) ? status.saves : []
      const maxSaves =
        typeof status?.maxSaves === 'number' && Number.isFinite(status.maxSaves)
          ? status.maxSaves
          : 3
      const busy = Boolean(status?.busy)
      const job = status?.job ?? null
      const jobPhase = typeof job?.phase === 'string' ? job.phase : ''
      const activeJob = Boolean(job) && (ACTIVE_PHASES.has(jobPhase) || job?.state === 'running')
      // `busy` covers backup, restore, delete and location changes; a job
      // marked running by a future backend keeps polling too. `backupPoll`
      // keeps polling after a POST /backup whose immediate refresh failed.
      const polling = backupPoll || busy || job?.state === 'running'

      useEffect(() => {
        if (!polling) return undefined
        const timer = setInterval(() => {
          load({ quiet: true }).catch(() => {})
        }, 1200)
        return () => clearInterval(timer)
      }, [polling, load])

      // A backup started from this page ends with `done` or `failed`; poll
      // results update the same job object, so watch its phase. `startedAt`
      // distinguishes a new job from a finished one left in `status`.
      useEffect(() => {
        if (!job || !startedRef.current) return
        if (job.phase === 'done') {
          startedRef.current = false
          setBackupPoll(false)
          setNotice(t('backupDone'))
          setError('')
        } else if (job.phase === 'failed') {
          startedRef.current = false
          setBackupPoll(false)
          setError(job.error || t('backupFailed'))
        }
      }, [job?.phase, job?.error, job?.startedAt, t])

      useEffect(() => {
        if (!notice) return undefined
        const timer = setTimeout(() => setNotice(''), 4000)
        return () => clearTimeout(timer)
      }, [notice])

      useEffect(() => {
        if (!confirm) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setConfirm(null)
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
      }, [confirm])

      const runAction = useCallback(
        async (kind, work) => {
          setPending(kind)
          setError('')
          setNotice('')
          setWarning('')
          try {
            return await work()
          } catch (actionError) {
            setError(fmt(t('actionFailed'), { error: messageOf(actionError) }))
            return null
          } finally {
            setPending('')
          }
        },
        [t],
      )

      const doRetry = () => {
        setRetryCount(0)
        load().catch(() => {})
      }

      const doBackup = () =>
        runAction('backup', async () => {
          const body = await request(API.backup, postJson({}))
          if (body?.warning) setWarning(body.warning)
          startedRef.current = true
          // The POST accepted a job even if the refresh below fails, so poll
          // independently of what `status` still says.
          setBackupPoll(true)
          await load()
        })

      const doOpenFolder = () => runAction('open', () => request(API.openFolder, postJson({})))

      const doChangeLocation = async () => {
        setPending('location')
        try {
          const picked = await request(API.pickFolder, postJson({}))
          // Cancelling the native picker must leave the current folder alone.
          if (picked?.canceled === true) return
          setError('')
          setNotice('')
          setWarning('')
          await request(API.location, postJson({ path: picked?.path }))
          setNotice(t('locationDone'))
          await load()
        } catch (locationError) {
          setError(fmt(t('actionFailed'), { error: messageOf(locationError) }))
        } finally {
          setPending('')
        }
      }

      const doRestore = (save) => {
        const mode = modeEntry(restoreMode)
        // The confirm button is disabled for this case; the guard also stops a
        // stale closure from launching a restore the save cannot support.
        if (!modeEnabled(mode, save)) return Promise.resolve(null)
        setConfirm(null)
        return runAction('restore', async () => {
          const body = await request(API.restore, postJson({ id: save.id, mode: mode.value }))
          if (body?.warning) setWarning(body.warning)
          setNotice(
            t(mode.value === 'plugins' ? 'restoreStartedPlugins' : 'restoreStartedFull'),
          )
          await load()
        })
      }

      const doDelete = (save) => {
        setConfirm(null)
        return runAction('delete', async () => {
          await request(API.delete, postJson({ id: save.id }))
          setNotice(t('deleteDone'))
          await load()
        })
      }

      const openRestore = (save) => {
        setRestoreMode('full')
        setConfirm({ kind: 'restore', save })
      }

      const actionDisabled = backupPoll || busy || Boolean(pending)
      const canBackup = status !== null && saves.length < maxSaves && !actionDisabled
      const progressLabel =
        activeJob && jobPhase ? phaseLabel(t, jobPhase) : t('processing')
      const percent =
        typeof job?.percent === 'number' && Number.isFinite(job.percent) ? job.percent : null
      const showBar = activeJob && percent !== null
      const width = showBar ? Math.max(0, Math.min(100, percent)) : 0
      const restoreModeEntry = modeEntry(restoreMode)
      // Gate the confirm button on the selected mode, not just the dialog kind:
      // an unavailable mode must not be submittable.
      const restoreModeAvailable = modeEnabled(restoreModeEntry, confirm?.save)

      return h(
        'div',
        { className: 'dcb-wrap' },
        h('style', { dangerouslySetInnerHTML: { __html: CSS } }),
        h(
          'header',
          { className: 'dcb-head' },
          h(
            'div',
            { className: 'dcb-head-main' },
            h('h2', { className: 'dcb-title' }, t('title')),
            h('p', { className: 'dcb-desc' }, t('desc')),
            h('p', { className: 'dcb-hint' }, t('crashHint')),
          ),
          h(
            'div',
            { className: 'dcb-head-right' },
            h(
              'span',
              { className: 'dcb-count' },
              fmt(t('count'), { count: saves.length, max: maxSaves }),
            ),
            h(
              'button',
              {
                className: 'dcb-btn dcb-btn-primary',
                type: 'button',
                disabled: !canBackup,
                onClick: doBackup,
              },
              pending === 'backup' ? t('backingUp') : t('backup'),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dcb-dir' },
          h(
            'div',
            { className: 'dcb-dir-info' },
            h('span', { className: 'dcb-dir-label' }, t('pathLabel')),
            h('span', { className: 'dcb-dir-path' }, status?.backupRoot ?? ''),
            status?.backupRootNote
              ? h('span', { className: 'dcb-dir-note' }, status.backupRootNote)
              : null,
            status && status.backupRootExists === false
              ? h(
                  'span',
                  { className: 'dcb-dir-note dcb-dir-note-warn' },
                  t('folderMissing'),
                )
              : null,
          ),
          h(
            'div',
            { className: 'dcb-dir-actions' },
            h(
              'button',
              {
                className: 'dcb-btn',
                type: 'button',
                disabled: status === null || actionDisabled,
                onClick: doOpenFolder,
              },
              t('openFolder'),
            ),
            h(
              'button',
              {
                className: 'dcb-btn',
                type: 'button',
                disabled: status === null || actionDisabled,
                onClick: doChangeLocation,
              },
              pending === 'location' ? t('choosingFolder') : t('changeFolder'),
            ),
          ),
        ),
        h('p', { className: 'dcb-warn' }, t('credentialWarning')),
        polling
          ? h(
              'div',
              { className: 'dcb-progress' },
              h('div', { className: 'dcb-progress-label' }, progressLabel),
              showBar
                ? h(
                    'div',
                    { className: 'dcb-progress-track' },
                    h('div', { className: 'dcb-progress-fill', style: { width: `${width}%` } }),
                  )
                : null,
            )
          : null,
        warning ? h('div', { className: 'dcb-banner dcb-banner-warn' }, warning) : null,
        error
          ? h(
              'div',
              { className: 'dcb-banner dcb-banner-error' },
              h('span', { className: 'dcb-banner-text' }, error),
              status === null
                ? h(
                    'button',
                    { className: 'dcb-btn dcb-retry', type: 'button', onClick: doRetry },
                    t('retry'),
                  )
                : null,
            )
          : null,
        notice ? h('div', { className: 'dcb-banner dcb-banner-ok' }, notice) : null,
        status === null
          ? null
          : saves.length === 0
            ? h('div', { className: 'dcb-empty' }, t('empty'))
            : h(
                'div',
                { className: 'dcb-list' },
                saves.map((save) =>
                  h(SaveCard, {
                    key: save.id,
                    save,
                    t,
                    disabled: actionDisabled,
                    onRestore: () => openRestore(save),
                    onDelete: () => setConfirm({ kind: 'delete', save }),
                  }),
                ),
              ),
        confirm
          ? h(
              'div',
              { className: 'dcb-backdrop', onClick: () => setConfirm(null), role: 'presentation' },
              h(
                'div',
                {
                  className: 'dcb-modal',
                  role: 'dialog',
                  'aria-modal': 'true',
                  'aria-label':
                    confirm.kind === 'restore'
                      ? t('restoreConfirmTitle')
                      : t('deleteConfirmTitle'),
                  onClick: (event) => event.stopPropagation(),
                },
                h(
                  'div',
                  { className: 'dcb-modal-title' },
                  confirm.kind === 'restore'
                    ? t('restoreConfirmTitle')
                    : t('deleteConfirmTitle'),
                ),
                h(
                  'div',
                  { className: 'dcb-modal-body' },
                  confirm.kind === 'restore'
                    ? t('restoreConfirmBody')
                    : t('deleteConfirmBody'),
                ),
                h(
                  'div',
                  { className: 'dcb-modal-target' },
                  `${formatDate(confirm.save.createdAt)} · ${confirm.save.id}`,
                ),
                confirm.kind === 'restore'
                  ? h(
                      'div',
                      {
                        className: 'dcb-modes',
                        role: 'radiogroup',
                        'aria-label': t('restoreModeLabel'),
                      },
                      RESTORE_MODES.map((mode) => {
                        const enabled = modeEnabled(mode, confirm.save)
                        const selected = restoreMode === mode.value
                        return h(
                          'label',
                          {
                            key: mode.value,
                            className: `dcb-mode${selected ? ' dcb-mode-selected' : ''}${enabled ? '' : ' dcb-mode-disabled'}`,
                          },
                          h('input', {
                            type: 'radio',
                            name: 'dcb-restore-mode',
                            value: mode.value,
                            checked: selected,
                            disabled: !enabled,
                            onChange: () => setRestoreMode(mode.value),
                          }),
                          h(
                            'span',
                            { className: 'dcb-mode-text' },
                            h('span', { className: 'dcb-mode-title' }, t(mode.labelKey)),
                            h(
                              'span',
                              { className: 'dcb-mode-desc' },
                              enabled
                                ? t(mode.descKey)
                                : t(mode.unavailableKey || 'modeUnavailable'),
                            ),
                          ),
                        )
                      }),
                    )
                  : null,
                h(
                  'div',
                  { className: 'dcb-modal-actions' },
                  h(
                    'button',
                    { className: 'dcb-btn', type: 'button', onClick: () => setConfirm(null) },
                    t('cancel'),
                  ),
                  h(
                    'button',
                    {
                      className: `dcb-btn ${confirm.kind === 'restore' ? 'dcb-btn-primary' : 'dcb-btn-danger'}`,
                      type: 'button',
                      disabled: confirm.kind === 'restore' && !restoreModeAvailable,
                      onClick: () =>
                        confirm.kind === 'restore'
                          ? doRestore(confirm.save)
                          : doDelete(confirm.save),
                    },
                    confirm.kind === 'restore' ? t('confirmRestore') : t('confirmDelete'),
                  ),
                ),
              ),
            )
          : null,
      )
    }

    function SaveCard(props) {
      const save = props.save
      const t = props.t
      const version = save.dshVersion
        ? fmt(t('version'), { version: save.dshVersion })
        : t('versionUnknown')
      const meta = [
        version,
        fmt(t('plugins'), { count: Number(save.pluginCount) || 0 }),
        formatBytes(save.sizeBytes),
      ].join(' · ')
      return h(
        'div',
        { className: 'dcb-card' },
        h(
          'div',
          { className: 'dcb-card-info' },
          h('div', { className: 'dcb-card-title' }, formatDate(save.createdAt)),
          h('div', { className: 'dcb-card-meta' }, meta),
          h('div', { className: 'dcb-card-id' }, save.id),
        ),
        h(
          'div',
          { className: 'dcb-card-actions' },
          h(
            'button',
            { className: 'dcb-btn', type: 'button', disabled: props.disabled, onClick: props.onRestore },
            t('restore'),
          ),
          h(
            'button',
            {
              className: 'dcb-btn dcb-btn-danger',
              type: 'button',
              disabled: props.disabled,
              onClick: props.onDelete,
            },
            t('delete'),
          ),
        ),
      )
    }

    async function request(pathname, init) {
      const response = await fetch(pathname, { cache: 'no-store', ...(init ?? {}) })
      let body = {}
      try {
        body = await response.json()
      } catch {
        body = {}
      }
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`)
      return body
    }

    function postJson(payload) {
      return {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload ?? {}),
      }
    }

    function phaseLabel(t, phase) {
      const key = PHASE_KEYS[phase]
      return key ? t(key) : String(phase ?? '')
    }

    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (match, key) =>
        values[key] === undefined ? match : String(values[key]),
      )
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    function formatDate(input) {
      if (!input) return ''
      const date = new Date(input)
      if (Number.isNaN(date.getTime())) return String(input)
      return date.toLocaleString(undefined, {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
    }

    function formatBytes(input) {
      const value = Number(input) || 0
      if (value < 1024) return `${value} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, DICTS), 'dsh-crash-backup: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: 'dsh-crash-backup',
            order: 46,
            label: () => t('nav'),
            locale: NS,
            inject: () => ({ t }),
          },
          (ownerProps) => h(Section, { ...ownerProps, t }),
        ),
      )
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
