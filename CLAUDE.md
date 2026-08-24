# CLAUDE.md

## Project

walkie — P2P communication CLI for AI agents. npm package: `walkie-sh`.

## Architecture

- `bin/walkie.js` — CLI entry point (commander). Version is here AND in `package.json` (keep in sync)
- `src/api.js` — **Programmatic API** (`require('walkie-sh')`). Exports `listen()` and `send()`. Uses daemon IPC under the hood.
- `src/daemon.js` — background daemon managing Hyperswarm P2P + local subscriber routing
- `src/client.js` — IPC client, handles daemon auto-start and stale socket cleanup
- `src/crypto.js` — topic derivation (SHA-256 of channel+secret)
- `src/cli-utils.js` — identity resolution (`WALKIE_ID` > `~/.walkie/config.json` > terminal session), channel arg parsing, message filters
- `src/slack.js` — Slack <-> walkie bridge over Socket Mode (`walkie slack`)
- `src/web.js` — HTTP + WebSocket server bridging browser clients to daemon
- `src/web-ui.js` — exports HTML string for web chat UI (minimal, terminal-style)

## Programmatic API

`package.json` `"main"` points to `src/api.js`. Node apps can `require('walkie-sh')`:

```js
const walkie = require('walkie-sh')

// Listen on a channel (EventEmitter — emits 'message' and 'error')
const ch = await walkie.listen('mychannel:secret', { id: 'mybot' })
ch.on('message', async (msg) => {
  // msg: { from: string, data: string, ts: number, id: string }
  await ch.send('response')
})
await ch.close()

// One-shot send (auto-joins if secret provided)
await walkie.send('mychannel:secret', 'hello', { id: 'sender' })
```

- `listen()` joins the channel, starts streaming via `streamMessages()`, filters own messages, returns a `WalkieChannel` (EventEmitter + `send()` + `close()`)
- `send()` auto-joins and fires a single message — good for scripts/CI
- Both auto-start the daemon if not running

## Testing

`npm test` — 53 automated tests using `node:test` (zero extra deps). Covers crypto, store, CLI utils, daemon IPC, web server, and programmatic API.

`npm run test:p2p` — manual P2P integration test (two daemons, Hyperswarm discovery, ~30s).

Manual same-machine test with two identities:
```bash
walkie stop
WALKIE_ID=alice walkie create test -s secret
WALKIE_ID=bob walkie join test -s secret
WALKIE_ID=alice walkie send test "hello"
WALKIE_ID=bob walkie read test
```

## Publishing

```bash
# bump version in package.json AND bin/walkie.js
npm publish
```

## Git

Remote uses SSH alias: `git@github-vikasprogrammer:vikasprogrammer/walkie.git`

## Skill

- Skill source: `skills/walkie/`
- The test copy at `/Users/vikas/Playground/random/walkie-test/.agents/skills/walkie` is a
  **symlink** to `skills/walkie/` — editing the source is enough, there is nothing to sync

## Website

`docs/index.html` — single-page static site at walkie.sh

Deploy:
```bash
instapods deploy walkie --local docs --preset static
```

## Key decisions

- No `--as` flag (removed in v1.3.0)
- Identity resolves `WALKIE_ID` env > `~/.walkie/config.json` > terminal-session hash > none.
  Env-only was not viable: `~/.bashrc` returns early for non-interactive shells, so agents
  silently fell back to an unstable per-session hash. `walkie connect` bootstraps the
  hostname; `walkie whoami [--set]` inspects and sets it
- Auto-derived subscriber IDs from terminal session env vars (v1.2.0)
- `--wait` blocks indefinitely, `--timeout` is optional. With filters, `--wait` keeps
  waiting through filtered-out traffic and `--timeout` is the overall deadline
- `send` reports "Queued at ..." not "delivered" — reaching a peer daemon is not evidence
  that any agent consumed the message. The IPC reply keeps `delivered` for the API/web client
  and adds `peerDaemons` / `localSubscribers`
- Exit codes are meaningful, not just 0/1: `2` not in channel, `3` send reached nobody,
  `4` `read --wait` timed out. Defined once in `src/cli-utils.js` as `EXIT`
- A `--wait` wake carries one message; `read --drain` issues the follow-up read that
  collects the rest of a burst
- `status` reports `bufferedBy` per subscriber — aggregate `buffered` cannot answer
  "do *I* have unread?" when several identities share one daemon
- Known quirk: a joiner receives its own `X joined` system notice, because the subscriber
  is registered before the announcement and `_send` only excludes the literal `system`
  sender. Filter with `--no-system`
- `walkie web` uses read-wait loops per channel (no daemon changes needed for real-time)
- Web client identity: `web-{random8hex}`, renameable via header click
- Web session state (channels, secrets, name) persisted in **localStorage**
  (`walkie:web:state:v1`); the server `/state` endpoint is a legacy fallback used only when
  the localStorage write fails, plus a `beforeunload` sendBeacon flush so the 500ms save
  debounce cannot lose messages on close
- `ws` npm package added as 3rd dependency
- Programmatic API (`src/api.js`) wraps `client.js` functions — no new deps, uses existing daemon IPC
- `package.json` `"main": "./src/api.js"` makes `require('walkie-sh')` return the API (not the CLI)
