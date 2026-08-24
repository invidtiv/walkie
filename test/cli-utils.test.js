const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const os = require('os')
const fs = require('fs')
const path = require('path')

// Save/restore env between tests
const ENV_KEYS = ['WALKIE_ID', 'TERM_SESSION_ID', 'ITERM_SESSION_ID', 'WEZTERM_PANE', 'TMUX_PANE', 'WINDOWID']
let savedEnv
let savedDir
let tmpDir

beforeEach(() => {
  savedEnv = {}
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
  // Point WALKIE_DIR at a scratch dir so the developer's real ~/.walkie/config.json
  // can never influence identity resolution during tests.
  savedDir = process.env.WALKIE_DIR
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walkie-cfg-'))
  process.env.WALKIE_DIR = tmpDir
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k]
    else delete process.env[k]
  }
  if (savedDir !== undefined) process.env.WALKIE_DIR = savedDir
  else delete process.env.WALKIE_DIR
  try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
})

// Fresh require each time so env changes take effect
function load() {
  delete require.cache[require.resolve('../src/cli-utils')]
  return require('../src/cli-utils')
}

describe('parseChannelArg', () => {
  it('plain channel name defaults secret to channel', () => {
    const { parseChannelArg } = load()
    assert.deepEqual(parseChannelArg('ops'), { channel: 'ops', secret: 'ops' })
  })

  it('splits on first colon', () => {
    const { parseChannelArg } = load()
    assert.deepEqual(parseChannelArg('ops:mysecret'), { channel: 'ops', secret: 'mysecret' })
  })

  it('preserves colons in secret', () => {
    const { parseChannelArg } = load()
    assert.deepEqual(parseChannelArg('ops:my:complex:secret'), { channel: 'ops', secret: 'my:complex:secret' })
  })

  it('handles empty secret', () => {
    const { parseChannelArg } = load()
    assert.deepEqual(parseChannelArg('ops:'), { channel: 'ops', secret: '' })
  })
})

describe('clientId', () => {
  it('returns WALKIE_ID if set', () => {
    process.env.WALKIE_ID = 'alice'
    const { clientId } = load()
    assert.equal(clientId(), 'alice')
  })

  it('derives 8-char hex from TERM_SESSION_ID', () => {
    process.env.TERM_SESSION_ID = 'some-session-123'
    const { clientId } = load()
    const id = clientId()
    assert.equal(id.length, 8)
    assert.match(id, /^[0-9a-f]{8}$/)
  })

  it('returns undefined when no env vars set', () => {
    const { clientId } = load()
    assert.equal(clientId(), undefined)
  })
})

describe('chatName', () => {
  it('returns WALKIE_ID if set', () => {
    process.env.WALKIE_ID = 'bob'
    const { chatName } = load()
    assert.equal(chatName(), 'bob')
  })

  it('falls back to hostname prefix', () => {
    const { chatName } = load()
    const expected = os.hostname().split('.')[0]
    assert.equal(chatName(), expected)
  })
})

describe('persistent identity', () => {
  it('setIdentity round-trips through config.json', () => {
    const { setIdentity, clientId, configPath } = load()
    setIdentity('migration')
    assert.equal(clientId(), 'migration')
    assert.equal(JSON.parse(fs.readFileSync(configPath(), 'utf8')).id, 'migration')
  })

  it('WALKIE_ID takes precedence over config', () => {
    const { setIdentity, resolveIdentity } = load()
    setIdentity('from-config')
    process.env.WALKIE_ID = 'from-env'
    assert.deepEqual(resolveIdentity(), { id: 'from-env', source: 'env' })
  })

  it('config takes precedence over a terminal session hash', () => {
    const { setIdentity, resolveIdentity } = load()
    setIdentity('from-config')
    process.env.TERM_SESSION_ID = 'some-session-123'
    assert.deepEqual(resolveIdentity(), { id: 'from-config', source: 'config' })
  })

  it('falls back to the session hash when nothing is stored', () => {
    process.env.TERM_SESSION_ID = 'some-session-123'
    const { resolveIdentity } = load()
    const { id, source } = resolveIdentity()
    assert.equal(source, 'session')
    assert.match(id, /^[0-9a-f]{8}$/)
  })

  it('reports no identity when there is nothing to go on', () => {
    const { resolveIdentity } = load()
    assert.deepEqual(resolveIdentity(), { id: undefined, source: 'none' })
  })

  it('survives a corrupt config file', () => {
    const { configPath } = load()
    fs.mkdirSync(path.dirname(configPath()), { recursive: true })
    fs.writeFileSync(configPath(), 'not json at all')
    const { resolveIdentity } = load()
    assert.equal(resolveIdentity().source, 'none')
  })
})

describe('identity stability', () => {
  it('env and config are stable', () => {
    const { setIdentity, isStableIdentity, identityWarning } = load()
    setIdentity('agent-a')
    assert.equal(isStableIdentity(), true)
    assert.equal(identityWarning(), null)
  })

  it('a session hash is flagged unstable', () => {
    process.env.TMUX_PANE = '%3'
    const { isStableIdentity, identityWarning } = load()
    assert.equal(isStableIdentity(), false)
    assert.match(identityWarning(), /change in a new shell/)
  })

  it('no identity is flagged unstable and names the default', () => {
    const { isStableIdentity, identityWarning } = load()
    assert.equal(isStableIdentity(), false)
    assert.match(identityWarning(), /default/)
  })
})

describe('chatName with stored identity', () => {
  it('prefers a stored id over the hostname', () => {
    const { setIdentity, chatName } = load()
    setIdentity('stored-name')
    assert.equal(chatName(), 'stored-name')
  })

  it('ignores an unstable session hash and uses the hostname', () => {
    process.env.TERM_SESSION_ID = 'some-session-123'
    const { chatName } = load()
    assert.equal(chatName(), os.hostname().split('.')[0])
  })
})
