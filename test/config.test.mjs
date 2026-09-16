// Config resolution for the two install forms.
//
// Publishing made this matter: the state paths used to be relative to the plugin
// root, which for an installed package is inside node_modules — an upgrade would
// throw the observation log and the ~6-minute card cache away. The default is now
// the harness home; a repo checkout keeps its relative overrides beside the code.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PLUGIN_ROOT, defaultStateDir, resolveConfig } from '../lib/config.js'

test('state defaults to the harness home (and honors DSH_HOME)', () => {
  const saved = process.env.DSH_HOME
  const fakeHome = join(tmpdir(), 'exp-recall-home')
  try {
    process.env.DSH_HOME = fakeHome
    assert.equal(defaultStateDir(), join(fakeHome, 'dsh-experience-recall'))
    const config = resolveConfig({})
    assert.equal(config.stateDir, join(fakeHome, 'dsh-experience-recall'))
    assert.equal(config.logPath, join(fakeHome, 'dsh-experience-recall', 'logs', 'observe.ndjson'))
    assert.equal(config.cardCachePath, join(fakeHome, 'dsh-experience-recall', 'cache', 'cards.json'))
    // An explicit stateDir wins over the environment.
    const explicit = resolveConfig({ stateDir: join(fakeHome, 'custom') })
    assert.equal(explicit.logPath, join(fakeHome, 'custom', 'logs', 'observe.ndjson'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('a relative path still resolves against the plugin root, and empty disables the cache', () => {
  const local = resolveConfig({ logPath: 'logs/observe.ndjson', cardCachePath: 'cache/cards.json' })
  assert.equal(local.logPath, join(PLUGIN_ROOT, 'logs', 'observe.ndjson'))
  assert.equal(local.cardCachePath, join(PLUGIN_ROOT, 'cache', 'cards.json'))
  assert.equal(resolveConfig({ cardCachePath: '' }).cardCachePath, '', 'an explicit empty string means no cache')
  // Absent (not empty) falls back to the state dir, so a missing key never means "disabled".
  assert.match(resolveConfig({}).cardCachePath, /cache[\\/]cards\.json$/)
})
