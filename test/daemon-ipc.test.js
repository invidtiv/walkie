const { describe, it, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { createTempDir, ipc, startDaemon, stopDaemon, cleanupDir, SECRET } = require('./helpers')

let tmpDir, sockPath

before(async () => {
  tmpDir = createTempDir()
  const d = await startDaemon(tmpDir)
  sockPath = d.sockPath
})

after(async () => {
  await stopDaemon(sockPath)
  cleanupDir(tmpDir)
})

describe('ping', () => {
  it('returns ok', async () => {
    const r = await ipc(sockPath, { action: 'ping' })
    assert.equal(r.ok, true)
  })
})

describe('unknown action', () => {
  it('returns error', async () => {
    const r = await ipc(sockPath, { action: 'bogus' })
    assert.equal(r.ok, false)
    assert.match(r.error, /Unknown action/)
  })
})

describe('status', () => {
  it('returns empty channels on fresh daemon', async () => {
    const r = await ipc(sockPath, { action: 'status' })
    assert.equal(r.ok, true)
    assert.ok(r.daemonId)
    assert.deepEqual(r.channels, {})
  })
})

describe('join + status', () => {
  it('shows channel after join', async () => {
    const r = await ipc(sockPath, { action: 'join', channel: 'ch1', secret: SECRET, clientId: 'alice' })
    assert.equal(r.ok, true)

    const s = await ipc(sockPath, { action: 'status' })
    assert.ok(s.channels.ch1)
    assert.equal(s.channels.ch1.subscribers, 1)
  })

  it('is idempotent', async () => {
    const r = await ipc(sockPath, { action: 'join', channel: 'ch1', secret: SECRET, clientId: 'alice' })
    assert.equal(r.ok, true)
    // Still just 1 subscriber
    const s = await ipc(sockPath, { action: 'status' })
    assert.equal(s.channels.ch1.subscribers, 1)
  })
})

describe('send + read', () => {
  it('send to non-joined channel returns error', async () => {
    const r = await ipc(sockPath, { action: 'send', channel: 'nonexistent', message: 'hi', clientId: 'x' })
    assert.equal(r.ok, false)
  })

  it('delivers messages to other subscribers, excludes sender', async () => {
    await ipc(sockPath, { action: 'join', channel: 'ch2', secret: SECRET, clientId: 'alice' })
    await ipc(sockPath, { action: 'join', channel: 'ch2', secret: SECRET, clientId: 'bob' })
    // Drain any system announcements from joins
    await ipc(sockPath, { action: 'read', channel: 'ch2', clientId: 'alice' })
    await ipc(sockPath, { action: 'read', channel: 'ch2', clientId: 'bob' })

    const send = await ipc(sockPath, { action: 'send', channel: 'ch2', message: 'hello', clientId: 'alice' })
    assert.equal(send.ok, true)
    assert.ok(send.delivered >= 1)

    // Bob should have the message
    const bobRead = await ipc(sockPath, { action: 'read', channel: 'ch2', clientId: 'bob' })
    assert.equal(bobRead.ok, true)
    const userMsgs = bobRead.messages.filter(m => m.from !== 'system')
    assert.equal(userMsgs.length, 1)
    assert.equal(userMsgs[0].data, 'hello')
    assert.equal(userMsgs[0].from, 'alice')

    // Alice should NOT have her own message
    const aliceRead = await ipc(sockPath, { action: 'read', channel: 'ch2', clientId: 'alice' })
    assert.equal(aliceRead.ok, true)
    const own = aliceRead.messages.filter(m => m.data === 'hello')
    assert.equal(own.length, 0)
  })

  it('read with no messages returns empty array', async () => {
    await ipc(sockPath, { action: 'join', channel: 'ch-empty', secret: SECRET, clientId: 'reader' })
    const r = await ipc(sockPath, { action: 'read', channel: 'ch-empty', clientId: 'reader' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.messages, [])
  })

  it('read on non-joined channel returns error', async () => {
    const r = await ipc(sockPath, { action: 'read', channel: 'never-joined', clientId: 'ghost' })
    assert.equal(r.ok, false)
  })
})

describe('read --wait', () => {
  it('with timeout returns empty after timeout', async () => {
    await ipc(sockPath, { action: 'join', channel: 'ch-wait', secret: SECRET, clientId: 'waiter' })
    // Drain any system messages
    await ipc(sockPath, { action: 'read', channel: 'ch-wait', clientId: 'waiter' })

    const start = Date.now()
    const r = await ipc(sockPath, { action: 'read', channel: 'ch-wait', clientId: 'waiter', wait: true, timeout: 1 })
    const elapsed = Date.now() - start
    assert.equal(r.ok, true)
    assert.deepEqual(r.messages, [])
    assert.ok(elapsed >= 900, `Expected >=900ms, got ${elapsed}ms`)
  })

  it('resolves when a message arrives', async () => {
    await ipc(sockPath, { action: 'join', channel: 'ch-wait2', secret: SECRET, clientId: 'sender2' })
    await ipc(sockPath, { action: 'join', channel: 'ch-wait2', secret: SECRET, clientId: 'waiter2' })
    // Drain system messages
    await ipc(sockPath, { action: 'read', channel: 'ch-wait2', clientId: 'waiter2' })

    // Start a waiting read (with generous timeout)
    const readPromise = ipc(sockPath, { action: 'read', channel: 'ch-wait2', clientId: 'waiter2', wait: true, timeout: 10 }, 15000)

    // Send a message after a short delay
    await new Promise(r => setTimeout(r, 200))
    await ipc(sockPath, { action: 'send', channel: 'ch-wait2', message: 'wake up', clientId: 'sender2' })

    const r = await readPromise
    assert.equal(r.ok, true)
    assert.equal(r.messages.length, 1)
    assert.equal(r.messages[0].data, 'wake up')
  })
})

describe('leave', () => {
  it('removes subscriber', async () => {
    await ipc(sockPath, { action: 'join', channel: 'ch-leave', secret: SECRET, clientId: 'leaver' })
    const s1 = await ipc(sockPath, { action: 'status' })
    assert.equal(s1.channels['ch-leave'].subscribers, 1)

    await ipc(sockPath, { action: 'leave', channel: 'ch-leave', clientId: 'leaver' })
    // Channel should be fully removed since no subscribers remain
    const s2 = await ipc(sockPath, { action: 'status' })
    assert.equal(s2.channels['ch-leave'], undefined)
  })

  it('announces leave to remaining subscribers', async () => {
    await ipc(sockPath, { action: 'join', channel: 'ch-announce', secret: SECRET, clientId: 'stayer' })
    await ipc(sockPath, { action: 'join', channel: 'ch-announce', secret: SECRET, clientId: 'goer' })
    // Drain join announcements
    await ipc(sockPath, { action: 'read', channel: 'ch-announce', clientId: 'stayer' })

    await ipc(sockPath, { action: 'leave', channel: 'ch-announce', clientId: 'goer' })

    const r = await ipc(sockPath, { action: 'read', channel: 'ch-announce', clientId: 'stayer' })
    assert.equal(r.ok, true)
    const sysMsg = r.messages.find(m => m.from === 'system' && m.data.includes('goer') && m.data.includes('left'))
    assert.ok(sysMsg, 'Expected system leave announcement')
  })
})

describe('join announcements', () => {
  it('announces new subscriber to existing ones', async () => {
    await ipc(sockPath, { action: 'join', channel: 'ch-join-ann', secret: SECRET, clientId: 'first' })
    // Drain
    await ipc(sockPath, { action: 'read', channel: 'ch-join-ann', clientId: 'first' })

    await ipc(sockPath, { action: 'join', channel: 'ch-join-ann', secret: SECRET, clientId: 'second' })

    const r = await ipc(sockPath, { action: 'read', channel: 'ch-join-ann', clientId: 'first' })
    const sysMsg = r.messages.find(m => m.from === 'system' && m.data.includes('second') && m.data.includes('joined'))
    assert.ok(sysMsg, 'Expected system join announcement')
  })
})

describe('persistence', () => {
  it('join with persist writes to disk on send', async () => {
    const fs = require('fs')
    const path = require('path')
    await ipc(sockPath, { action: 'join', channel: 'ch-persist', secret: SECRET, clientId: 'writer', persist: true })
    await ipc(sockPath, { action: 'send', channel: 'ch-persist', message: 'saved', clientId: 'writer' })

    const fp = path.join(tmpDir, 'messages', 'ch-persist.jsonl')
    assert.ok(fs.existsSync(fp), 'Expected .jsonl file on disk')
    const content = fs.readFileSync(fp, 'utf8')
    assert.ok(content.includes('saved'))
  })

  it('status shows persist info', async () => {
    const s = await ipc(sockPath, { action: 'status' })
    assert.equal(s.channels['ch-persist'].persist, true)
    assert.ok(typeof s.channels['ch-persist'].stored === 'number')
  })
})

describe('status bufferedBy', () => {
  it('reports unread depth per subscriber, not just in aggregate', async () => {
    const ch = 'buf-detail'
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'reader-a' })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'reader-b' })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'writer' })

    // reader-a drains; reader-b does not, so their depths must differ.
    await ipc(sockPath, { action: 'send', channel: ch, message: 'one', clientId: 'writer' })
    await ipc(sockPath, { action: 'send', channel: ch, message: 'two', clientId: 'writer' })
    await ipc(sockPath, { action: 'read', channel: ch, clientId: 'reader-a' })

    const r = await ipc(sockPath, { action: 'status' })
    const info = r.channels[ch]
    assert.ok(info.bufferedBy, 'status must expose a per-subscriber breakdown')
    assert.equal(info.bufferedBy['reader-a'], 0)
    assert.ok(info.bufferedBy['reader-b'] >= 2)
    // A joiner must not receive its own "X joined" notice.
    assert.equal(info.bufferedBy['writer'], 0)
    // Aggregate alone could not have distinguished these.
    assert.equal(info.buffered, Object.values(info.bufferedBy).reduce((a, b) => a + b, 0))
  })
})

describe('read --wait leaves a burst buffered', () => {
  // Documents the semantics the CLI's --drain flag exists to paper over: a parked
  // waiter is woken with a single message, and the rest of a burst sit in the buffer
  // until a follow-up read collects them. --drain issues that follow-up read for you.
  it('wakes on one message and leaves the remainder for the next read', async () => {
    const ch = 'wait-drain'
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'waiter' })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'sender' })
    // Drain the join announcements so only the burst is in play.
    await ipc(sockPath, { action: 'read', channel: ch, clientId: 'waiter' })

    const pending = ipc(sockPath, { action: 'read', channel: ch, clientId: 'waiter', wait: true, timeout: 10 })
    await new Promise(r => setTimeout(r, 150))

    for (const m of ['a', 'b', 'c']) {
      await ipc(sockPath, { action: 'send', channel: ch, message: m, clientId: 'sender' })
    }

    const woke = await pending
    assert.equal(woke.ok, true)
    assert.ok(woke.messages.length >= 1)
    assert.ok(woke.messages.length < 3, 'a wake does not carry the whole burst')

    // Wake plus follow-up must together account for every message and lose none.
    // This is the invariant --drain relies on, and it holds however much the wake
    // itself manages to batch.
    const rest = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'waiter' })
    assert.equal(rest.ok, true)
    const seen = [...woke.messages, ...rest.messages].map(m => m.data)
    assert.deepEqual(seen, ['a', 'b', 'c'])
  })
})

describe('secret change preserves other subscribers', () => {
  it('rejoining with a new secret does not drop existing subscribers', async () => {
    const ch = 'secret-swap'
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'stayer' })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'switcher' })
    await ipc(sockPath, { action: 'read', channel: ch, clientId: 'stayer' })

    // switcher rejoins with a different secret, which swaps the swarm topic.
    const r = await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET + '-alt', clientId: 'switcher' })
    assert.equal(r.ok, true)

    const st = await ipc(sockPath, { action: 'status' })
    const info = st.channels[ch]
    assert.ok(info, 'channel must still exist after the topic swap')
    assert.ok(info.bufferedBy['stayer'] !== undefined,
      'a subscriber that did not change its secret must survive the rejoin')

    // And it must still receive traffic on the channel.
    await ipc(sockPath, { action: 'send', channel: ch, message: 'after swap', clientId: 'switcher' })
    const got = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'stayer' })
    assert.ok(got.messages.some(m => m.data === 'after swap'),
      'surviving subscriber must still receive messages')
  })
})

describe('peek', () => {
  it('returns buffered messages without consuming them', async () => {
    const ch = 'peek-ch'
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'r' })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'w' })
    await ipc(sockPath, { action: 'read', channel: ch, clientId: 'r' })
    await ipc(sockPath, { action: 'send', channel: ch, message: 'kept', clientId: 'w' })

    const a = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'r', peek: true })
    assert.equal(a.peeked, true)
    assert.equal(a.messages.length, 1)
    assert.equal(a.unread, 1)

    // A second peek must see the same message — peeking is not a read.
    const b = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'r', peek: true })
    assert.equal(b.messages.length, 1)
    assert.equal(b.messages[0].data, 'kept')

    // A real read still drains it.
    const c = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'r' })
    assert.equal(c.messages.length, 1)
    const d = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'r', peek: true })
    assert.equal(d.messages.length, 0)
  })
})

describe('directed send', () => {
  it('delivers only to the addressed subscriber', async () => {
    const ch = 'unicast-ch'
    for (const id of ['sender', 'target', 'bystander']) {
      await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: id })
    }
    for (const id of ['target', 'bystander']) {
      await ipc(sockPath, { action: 'read', channel: ch, clientId: id })
    }

    const r = await ipc(sockPath, { action: 'send', channel: ch, message: 'private', clientId: 'sender', to: 'target' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.recipients, ['target'])

    const t = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'target' })
    assert.ok(t.messages.some(m => m.data === 'private'))

    const b = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'bystander' })
    assert.ok(!b.messages.some(m => m.data === 'private'),
      'a bystander must not receive a directed message')
  })
})

describe('per-channel sequence', () => {
  it('assigns a monotonic local seq to each message', async () => {
    const ch = 'seq-ch'
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'r' })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'w' })
    await ipc(sockPath, { action: 'read', channel: ch, clientId: 'r' })

    for (const m of ['a', 'b', 'c']) {
      await ipc(sockPath, { action: 'send', channel: ch, message: m, clientId: 'w' })
    }
    const got = await ipc(sockPath, { action: 'read', channel: ch, clientId: 'r' })
    const seqs = got.messages.map(m => m.seq)
    assert.equal(seqs.length, 3)
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i] > seqs[i - 1], 'seq must increase monotonically')
    }
  })
})

describe('send reports unread depth', () => {
  it('tells the sender how many messages it has not read', async () => {
    const ch = 'unread-ch'
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'talker' })
    await ipc(sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'other' })
    await ipc(sockPath, { action: 'read', channel: ch, clientId: 'talker' })

    await ipc(sockPath, { action: 'send', channel: ch, message: 'incoming', clientId: 'other' })
    const r = await ipc(sockPath, { action: 'send', channel: ch, message: 'crossing', clientId: 'talker' })
    assert.equal(r.ok, true)
    assert.ok(r.unread >= 1, 'sender must see that something arrived while it was composing')
    assert.ok(r.msgId, 'send must return the id so a reply can be correlated')
  })
})

describe('subscriber reaping', () => {
  it('drops idle empty subscribers but never one holding messages', async () => {
    process.env.WALKIE_SUBSCRIBER_TTL_MS = '1'
    const dir = createTempDir()
    const d = await startDaemon(dir)
    try {
      const ch = 'reap-ch'
      await ipc(d.sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'idle' })
      await ipc(d.sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'holder' })
      await ipc(d.sockPath, { action: 'join', channel: ch, secret: SECRET, clientId: 'writer' })
      await ipc(d.sockPath, { action: 'read', channel: ch, clientId: 'idle' })
      // holder keeps an unread message, so it must survive regardless of idleness.
      await ipc(d.sockPath, { action: 'send', channel: ch, message: 'held', clientId: 'writer', to: 'holder' })

      await new Promise(r => setTimeout(r, 1200))
      const st = await ipc(d.sockPath, { action: 'status' })
      const info = st.channels[ch]
      assert.ok(info.bufferedBy['holder'] >= 1, 'a subscriber holding messages is never reaped')
      assert.equal(info.bufferedBy['idle'], undefined, 'an idle empty subscriber is reaped')
    } finally {
      delete process.env.WALKIE_SUBSCRIBER_TTL_MS
      await stopDaemon(d.sockPath)
      cleanupDir(dir)
    }
  })
})
