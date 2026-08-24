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

describe('makeMessageFilter', () => {
  const sys = { from: 'system', data: 'bob joined' }
  const daemon = { from: 'daemon', data: 'note' }
  const mine = { from: 'alice', data: 'mine' }
  const theirs = { from: 'bob', data: 'theirs' }
  const all = [sys, daemon, mine, theirs]

  function apply(opts) {
    const { makeMessageFilter } = load()
    return all.filter(makeMessageFilter(opts, 'alice')).map(m => m.from)
  }

  it('passes everything by default', () => {
    assert.deepEqual(apply({}), ['system', 'daemon', 'alice', 'bob'])
  })

  it('--no-system drops system and daemon traffic', () => {
    assert.deepEqual(apply({ system: false }), ['alice', 'bob'])
  })

  it('--from-others drops your own messages', () => {
    assert.deepEqual(apply({ fromOthers: true }), ['system', 'daemon', 'bob'])
  })

  it('--from selects a single sender', () => {
    assert.deepEqual(apply({ from: 'bob' }), ['bob'])
  })

  it('filters compose', () => {
    assert.deepEqual(apply({ system: false, fromOthers: true }), ['bob'])
  })

  it('an absent identity still filters against "default"', () => {
    const { makeMessageFilter } = load()
    const msgs = [{ from: 'default', data: 'x' }, { from: 'bob', data: 'y' }]
    const kept = msgs.filter(makeMessageFilter({ fromOthers: true }, 'default'))
    assert.deepEqual(kept.map(m => m.from), ['bob'])
  })

  it('keeps system messages when only --from-others is set', () => {
    // --from-others and --no-system are independent; one must not imply the other.
    assert.ok(apply({ fromOthers: true }).includes('system'))
  })
})

describe('EXIT codes', () => {
  it('keeps 0 and 1 at their historical meanings', () => {
    const { EXIT } = load()
    assert.equal(EXIT.OK, 0)
    assert.equal(EXIT.ERROR, 1)
  })

  it('gives each agent-branchable outcome a distinct code', () => {
    const { EXIT } = load()
    const codes = Object.values(EXIT)
    assert.equal(new Set(codes).size, codes.length, 'exit codes must be unique')
    assert.equal(EXIT.NOT_IN_CHANNEL, 2)
    assert.equal(EXIT.NOTHING_QUEUED, 3)
    assert.equal(EXIT.TIMEOUT, 4)
  })
})

describe('drainAfterWake', () => {
  // Virtual clock: every sleep advances time, so these run instantly and
  // deterministically — no two machines and no wall-clock races needed.
  function harness(script, { settleMs = 200, capMs = 5000 } = {}) {
    let t = 0
    const now = () => t
    const sleep = async (ms) => { t += ms }
    let call = 0
    const read = async () => {
      const batch = script[call++]
      return batch || []
    }
    return { now, sleep, read, settleMs, capMs, calls: () => call }
  }

  it('does NOT stop on the first empty read', async () => {
    // The regression this exists for: at the moment a waiter is woken the buffer is
    // empty, because the waking message went straight to the waiter. Stopping there
    // returns nothing and strands the rest of the burst.
    const { drainAfterWake } = load()
    const h = harness([[], [], [{ data: 'b' }], [{ data: 'c' }]])
    const got = await drainAfterWake(h)
    assert.deepEqual(got.map(m => m.data), ['b', 'c'])
  })

  it('keeps collecting while messages keep arriving', async () => {
    const { drainAfterWake } = load()
    const script = []
    for (let i = 0; i < 10; i++) script.push([], [{ data: `m${i}` }])
    const got = await drainAfterWake(harness(script))
    assert.equal(got.length, 10)
  })

  it('returns once the channel has been quiet for settleMs', async () => {
    const { drainAfterWake } = load()
    // 25ms tick, 200ms settle -> gives up after 8 consecutive empty reads.
    const h = harness([[{ data: 'x' }]], { settleMs: 200 })
    const got = await drainAfterWake(h)
    assert.deepEqual(got.map(m => m.data), ['x'])
    assert.ok(h.calls() <= 12, 'must stop polling once quiet, not spin')
  })

  it('returns nothing when the channel is silent throughout', async () => {
    const { drainAfterWake } = load()
    assert.deepEqual(await drainAfterWake(harness([])), [])
  })

  it('honours capMs under sustained traffic', async () => {
    const { drainAfterWake } = load()
    // Never goes quiet: without a cap this would never return.
    const forever = { read: async () => [{ data: 'flood' }], settleMs: 200, capMs: 1000 }
    let t = 0
    forever.now = () => t
    forever.sleep = async (ms) => { t += ms }
    // Each read returns immediately without sleeping, so advance the clock per read.
    forever.read = async () => { t += 10; return [{ data: 'flood' }] }
    const got = await drainAfterWake(forever)
    assert.ok(got.length > 0)
    assert.ok(t <= 1100, `must stop at the cap, stopped at ${t}ms`)
  })

  it('a longer settle window tolerates wider gaps', async () => {
    const { drainAfterWake } = load()
    // Nine empty 25ms ticks = 225ms of quiet between messages.
    const gap = [[], [], [], [], [], [], [], [], []]
    const script = [...gap, [{ data: 'late' }]]
    assert.deepEqual((await drainAfterWake(harness(script, { settleMs: 200 }))).length, 0,
      'a gap wider than settleMs ends the drain — this is a heuristic, not a guarantee')
    assert.deepEqual((await drainAfterWake(harness(script, { settleMs: 400 }))).map(m => m.data), ['late'])
  })
})
