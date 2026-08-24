const crypto = require('crypto')
const os = require('os')
const fs = require('fs')
const path = require('path')

// Resolved at call time (not module load) so WALKIE_DIR can be set per-process/test.
function walkieDir() {
  return process.env.WALKIE_DIR || path.join(os.homedir(), '.walkie')
}

function configPath() {
  return path.join(walkieDir(), 'config.json')
}

function readConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function writeConfig(patch) {
  fs.mkdirSync(walkieDir(), { recursive: true })
  const next = { ...readConfig(), ...patch }
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + '\n')
  return next
}

// Terminal-session-derived id. Stable within one tab, gone in the next shell —
// which is why it must never be the only mechanism (agents run non-interactive).
function sessionHash() {
  const hint = process.env.TERM_SESSION_ID     // macOS Terminal.app
    || process.env.ITERM_SESSION_ID            // iTerm2
    || process.env.WEZTERM_PANE                // WezTerm
    || process.env.TMUX_PANE                   // tmux
    || process.env.WINDOWID                    // X11 terminals
  if (!hint) return null
  return crypto.createHash('sha256').update(hint).digest('hex').slice(0, 8)
}

// Identity precedence: WALKIE_ID env > ~/.walkie/config.json > terminal session > none.
// Returns where the id came from so callers can warn when it is unstable.
function resolveIdentity() {
  if (process.env.WALKIE_ID) return { id: process.env.WALKIE_ID, source: 'env' }
  const cfg = readConfig()
  if (cfg.id) return { id: cfg.id, source: 'config' }
  const hash = sessionHash()
  if (hash) return { id: hash, source: 'session' }
  return { id: undefined, source: 'none' }
}

function clientId() {
  return resolveIdentity().id
}

function setIdentity(id) {
  writeConfig({ id })
  return id
}

// True when the id would change in a new shell — i.e. anything routing or
// filtering on sender name is keying on an unstable value.
function isStableIdentity() {
  const { source } = resolveIdentity()
  return source === 'env' || source === 'config'
}

function identityWarning() {
  const { id, source } = resolveIdentity()
  if (source === 'env' || source === 'config') return null
  if (source === 'session') {
    return `Identity "${id}" is derived from this terminal session and will change in a new shell.`
  }
  return 'No stable identity — messages will be attributed to "default".'
}

function chatName() {
  const { id, source } = resolveIdentity()
  if (id && source !== 'session') return id
  return os.hostname().split('.')[0]
}

// Build a predicate over message objects. Filtering on objects rather than on
// rendered text avoids the trap that message bodies are unprefixed continuation
// lines, so a naive per-line filter keeps the body of a message whose header it
// just dropped.
function makeMessageFilter(opts = {}, me) {
  return (msg) => {
    if (opts.system === false && (msg.from === 'system' || msg.from === 'daemon')) return false
    if (opts.fromOthers && msg.from === me) return false
    if (opts.from && msg.from !== opts.from) return false
    return true
  }
}

// Exit codes. Agents branch on these instead of string-matching stderr.
// 0/1 keep their historical meanings; the rest are additive.
const EXIT = {
  OK: 0,
  ERROR: 1,           // generic failure, message on stderr
  NOT_IN_CHANNEL: 2,  // channel not joined on this daemon
  NOTHING_QUEUED: 3,  // send reached no peer daemon and no local subscriber
  TIMEOUT: 4,         // read --wait hit its deadline with nothing matching
}

// Verify a pid actually belongs to a walkie daemon before signalling it. The pid
// file can outlive its process, and the OS recycles pids — without this check a
// stale pid file means walkie SIGKILLs whatever unrelated process inherited it.
function isWalkieProcess(pid) {
  if (!pid || Number.isNaN(pid)) return false
  // No cheap cmdline probe on Windows; fall back to trusting the pid file there.
  if (process.platform === 'win32') return true
  try {
    const out = require('child_process').execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return /walkie|daemon\.js/.test(out)
  } catch {
    return false
  }
}

// Collect the rest of a burst after a --wait wake.
//
// The naive version — read once, stop on the first empty reply — is worthless: at
// the instant a waiter is woken the buffer is empty, because the waking message went
// straight to the waiter and the rest of the burst has not landed yet. So it always
// stops immediately and returns nothing.
//
// Instead, keep reading until the channel has been quiet for settleMs. Every arrival
// resets that timer, so a burst with gaps smaller than the settle window is collected
// whole. capMs bounds the total wait so sustained traffic cannot block forever.
//
// read/sleep/now are injected so this is testable without two machines.
async function drainAfterWake({ read, settleMs = 200, capMs = 5000, sleep, now = () => Date.now() }) {
  const collected = []
  const deadline = now() + capMs
  let lastArrival = now()
  const tick = Math.max(1, Math.min(25, settleMs))

  while (now() - lastArrival < settleMs && now() < deadline) {
    const msgs = await read()
    if (msgs && msgs.length > 0) {
      collected.push(...msgs)
      lastArrival = now()
    } else {
      await sleep(tick)
    }
  }
  return collected
}

function parseChannelArg(str) {
  const idx = str.indexOf(':')
  if (idx === -1) return { channel: str, secret: str }
  return { channel: str.slice(0, idx), secret: str.slice(idx + 1) }
}

module.exports = {
  clientId,
  chatName,
  parseChannelArg,
  makeMessageFilter,
  EXIT,
  isWalkieProcess,
  drainAfterWake,
  resolveIdentity,
  setIdentity,
  isStableIdentity,
  identityWarning,
  configPath,
  readConfig,
  writeConfig,
}
