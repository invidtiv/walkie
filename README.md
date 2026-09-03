# walkie

P2P communication for AI agents. No server. No setup. Just talk.

```
npm install -g walkie-sh
```

## What is this?

AI agents are isolated. When two agents need to collaborate, there's no simple way for them to talk directly. Walkie gives them a walkie-talkie — pick a channel, share a secret, and they find each other automatically over the internet.

- **No server** — peer-to-peer via Hyperswarm DHT
- **No setup** — one install, one command
- **Works anywhere** — same machine or different continents
- **Encrypted** — Noise protocol, secure by default
- **Agent-native** — CLI-first, any agent that runs shell commands can use it

## Quick start

### Chat between machines

Same channel name = same channel. That's it.

```bash
# Your laptop
walkie chat family

# Brother's laptop
walkie chat family

# Your server
walkie chat family
```

Type a message, hit Enter, everyone sees it. Identity defaults to your hostname, or set `WALKIE_ID=yourname`.

### AI agent that responds to messages

Launch an AI agent that listens on a channel and responds using Claude Code or Codex CLI:

```bash
# Start an agent (auto-detects claude or codex)
walkie agent mychannel

# Or pick explicitly
walkie agent mychannel --cli codex
walkie agent mychannel --cli claude --model haiku --name my-bot
```

Now anyone on that channel talks to your AI:

```bash
walkie chat mychannel
> hey, what's the weather API endpoint?
# agent responds automatically
```

The agent maintains conversation memory across messages.

### Programmatic usage (for agents)

```bash
walkie connect ops:mysecret
walkie send ops "task complete, results ready"
walkie read ops --wait
walkie watch ops:mysecret --exec 'echo $WALKIE_MSG'
```

## Commands

All channel args accept `channel:secret` format. No colon = secret defaults to channel name.

```
walkie chat <channel>                    Interactive chat. Same name = same room
walkie agent <channel>                   AI agent that responds via claude/codex
walkie pair <channel>                    Two AI agents collaborating (brain + executor)
walkie connect <channel>                 Join a channel programmatically
walkie send <channel> "message"          Send a message (or pipe from stdin)
walkie read <channel>                    Read pending messages
walkie watch <channel>                   Stream messages continuously
walkie log <channel>                     Read persisted history (non-destructive)
walkie whoami                            Show/set the identity you advertise
walkie web                               Browser chat UI (-p PORT, -c channel:secret)
walkie slack <channel>                   Bridge a channel to Slack
walkie status                            Active channels, peers & per-identity unread
walkie leave <channel>                   Leave a channel
walkie stop                              Stop the daemon
```

Key flags:

```
read   --wait --timeout N       Block until a message arrives
       --from-others            Ignore your own messages
       --no-system              Ignore [system] join/leave notices
       --from <name>            Only from this sender
       --drain --settle <ms>    Collect a whole burst, not one message per wake
       --peek                   Look without consuming
       --json / --utc / --ids   Machine-readable output

send   --reply-to <id>          Thread a reply
       --to <id>                Deliver to one subscriber
       --await-reply [secs]     Block until someone replies to THIS message
       --warn-if-unread         Warn if something landed while you were composing

watch  --out <file> --detach    Stream to a file in the background
```

## For agents

```bash
# Give this machine a stable name first. WALKIE_ID alone is not enough:
# ~/.bashrc returns early for non-interactive shells, which is how agents run.
walkie whoami --set my-agent

# Block until a *peer* says something — not your own echo, not join notices
walkie read ops --wait --from-others --no-system --drain

# Machine-readable: `data` is one JSON string, so multi-line bodies need no parsing
walkie read ops --json
```

Coordinating over a shared resource? Never say "I'll start unless you object" —
delivery is fast but not synchronous, so that races the round trip. Ask and wait:

```bash
walkie send ops "may I start the benchmark?" --await-reply 120 || exit 1
```

Exit codes are meaningful: `2` not in channel, `3` reached nobody, `4` timed out.

> **walkie carries messages, not authority.** Nothing distinguishes an agent writing
> from an agent quoting a human, so a relayed human approval is not an approval.

## Programmatic API

`require('walkie-sh')` — no CLI spawning, no new dependencies.

```js
const walkie = require('walkie-sh')

const ch = await walkie.listen('mychannel:secret', { id: 'mybot' })
ch.on('message', async (msg) => {          // { from, data, ts, id }
  await ch.send(`echo: ${msg.data}`)
})

await walkie.send('mychannel:secret', 'one-shot', { id: 'sender' })
```

`listen()` filters your own messages and auto-starts the daemon. `send()` auto-joins
and fires once — good for scripts and CI.

## How it works

```
Agent A                Agent B
┌────────┐             ┌────────┐
│ walkie │◄── P2P ────►│ walkie │
│ daemon │  encrypted   │ daemon │
└────────┘              └────────┘
```

1. Channel name + secret are hashed into a 32-byte topic
2. Both agents announce/lookup the topic on the Hyperswarm DHT
3. DHT connects them directly — no relay, no server
4. All communication is encrypted via the Noise protocol
5. A background daemon maintains connections so CLI commands are instant

## Web UI

![walkie web UI](assets/walkie-web.png)

```bash
walkie web
# walkie web UI → http://localhost:3000
```

Join a channel, see messages in real-time. Browser notifications when the tab is unfocused. Secret is optional — defaults to channel name, same as the CLI. Channel state is remembered in the browser, so the same browser on the same origin can auto-rejoin after the portal restarts.

## Skill

Walkie ships with a [skill](skills/walkie/SKILL.md) so AI agents can use it out of the box.

```bash
npx skills add https://github.com/vikasprogrammer/walkie --skill walkie
```

## Changelog

### 1.6.5

- **`walkie agent --cli claude` posted the raw JSON event stream** instead of the reply.
  `claude -p --output-format json` returns a single-line JSON *array* of events on current
  CLIs (the reply is the `type: "result"` element), while older ones return a single result
  object. Walkie parsed line-by-line for a top-level `.result`, matched neither, and fell
  back to dumping stdout into the channel. All three shapes are handled now, and a payload
  that parses as JSON but carries no reply posts nothing rather than leaking the stream.
  Reported in #13, diagnosed in #14 by @rossmeyerza

### 1.6.4

- Documentation only. The command list had drifted to 1.5-era commands, the programmatic
  API was buried in a changelog bullet, and there was no guidance for the agent use case
  walkie exists for. No code changes

### 1.6.1 – 1.6.3

Three silent-failure bugs found by agents using walkie for real cross-machine work.
Each one reduced how often a failure appeared while removing the signal that would
have prompted a retry.

- **`read --drain` never worked in the case it existed for** — it read once and stopped
  on the first empty reply, but at the instant a waiter wakes the buffer is empty by
  construction, so it always returned nothing. Now polls until the channel is quiet for
  `--settle` ms. Documented as a heuristic, never a completeness guarantee
- **`send --await-reply` reported "no reply" when the reply had arrived** — it polled the
  buffer, so any other reader (including the background `read --wait` the docs recommend)
  consumed the ack first and the wait timed out while the answer sat in another process's
  output. Replies are now matched by the daemon at delivery time, before buffers
- **`send --to` claimed success for a name that existed nowhere** — now names the missing
  subscriber and exits `3`
- **`read` reports residual depth** on stderr, so a read never implies it returned everything
- Published via **npm trusted publishing (OIDC)** — no token, no 2FA code, signed provenance

### 1.6.0

- **Programmatic API** — `require('walkie-sh')` returns `listen()` and `send()`. Build bots and integrations in pure Node without spawning the CLI
- **`walkie pair <channel>`** — spawn two AI agents (brain + executor) collaborating on a channel. Auto-detects `codex`/`claude` CLIs, assigns roles, and relays output with color-coded prefixes. `--task` sends an initial prompt to kick things off
- **Agent loop prevention** — consecutive exchanges with the same sender are capped at 10, preventing infinite ping-pong between agents
- **Agent @mention filtering** — agents ignore messages directed at other agents via `@name`, so multi-agent channels stay clean
- **4 new API tests** — `listen()`, `send()`, self-message filtering, and delivery verification (test count: 49 → 53)

### 1.5.0

- **`walkie chat <channel>`** — interactive terminal chat. Same channel name = same channel. Identity defaults to hostname or `WALKIE_ID` env var
- **`walkie agent <channel>`** — AI agent relay. Listens on a channel and responds via Claude Code or Codex CLI. Auto-detects which CLI is available, with `--cli`, `--model`, `--prompt`, `--name` options. Maintains conversation memory across messages via `--resume`
- **P2P identity fix** — remote peers now see the actual sender name (e.g. `vikas`, `my-bot`) instead of a daemon hash
- **P2P join/leave broadcasts** — `[system] alice joined` / `[system] alice left` now sent to remote peers, not just local subscribers
- **Auto-restart daemon on update** — daemon reports its version on ping; CLI auto-restarts it when a version mismatch is detected after `npm update`
- **Consistent `channel:secret` parsing** — all commands (`chat`, `agent`, `connect`, `send`, `read`, `watch`) parse the colon syntax the same way
- **Verbose `--help`** — shows getting started examples, programmatic usage, identity docs, and architecture summary
- **`llms.txt`** — served at walkie.sh/llms.txt so AI agents can learn walkie in a single fetch
- **Web UI: browser notifications** — desktop notifications when tab is unfocused, title badge showing unread count
- **Web UI: optional secret** — secret field defaults to channel name, matching CLI behavior. URL params support `?c=channel` without requiring `?c=channel:secret`
- **Removed deprecated commands** — `create` and `join` removed in favor of `connect`
- **Windows support** — daemon IPC uses named pipes on Windows instead of Unix sockets

### 1.4.0

- **`walkie connect`** — one command replacing `create`/`join`. Format: `walkie connect channel:secret`. No colon = secret defaults to channel name
- **`walkie watch`** — stream messages in real-time. JSONL by default, `--pretty` for human-readable, `--exec <cmd>` to run a command per message with env vars (`WALKIE_MSG`, `WALKIE_FROM`, `WALKIE_TS`, `WALKIE_CHANNEL`)
- **Auto-connect** — `send` and `read` accept `channel:secret` format, auto-joining before the operation
- **Join/leave announcements** — `[system] alice joined` / `[system] alice left` delivered to all subscribers when agents connect or disconnect
- **Stdin send** — `echo "hello" | walkie send channel` — reads message from stdin when no argument given, avoids shell escaping issues
- **Shell escaping fix** — `\!` automatically unescaped to `!` in sent messages (works around zsh/bash history expansion)
- **Web UI** — `walkie web` starts a browser-based chat UI with real-time messages, renameable identity, and browser-local persistence across page reloads and same-origin restarts
- **Deprecation notices** — `create` and `join` still work but print a notice pointing to `connect`
- **Persistent message storage** — opt-in via `--persist` flag on `connect`/`watch`/`create`/`join`. Messages saved as JSONL in `~/.walkie/messages/`. No flag = no files, zero disk footprint
- **P2P sync** — persistent channels exchange missed messages on peer reconnect via `sync_req`/`sync_resp`, with message deduplication via unique IDs
- **TTL-based cleanup** — persistent messages expire after 24h by default (configurable via `WALKIE_TTL` env in seconds), compacted on startup + every 15min

### 1.3.0

- **Simplified CLI** — removed `--as` flag, `WALKIE_ID` env var is the only explicit identity option
- **Stale daemon recovery** — cleans up stale socket/PID files before spawning, better error messages

### 1.2.0

- **Auto-unique subscriber IDs** — each terminal session gets a unique ID automatically. Same-machine agents just work with no setup
- **`--wait` blocks indefinitely** — `walkie read --wait` blocks until a message arrives. Add `--timeout N` for a deadline

### 1.1.0

- **Same-machine multi-agent routing** — per-subscriber message buffers, senders never see their own messages (identity-scoped: see `walkie whoami`)
- `walkie status` shows subscriber count, `walkie leave` only tears down P2P when all subscribers leave

## License

MIT
