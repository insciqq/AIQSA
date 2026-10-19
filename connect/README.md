# aiqsa-connect

`aiqsa-connect` is the AIQSA Connect client. It runs on your own computer
(macOS, Linux or WSL), connects to your AIQSA installation and lets you open
terminal sessions on that computer from AIQSA in a browser, on a desktop or a
phone: run Claude Code or Codex there, answer them and come back later while
they keep working.

AIQSA builds and serves the client itself; nothing is published to a package
registry. The client version always matches the AIQSA version of the server
it is connected to.

## Requirements

- macOS, Linux or Windows with WSL, on amd64 or arm64.
- tmux 3.2 or newer (`brew install tmux`, `sudo apt install tmux`). The client
  runs its own tmux server (`tmux -L aiqsa-connect`) and never touches your
  other tmux sessions.
- An administrator of your AIQSA installation has turned on **AIQSA Connect**
  in Admin → AIQSA Connect. While it is off, the install commands below answer
  "not found".

## Install

Open **AIQSA Connect** in AIQSA: it shows these commands with your
installation's address.

```bash
curl -fsSL https://ai.example.com/connect/install.sh | sh
```

The script downloads the binary for your computer from your AIQSA
installation, checks its SHA-256 checksum and installs it as
`~/.local/bin/aiqsa-connect` without sudo. Set `AIQSA_CONNECT_INSTALL_DIR` to
install somewhere else. If that directory is not on your `PATH`, the script
says how to add it. Without curl it uses wget.

## Log in

```bash
aiqsa-connect login https://ai.example.com
```

It prints a code and a link. Open the link in AIQSA (you are already signed
in), check the code and approve this computer. The device token is stored in
`~/.config/aiqsa-connect/credentials.json`, readable only by you.

Use `https://`. Plain `http://` works only on your local network: the address
(or every address its name resolves to) must be loopback, private (`10.x`,
`172.16–31.x`, `192.168.x`, `fc00::/7`), link-local or a Tailscale `100.x`
address, and the client then connects directly, never through a proxy. Over
`http://` the device token and the terminal travel unencrypted, so use it only
on a network you trust; browsers also turn off notifications and dictation
without HTTPS.

## Set up tmux and the agent hooks

```bash
aiqsa-connect setup
```

`setup` checks tmux and, after asking, adds small hooks to Claude Code and
Codex so AIQSA can show when an agent needs your approval or is waiting for
you. The hooks only report a status; they never answer for you. Sign in to
Claude Code and Codex on this computer yourself, as usual (`/login`,
`codex login`); for Codex also trust the hook once in `codex` with `/hooks`.
`aiqsa-connect setup --remove` takes the hooks out again.

## Keep it running

```bash
aiqsa-connect service install
```

This installs a user service that runs `aiqsa-connect up --service` whenever
you are logged in to the computer: a systemd user unit on Linux and WSL
(`~/.config/systemd/user/aiqsa-connect.service`), a LaunchAgent on macOS
(`~/Library/LaunchAgents/io.github.insciqq.aiqsa-connect.plist`). It starts
with the PATH of the shell you ran it from, so sessions find the same tools
(nvm, Homebrew) as your terminal; run it again after changing your PATH, after
logging in again and after reinstalling the client. It then tells whether the
client is running and, if not, why.

- `aiqsa-connect service status` shows whether it is running and, when it
  is stopped, why.
- `aiqsa-connect service uninstall` stops and removes it.
- Restarting, stopping or updating the client never ends your sessions: the
  tmux server keeps them running, and AIQSA reconnects to them.
- On Linux the service stops when you log out unless lingering is on:
  `loginctl enable-linger $USER` keeps it running and starts it at boot.

Without a service, run `aiqsa-connect up` in a terminal and keep it open.

## Updates

The client follows the server: when AIQSA is updated (or rolled back), the
client downloads the matching version from the same AIQSA installation,
checks its SHA-256 checksum, replaces its own file and restarts itself. Your
sessions keep running; an open browser view reconnects. If an update
fails for a reason that may pass (network, a busy server), the client tries
again when it next connects, at the earliest after 5 minutes, then after
pauses doubling up to an hour. `aiqsa-connect update` does the same by hand. If the directory of the binary is not writable
by you, the client says so and keeps running its current version; reinstall
it with the install command.

## Other commands

- `aiqsa-connect sessions` lists the sessions; `aiqsa-connect attach <id>`
  opens one in your local terminal.
- `aiqsa-connect version` prints the client version.
- `aiqsa-connect logout` removes the device token. Also revoke the computer in
  AIQSA → AIQSA Connect so the token stops working everywhere.

## Uninstall

```bash
aiqsa-connect service uninstall
aiqsa-connect setup --remove
aiqsa-connect logout
rm ~/.local/bin/aiqsa-connect
rm -rf ~/.config/aiqsa-connect ~/.local/state/aiqsa-connect
```

Revoke the computer in AIQSA → AIQSA Connect. Sessions that are still running
end with `tmux -L aiqsa-connect kill-server`.

## Troubleshooting

- **The install command answers "not found".** AIQSA Connect is off on this
  installation; ask its administrator. An answer `connect_client_unavailable`
  means the installation has no client binaries (a development server without
  `npm run build:connect`).
- **"not logged in" or "device revoked".** Run `aiqsa-connect login <address>`
  again, then `aiqsa-connect service install` to restart the service. A
  revoked token is kept aside as `credentials.revoked.json`.
- **The service stays stopped.** `up` stops for good, without contacting the
  server, when a restart cannot help: the computer is not logged in or was
  revoked, the credentials file is damaged or readable by others, or another
  `aiqsa-connect up` already runs (for example in a terminal). In a terminal
  `up` then exits with status 3; as the service (`up --service`) it exits 0,
  so neither systemd nor launchd restarts it in a loop, and it writes
  `up_stop_final reason=<reason>` to its log. Other fatal errors exit 1 and
  the service restarts the client. Fix the cause, then run
  `aiqsa-connect service install`; `aiqsa-connect service status` names it.
- **The installer says the service still runs the previous version.** Run
  `aiqsa-connect service install` to restart it with the new binary.
- **"systemd user services are not available".** WSL runs without systemd
  unless `/etc/wsl.conf` contains `[boot]` and `systemd=true` (then run
  `wsl --shutdown` in Windows). Otherwise run `aiqsa-connect up` yourself,
  for example inside your own tmux or screen.
- **"AIQSA Connect is turned off on this AIQSA server".** The client waits
  and retries every 10 minutes.
- **The computer shows as offline.** Check `aiqsa-connect service status` and
  the client's log, `~/.local/state/aiqsa-connect/aiqsa-connect.log`. On Linux
  the service's output is also in `journalctl --user -u aiqsa-connect`.
- **tmux is too old or missing.** Install tmux 3.2 or newer; `aiqsa-connect
  setup` checks it.
- **A Codex session never shows running or waiting.** Codex runs hooks
  without the session's environment, often from a background process outside
  the session, so the hook finds its session from the tmux pane it runs
  under or else by finding the prompt you submitted on the screen of the
  Codex session in that folder; trust the hook in `codex` with `/hooks`, and
  keep `aiqsa-connect up` running with its default directories and tmux
  socket. Statuses therefore start after the first prompt of at least 8
  characters submitted in the session (again after `up` restarts, and after
  Codex ends and is resumed), and Codex threads elsewhere do not change them.
  Once found, a session keeps its Codex conversation until Codex ends there,
  whatever other screens show. Two Codex sessions in the same folder whose
  prompts have identical first lines cannot be told apart, and a Codex
  conversation in another terminal whose first prompt line is already on the
  screen of a Codex session in that folder still waiting for its first prompt
  is taken for that session's.

## What the AIQSA server can see

AIQSA Connect gives AIQSA the same access to your computer that your own
terminal has. Be aware of what that means:

- Everything you type and everything the sessions print travels through your
  AIQSA server: it relays the terminal traffic between your computer and your
  browser over TLS. The server does not store it or write it to its logs, but
  whoever operates that server could technically read it or type into your
  sessions. Use AIQSA Connect only with an AIQSA installation whose operator
  you trust.
- Only you can open your computer's sessions, from your own AIQSA account.
  Other users, administrators included, cannot. Revoking the computer in AIQSA
  disconnects it at once.
- Nothing types into a session on its own: input comes only from you (your
  keyboard, the input field and the answer buttons). The AIQSA chat model
  never writes to your terminal.
- The client does not read your Claude Code or Codex configuration or
  credentials. With your consent `setup` writes its hooks to
  `~/.claude/settings.json` and `~/.codex/hooks.json`, nothing else there.
- The client's log contains event names, codes and counts only, never
  terminal content.

## Development

Go 1.27 (see `go.mod`). From the repository root:

```bash
npm run check:connect      # gofmt -l, go vet, go test
npm run build:connect      # the four release binaries and SHA256SUMS in connect/dist/
npm run security:deps:go   # govulncheck
connect/dist/aiqsa-connect-linux-amd64 version
```

`npm run build:connect` uses the same flags as the image's `connect-build`
stage (`CGO_ENABLED=0`, `-trimpath`, `-buildvcs=false`, an empty build id and
the version from `package.json`), so the binaries are reproducible. A
development AIQSA serves them from `connect/dist/`; the release image keeps
them root-owned and read-only in `/app/connect/dist/` and
`scripts/verify-release-connect.cjs` checks them during the image build.
Without a Go toolchain the development server answers
`connect_client_unavailable` for the downloads.

### Layout

- `cmd/aiqsa-connect/` — the command. `main.go` holds a small command
  registry; each subcommand lives in its own `cmd_<name>.go` file and
  registers itself from `init()`. The version is stamped at build time with
  `-ldflags "-X main.version=<version>"` and is `dev` otherwise; a `dev`
  build never updates itself.
- `internal/protocol/` — Go types for the wire protocol. They mirror the
  TypeScript contract in `lib/contracts/connect.ts` (same names, JSON keys,
  limits, codes and patterns) and decode strictly: unknown keys, missing
  required keys and unexpected nulls are errors, and every message has
  `Validate()`.
- `internal/protocol/testdata/` — fixtures shared with
  `lib/contracts/connect.test.ts`:
  - `valid/<schema>.<case>.json` must be accepted by both suites, and
    `invalid/<schema>.<case>.json` rejected by both. `<schema>` is the part of
    the file name before the first dot and names a schema registered in both
    tests (`serverCommand`, `deviceEvent`, `deviceStreamEvent`, …). A fixture
    is one JSON value; an SSE event is `{"event": <name>, "data": <data>}`.
    Adding a fixture file needs no code change.
  - `contract.json` holds the limits, codes, patterns and paths; both suites
    compare their exported constants with it.
- `internal/config/` — directories (XDG, overridable with
  `AIQSA_CONNECT_CONFIG_DIR`, `AIQSA_CONNECT_STATE_DIR` and the tmux socket
  name `AIQSA_CONNECT_TMUX_SOCKET`), origin validation and the 0600
  credentials file.
- `internal/api/` — the device API client: pairing, the SSE device stream
  and event batches.
- `internal/tmux/` — the client's own tmux server (`tmux -L <socket>` with a
  generated config): sessions and their metadata in `@aiqsa_*` user options,
  history and the answer-option parser.
- `internal/daemon/` — the `up` main loop: reconnects, the single event
  sender, PTY views, server commands and `ReportStatus`.
- `internal/status/` — turns agent hook events and terminal bells into
  session statuses; reads only event names and notification types.
- `internal/localsock/` — the unix socket on which `up` hears the agent
  hooks and terminal bells of its sessions.
- `internal/hooks/` — adds and removes the client's own entries in
  `~/.claude/settings.json` and `~/.codex/hooks.json` (`setup`).
- `internal/update/` — self-update: the server's manifest, checksums and
  binary, verified, run once and renamed over the current binary.
- `internal/service/` — the systemd user unit and the LaunchAgent, both
  running `up --service`.
- `internal/logx/` — the content-free log (event names, codes and counts).
- `dist/` — locally built binaries (ignored by Git and Docker).

Tests never touch the user's own tmux servers, client directories or service
manager: they run tmux on a random socket in a private `TMUX_TMPDIR`, set the
directory overrides and replace `systemctl`/`launchctl` with a fake; tmux
tests are skipped when tmux is not installed.

The TypeScript side of the shared fixtures runs with
`npx vitest run lib/contracts/connect.test.ts` from the repository root.
