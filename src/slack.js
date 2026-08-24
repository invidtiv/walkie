const https = require('https')
const WebSocket = require('ws')
const { request, streamMessages, ensureDaemon } = require('./client')

function slackApi(method, token, body = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: 'slack.com',
      path: `/api/${method}`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let buf = ''
      res.on('data', chunk => buf += chunk)
      res.on('end', () => {
        try { resolve(JSON.parse(buf)) } catch (e) { reject(e) }
      })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function resolveSlackChannel(token, input) {
  if (/^C[A-Z0-9]{8,}$/i.test(input)) return input

  const name = input.replace(/^#/, '')
  let cursor
  do {
    const body = { types: 'public_channel,private_channel', limit: 200 }
    if (cursor) body.cursor = cursor
    const resp = await slackApi('conversations.list', token, body)
    if (!resp.ok) throw new Error(`Slack API error: ${resp.error}`)
    for (const ch of resp.channels) {
      if (ch.name === name) return ch.id
    }
    cursor = resp.response_metadata?.next_cursor
  } while (cursor)

  throw new Error(`Slack channel "${input}" not found. Use channel ID (starts with C) or exact name.`)
}

function cleanSlackText(text) {
  return text
    .replace(/<@(U[A-Z0-9]+)>/g, '@$1')
    .replace(/<#C[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

async function startSlackBridge(opts) {
  const { botToken, appToken, channel, secret, slackChannel: slackChannelInput, id } = opts
  const bridgeId = id || 'slack-bridge'

  await ensureDaemon()

  // Resolve Slack channel (name → ID if needed)
  const slackChannelId = await resolveSlackChannel(botToken, slackChannelInput)

  // Get Slack channel display name
  let slackChannelName = slackChannelId
  try {
    const info = await slackApi('conversations.info', botToken, { channel: slackChannelId })
    if (info.ok) slackChannelName = '#' + info.channel.name
  } catch {}

  // Join walkie channel
  const joinResp = await request({ action: 'join', channel, secret, clientId: bridgeId })
  if (!joinResp.ok) throw new Error(`Failed to join walkie: ${joinResp.error}`)

  // Get bot's own user ID (to filter self-messages)
  let botUserId = null
  try {
    const auth = await slackApi('auth.test', botToken, {})
    if (auth.ok) botUserId = auth.user_id
  } catch {}

  // Slack user name cache
  const userCache = new Map()
  async function getUserName(userId) {
    if (userCache.has(userId)) return userCache.get(userId)
    try {
      const resp = await slackApi('users.info', botToken, { user: userId })
      if (resp.ok) {
        const name = resp.user.profile.display_name || resp.user.real_name || resp.user.name
        userCache.set(userId, name)
        return name
      }
    } catch {}
    return userId
  }

  // Resolve @U12345 mentions to @username
  async function resolveText(text) {
    let clean = cleanSlackText(text)
    const mentions = clean.match(/@(U[A-Z0-9]+)/g) || []
    for (const m of mentions) {
      const name = await getUserName(m.slice(1))
      clean = clean.replace(m, `@${name}`)
    }
    return clean
  }

  const abort = { aborted: false, socket: null }

  // --- Slack → walkie (Socket Mode) ---
  let ws = null

  async function connectSocket() {
    const connResp = await slackApi('apps.connections.open', appToken, {})
    if (!connResp.ok) throw new Error(`Socket Mode failed: ${connResp.error}`)

    const sock = new WebSocket(connResp.url)

    sock.on('open', () => {
      console.log('  Slack connected (Socket Mode)')
    })

    sock.on('message', async (raw) => {
      let envelope
      try { envelope = JSON.parse(raw) } catch { return }

      // Acknowledge every envelope
      if (envelope.envelope_id) {
        sock.send(JSON.stringify({ envelope_id: envelope.envelope_id }))
      }

      if (envelope.type === 'events_api' && envelope.payload?.event) {
        const event = envelope.payload.event
        if (event.type !== 'message' || event.channel !== slackChannelId) return
        // Skip bot messages, edits, joins, etc.
        if (event.subtype || event.bot_id || event.user === botUserId) return

        const text = await resolveText(event.text || '')
        if (!text.trim()) return

        const userName = await getUserName(event.user)
        console.log(`  slack \u2192 walkie: ${userName}: ${text.slice(0, 80)}`)

        try {
          await request({
            action: 'send',
            channel,
            message: text,
            clientId: `slack:${userName}`
          })
        } catch (e) {
          console.error(`  Forward to walkie failed: ${e.message}`)
        }
      }

      // Slack sends disconnect before rotating connections
      if (envelope.type === 'disconnect') {
        console.log('  Slack requested disconnect, reconnecting...')
        sock.close()
      }
    })

    sock.on('close', () => {
      if (!abort.aborted) {
        console.log('  Slack disconnected, reconnecting in 5s...')
        setTimeout(() => {
          if (!abort.aborted) {
            connectSocket().then(s => { ws = s }).catch(e => {
              console.error(`  Reconnect failed: ${e.message}`)
            })
          }
        }, 5000)
      }
    })

    sock.on('error', (e) => {
      if (!abort.aborted) console.error(`  Slack error: ${e.message}`)
    })

    return sock
  }

  ws = await connectSocket()

  // --- walkie → Slack ---
  streamMessages(channel, secret, bridgeId, abort, async (msg) => {
    // Skip messages originating from Slack (avoid loops)
    if (msg.from.startsWith('slack:')) return
    if (msg.from === bridgeId || msg.from === 'system') return

    console.log(`  walkie \u2192 slack: ${msg.from}: ${msg.data.slice(0, 80)}`)

    try {
      await slackApi('chat.postMessage', botToken, {
        channel: slackChannelId,
        text: `*${msg.from}*: ${msg.data}`
      })
    } catch (e) {
      console.error(`  Forward to Slack failed: ${e.message}`)
    }
  })

  return {
    slackChannelName,
    slackChannelId,
    bridgeId,
    close: async () => {
      abort.aborted = true
      if (abort.socket) try { abort.socket.destroy() } catch {}
      if (ws) try { ws.close() } catch {}
      try { await request({ action: 'leave', channel, clientId: bridgeId }) } catch {}
    }
  }
}

module.exports = { startSlackBridge }
