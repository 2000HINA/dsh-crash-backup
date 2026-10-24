import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  detectInstallDir,
  detectHome,
  defaultBackupRoot,
  resolveSettings,
} from '../lib/config.js'
import { MAX_SAVES } from '../lib/constants.js'
import { saveBackupRoot } from '../lib/settings.js'

test('install dir is the folder holding the executable', () => {
  assert.equal(detectInstallDir('C:\\tool\\dsh\\DeepSeek Harness.exe'), 'C:\\tool\\dsh')
})

test('DSH_HOME overrides the default home', () => {
  assert.equal(detectHome({ DSH_HOME: 'D:\\dsh-home' }, 'C:\\Users\\a'), 'D:\\dsh-home')
  assert.equal(detectHome({}, 'C:\\Users\\a'), 'C:\\Users\\a\\.dsh')
})

test('blank DSH_HOME falls back to the user home', () => {
  assert.equal(detectHome({ DSH_HOME: '   ' }, 'C:\\Users\\a'), 'C:\\Users\\a\\.dsh')
  assert.equal(detectHome({ DSH_HOME: '  D:\\dsh-home  ' }, 'C:\\Users\\a'), 'D:\\dsh-home')
})

test('default backup root sits next to the install dir', () => {
  assert.equal(defaultBackupRoot('C:\\tool\\dsh'), 'C:\\tool\\dsh-backups')
})

test('resolveSettings derives home, profile and the default backup root', () => {
  const settings = resolveSettings({
    config: {},
    execPath: 'C:\\tool\\dsh\\DeepSeek Harness.exe',
    env: {},
    homedir: 'C:\\Users\\a',
  })
  assert.deepEqual(settings, {
    installDir: 'C:\\tool\\dsh',
    home: 'C:\\Users\\a\\.dsh',
    profile: 'desktop',
    profileDir: 'C:\\Users\\a\\.dsh\\profiles\\desktop',
    backupRoot: 'C:\\tool\\dsh-backups',
    backupRootSource: 'default',
    maxSaves: MAX_SAVES,
  })
})

test('resolveSettings honours backupRoot and profile overrides as absolute paths', () => {
  const settings = resolveSettings({
    config: { backupRoot: 'E:\\dsh-archives\\..\\backups', profile: 'work' },
    execPath: 'C:\\tool\\dsh\\DeepSeek Harness.exe',
    env: { DSH_HOME: 'D:\\dsh-home' },
    homedir: 'C:\\Users\\a',
  })
  assert.equal(settings.installDir, 'C:\\tool\\dsh')
  assert.equal(settings.home, 'D:\\dsh-home')
  assert.equal(settings.profile, 'work')
  assert.equal(settings.profileDir, 'D:\\dsh-home\\profiles\\work')
  assert.equal(settings.backupRoot, 'E:\\backups')
  assert.equal(settings.backupRootSource, 'override')
  assert.equal(settings.maxSaves, MAX_SAVES)
})

test('a saved settings.json wins over the default backup root', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-config-'))
  await saveBackupRoot(home, 'E:\\saved-backups')
  const settings = resolveSettings({
    config: {},
    execPath: 'C:\\tool\\dsh\\DeepSeek Harness.exe',
    env: { DSH_HOME: home },
    homedir: 'C:\\Users\\a',
  })
  assert.equal(settings.home, home)
  assert.equal(settings.backupRoot, 'E:\\saved-backups')
  assert.equal(settings.backupRootSource, 'saved')
})

test('an explicit config.backupRoot still wins over the saved one', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-config-'))
  await saveBackupRoot(home, 'E:\\saved-backups')
  const settings = resolveSettings({
    config: { backupRoot: 'F:\\chosen' },
    execPath: 'C:\\tool\\dsh\\DeepSeek Harness.exe',
    env: { DSH_HOME: home },
    homedir: 'C:\\Users\\a',
  })
  assert.equal(settings.backupRoot, 'F:\\chosen')
  assert.equal(settings.backupRootSource, 'override')
})
