const net = require('net')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const fs = require('fs')
const { isWalkieProcess } = require('./cli-utils')

const IS_WINDOWS = process.platform === 'win32'
const WALKIE_DIR = process.env.WALKIE_DIR || path.join(os.homedir(), '.walkie')
const IPC_PATH = IS_WINDOWS
  ? '\\\\.\\pipe\\walkie-' + require('crypto').createHash('sha256').update(WALKIE_DIR).digest('hex').slice(0, 12)
  : path.join(WALKIE_DIR, 'daemon.sock')
const PID_FILE = path.join(WALKIE_DIR, 'daemon.pid')

function connect() {
  return new Promise((resolve, reject) => {
    const sock = net.connect(IPC_PATH)
    sock.on('connect', () => resolve(sock))
    sock.on('error', reject)
  })
}

function sendCommand(sock, cmd, timeout = 60000) {
  return new Promise((resolve, reject) => {
    let buf = ''
    let timer
    if (timeout > 0) {
      timer = setTimeout(() => {
        sock.removeListener('data', onData)
        reject(new Error('Command timed out'))
      }, timeout)
    }

    const onData = (data) => {
      buf += data.toString()
      const idx = buf.indexOf('\n')
      if (idx !== -1) {
        if (timer) clearTimeout(timer)
        sock.removeListener('data', onData)
        try {
          resolve(JSON.parse(buf.slice(0, idx)))
        } catch (e) {
          reject(e)
        }
      }
    }
    sock.on('data', onData)
    sock.write(JSON.stringify(cmd) + '\n')
  })
}

function isProcessRunning(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

async function ensureDaemon() {
  const cliVersion = require('../package.json').version

  // Try connecting to existing daemon
  try {
    const sock = await connect()
    const resp = await sendCommand(sock, { action: 'ping' })
    sock.destroy()
    if (resp.ok) {
      // Auto-restart if daemon is running an older version
      if (resp.version && resp.version !== cliVersion) {
        try {
          const s = await connect()
          await sendCommand(s, { action: 'stop' })
          s.destroy()
        } catch {}
        await new Promise(r => setTimeout(r, 500))
        // Fall through to spawn a new daemon
      } else {
        return
      }
    }
  } catch {}

  // Clean stale socket and PID file before spawning
  try { fs.unlinkSync(IPC_PATH) } catch {}
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10)
    // Only signal a pid we can confirm is a walkie daemon. A stale pid file plus pid
    // reuse would otherwise mean killing an unrelated process of the user's.
    if (isProcessRunning(pid) && isWalkieProcess(pid)) {
      // Kill the stale daemon that we couldn't connect to (socket gone but process alive)
      try { process.kill(pid, 'SIGTERM') } catch {}
      await new Promise(r => setTimeout(r, 500))
      // Force kill if still alive
      if (isProcessRunning(pid)) {
        try { process.kill(pid, 'SIGKILL') } catch {}
        await new Promise(r => setTimeout(r, 200))
      }
    }
    try { fs.unlinkSync(PID_FILE) } catch {}
  } catch {}

  // Spawn daemon
  fs.mkdirSync(WALKIE_DIR, { recursive: true })

  const daemonScript = path.join(__dirname, 'daemon.js')
  // Send the daemon's stdout/stderr to the log file rather than discarding them.
  // With 'ignore', a daemon that crashed after startup produced no diagnostic at
  // all — the log showed a clean "Daemon started" and nothing else (issue #11).
  let logFd = 'ignore'
  try { logFd = fs.openSync(path.join(WALKIE_DIR, 'daemon.log'), 'a') } catch {}
  const child = spawn(process.execPath, [daemonScript], {
    detached: true,
    stdio: ['ignore', logFd, logFd]
  })
  child.unref()
  if (typeof logFd === 'number') { try { fs.closeSync(logFd) } catch {} }

  // Poll until ready
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200))
    try {
      const sock = await connect()
      const resp = await sendCommand(sock, { action: 'ping' })
      sock.destroy()
      if (resp.ok) return
    } catch {}
  }

  throw new Error(`Failed to start walkie daemon. Check ${path.join(WALKIE_DIR, 'daemon.log')} for details`)
}

async function request(cmd, timeout) {
  await ensureDaemon()
  const sock = await connect()
  const resp = await sendCommand(sock, cmd, timeout)
  sock.destroy()
  return resp
}

async function streamMessages(channel, secret, clientId, abort, onMessage, persist) {
  while (!abort.aborted) {
    try {
      const sock = await connect()
      abort.socket = sock

      const resp = await sendCommand(sock, {
        action: 'read',
        channel,
        clientId,
        wait: true
      }, 0)

      sock.destroy()
      abort.socket = null

      if (abort.aborted) break

      if (resp.ok && resp.messages && resp.messages.length > 0) {
        for (const msg of resp.messages) {
          onMessage(msg)
        }
      }
    } catch (e) {
      if (abort.aborted) break

      // Wait and retry on error (daemon may have restarted)
      await new Promise(r => setTimeout(r, 2000))

      if (abort.aborted) break

      try {
        await ensureDaemon()
        // Re-join channel after daemon restart
        const cmd = { action: 'join', channel, secret, clientId }
        if (persist) cmd.persist = true
        await request(cmd)
      } catch {}
    }
  }
}

module.exports = { request, connect, sendCommand, ensureDaemon, streamMessages }
