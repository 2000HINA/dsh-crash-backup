import test from 'node:test'
import assert from 'node:assert/strict'
import { PLUGIN_ID, API_ROUTE, SAVE_PREFIX, MAX_SAVES, SETTINGS_DIR_NAME } from '../lib/constants.js'

test('plugin identity constants', () => {
  assert.equal(PLUGIN_ID, 'dsh-crash-backup')
  assert.equal(API_ROUTE, '/dsh-crash-backup/api')
  assert.equal(SAVE_PREFIX, 'dsh-save-')
  assert.equal(MAX_SAVES, 3)
})

test('plugin data directory name', () => {
  assert.equal(SETTINGS_DIR_NAME, 'dsh-crash-backup')
})
