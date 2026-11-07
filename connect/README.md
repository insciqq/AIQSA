# aiqsa-connect

`aiqsa-connect` is the AIQSA Connect client. It connects your own computer to
your AIQSA installation so that the AIQSA chat agent can work on it: in a chat
you pick one of your computers and a folder, and the agent then runs commands
there and reads, searches, creates and edits your files.

AIQSA builds and serves the client itself; nothing is published to a package
registry. The client always runs the same version as the AIQSA server it is
connected to.

## What you allow

Read this before you connect a computer.

- The agent works **as you**: commands run with your user account's
  permissions, and it can reach every file your account can reach, not only
  the folder you picked.
- It has **full access without asking**. In this version there are no
  approvals and no sandbox: the agent can delete or change files, install
  software and send data over the network whenever it decides to.
- **Text the agent reads can steer it.** A web page, a file or a tool result
  can contain instructions that make the agent delete, change or send away
  your files. Pick a folder that holds what the task needs, and watch the
  steps it shows in the answer.
- **The AIQSA server can run commands on your computer.** Whoever operates
  your AIQSA installation could technically do so through it. Connect a
  computer only to an installation whose operator you trust.
- **What the agent reads leaves your computer** (see
  [What the AIQSA server sees](#what-the-aiqsa-server-sees)).

These risks are accepted for this first version. If they are too much for a
computer, do not connect it.

## Requirements

- Windows 10 or 11, macOS or Linux (WSL included), on x64 (amd64) or ARM64.
- An administrator of your AIQSA installation has turned on **AIQSA Connect**
  in Admin → AIQSA Connect. While it is off, the downloads answer "not found".

Nothing else is needed: no tmux, no administrator rights.

## Install on Windows

1. In AIQSA, open **AIQSA Connect** (`/connect`), choose **Add a computer**
   and **Download for Windows**. The file is named after your installation,
   for example `AIQSA Connect - ai.example.com.exe`; keep that name, because
   the program reads the AIQSA address from it. A link below the button
   offers the other architecture (ARM64 or x64).
2. Double-click the file. The program is not signed, so Windows may show
   "Windows protected your PC": choose **More info**, then **Run anyway**.
3. Confirm the install window. AIQSA Connect installs for your Windows account
   only, without administrator rights, into
   `%LOCALAPPDATA%\Programs\AIQSA Connect`. It starts when you sign in to
   Windows, has an **AIQSA Connect** shortcut in the Start menu (it starts
   the program, or opens AIQSA when it already runs) and is listed in
   Settings → Apps.
4. Your browser opens AIQSA with the computer's name and a code. Check that the
   code matches the one in the tray menu ("Waiting for approval · <code>") and
   choose **Approve**.

AIQSA Connect then lives in the notification area. Its icon shows the status
(green: connected; amber: waiting for approval, connecting or updating; grey:
not connected), and its menu has:

- **Open AIQSA**: opens your AIQSA (the approval page while it waits).
- **Connect…**: shown when the computer is not connected; asks for approval
  again.
- **Disconnect this computer**: removes the computer from AIQSA and deletes its
  credentials here. The program stays installed; use Connect… to connect again.
- **Quit**: stops AIQSA Connect until you sign in to Windows again. The
  greyed line above it shows the running version, as does the icon's tooltip.

Opening a downloaded file for another AIQSA installation asks whether to
switch: a computer is connected to one installation at a time. Opening a newer
download for the same installation replaces the installed program when it
differs, then opens AIQSA.

If your installation is reached by an IPv6 address, the file name cannot carry
it: the AIQSA Connect page then offers the plain program and a
`.\aiqsa-connect-windows-<arch>.exe login <address>` command to run in
PowerShell in the download folder.

## Install on macOS and Linux

The AIQSA Connect page shows these commands with your installation's address.

```bash
curl -fsSL https://ai.example.com/connect/install.sh | sh
```

The script downloads the client for your computer from your AIQSA
installation, checks its SHA-256 checksum and installs it as
`~/.local/bin/aiqsa-connect`, without sudo. Set `AIQSA_CONNECT_INSTALL_DIR` to
install somewhere else. If the directory is not on your `PATH`, the script says
how to add it. Without curl it uses wget.

```bash
aiqsa-connect login https://ai.example.com
```

`login` prints a link and a code. Open the link in AIQSA (where you are signed
in), check the code and approve the computer. `login` then names the account
that approved it; if that is not yours, run `aiqsa-connect logout`. Add
`--name <name>` to choose the name AIQSA shows instead of the host name.

```bash
aiqsa-connect service install
```

This keeps the client running whenever you are logged in: a systemd user unit
on Linux and WSL (`~/.config/systemd/user/aiqsa-connect.service`), a
LaunchAgent on macOS
(`~/Library/LaunchAgents/io.github.insciqq.aiqsa-connect.plist`). The service
starts with the `PATH` of the shell you ran it from, so the agent's commands
find the same tools (nvm, Homebrew) as your terminal; run it again after
changing your `PATH`, after logging in again and after reinstalling. It reports
whether the client is running and, if not, why.

- `aiqsa-connect service status` shows whether it runs and, when stopped, why.
- On Linux the service stops when you log out unless lingering is on:
  `loginctl enable-linger $USER` keeps it running and starts it at boot.
- Without a service, run `aiqsa-connect up` in a terminal and keep it open.

On WSL the client runs inside Linux, so the agent works on the WSL side. To let
it work on Windows itself, install the Windows program.

### Plain http

Use `https://`. Plain `http://` works only on your local network: the address,
or every address its name resolves to, must be loopback, private (`10.x`,
`172.16–31.x`, `192.168.x`, `fc00::/7`), link-local or a Tailscale `100.x`
address, and the client then connects directly, never through a proxy. Over
`http://` the device token, your files and the output of commands travel
unencrypted, so use it only on a network you trust. The Windows program follows
the same rule.

## Using it in a chat

1. In the composer, open the **+** menu and choose **Use a computer…**.
2. Pick a computer, then a folder: your home folder, a recent one, one you
   browse to, or a path you type.
3. A chip in the composer shows `<computer> · <folder>`. From it you can change
   the folder or the computer, or stop using the computer.

The choice applies to the messages you send from then on and stays with the
chat. The agent then runs commands (PowerShell 7 if it is on your `PATH`,
otherwise Windows PowerShell on Windows; your login shell on macOS and Linux),
can keep a long command running in the background, and reads, searches,
creates and edits files. Each step shows in the answer with its command or
path.

- The folder is where commands start and relative paths resolve. It is **not a
  boundary**: the agent can reach any file your account can.
- The computer must be online while the agent works. If it is offline, its
  steps fail with "This computer is offline"; start AIQSA Connect on it and try
  again.
- Commands get no input from you, so a command that asks for something, such as
  `sudo` asking for a password, does not work.
- Commands and background jobs the agent started stop when its answer ends or
  when the client stops.
- Only you can use your computers; other users and administrators cannot.
- Scheduled tasks, webhooks, Telegram and Assistant chats never get a computer.

## What the AIQSA server sees

- The server relays the agent's requests and your computer's answers in memory
  and does not store them or write them to its logs.
- But command output and file contents the agent reads become the chat's tool
  results: they are kept with the chat like any other tool result, sent to the
  chat's model provider, and go wherever the chat goes (exports, shares).
- AIQSA stores the computer's name, host name, system, architecture, client
  version and when it was last seen, and only a hash of its device token.
- The client's own log holds event names, codes, sizes and durations, never
  commands, paths, output or file contents.

## Updates

The client follows the server: when AIQSA is updated or rolled back, the client
downloads the matching version from the same installation, checks its SHA-256
checksum, replaces its own file and restarts. If an update fails for a reason
that may pass (network, a busy server), it tries again when it next connects,
first after 5 minutes, then after pauses doubling up to an hour.
`aiqsa-connect update` does the same by hand. If you cannot write to the
client's file, it says so and keeps its current version: reinstall it. On
Windows a notification says which version AIQSA Connect was updated to, and
an update restores the Start menu shortcut when it is missing; you can delete
the shortcut otherwise, and it stays deleted until the next update.

## Disconnect and uninstall

You can always remove a computer in AIQSA → AIQSA Connect with **Revoke**: its
token stops working at once.

**Windows.** Disconnect this computer in the tray menu keeps the program
installed. To remove it, open Settings → Apps, find AIQSA Connect and choose
Uninstall: it removes the computer from AIQSA, stops the program, removes the
start at sign-in, the Apps entry, the Start menu shortcut, its folders
(`%APPDATA%\AIQSA Connect`, `%LOCALAPPDATA%\AIQSA Connect`) and the program.
If AIQSA cannot be reached, it says so; revoke the computer in AIQSA then.

**macOS and Linux.**

```bash
aiqsa-connect service uninstall
aiqsa-connect logout
rm ~/.local/bin/aiqsa-connect
rm -rf ~/.config/aiqsa-connect ~/.local/state/aiqsa-connect
```

`logout` removes the computer from AIQSA and deletes the local credentials; if
AIQSA cannot be reached it deletes them anyway and tells you to revoke the
computer in AIQSA.

## Upgrading from the terminal version

Earlier versions opened tmux terminal sessions and added hooks to Claude Code
and Codex. An installed earlier client updates itself to this version when it
next connects. The new client writes no hooks and does not touch tmux; clean up
what the old one left:

```bash
aiqsa-connect setup --remove
tmux -L aiqsa-connect kill-server
```

`setup --remove` shows which files it changes and asks first: it removes only
its own entries from `~/.claude/settings.json` and `~/.codex/hooks.json`. Until
then those hooks run `aiqsa-connect hook`, which now does nothing.
`kill-server` ends the old sessions and whatever still runs in them, so finish
that work first.

## Logs

- macOS and Linux: `~/.local/state/aiqsa-connect/aiqsa-connect.log` (under
  `$XDG_STATE_HOME` when set). On Linux the service's output is also in
  `journalctl --user -u aiqsa-connect`.
- Windows: `%LOCALAPPDATA%\AIQSA Connect\aiqsa-connect.log`.

The credentials are in `~/.config/aiqsa-connect/credentials.json` or
`%APPDATA%\AIQSA Connect\credentials.json`, readable only by you.

## Troubleshooting

- **The download or install command answers "not found".** AIQSA Connect is off
  on this installation; ask its administrator. `connect_client_unavailable`
  means the installation has no client binaries (a development server without
  `npm run build:connect`).
- **Windows says "This file does not say which AIQSA it belongs to".** The
  downloaded file was renamed. Download it again from your AIQSA page.
- **Windows says the address is outside your local network.** It was
  downloaded from an `http://` address that is not local; download it from the
  `https://` address.
- **"AIQSA Connect already runs in a terminal on this computer".** An
  `aiqsa-connect up` runs in a console; stop it, then start AIQSA Connect again.
- **"not logged in" or "device revoked".** Run `aiqsa-connect login <address>`
  again, then `aiqsa-connect service install`. On Windows choose Connect… in
  the tray menu. A revoked token is kept aside as `credentials.revoked.json`.
- **The service stays stopped.** The client stops for good, without contacting
  the server, when a restart cannot help: the computer is not logged in or was
  revoked, the credentials file is damaged or readable by others, or another
  `aiqsa-connect up` already runs. In a terminal `up` then exits with status 3;
  as the service it exits 0 so it is not restarted in a loop, and writes
  `up_stop_final reason=<reason>` to its log. Fix the cause, then run
  `aiqsa-connect service install`; `aiqsa-connect service status` names it.
- **The installer says the service still runs the previous version.** Run
  `aiqsa-connect service install` to restart it.
- **"systemd user services are not available".** WSL runs without systemd
  unless `/etc/wsl.conf` contains `[boot]` and `systemd=true` (then run
  `wsl --shutdown` in Windows). Otherwise keep `aiqsa-connect up` running in a
  terminal.
- **"AIQSA Connect is turned off on this AIQSA server".** The client waits and
  retries every 10 minutes.
- **The client is "too old" for the server.** Install it again from AIQSA →
  AIQSA Connect.
- **The computer shows as offline.** Check the tray icon on Windows, or
  `aiqsa-connect service status` and the log elsewhere.

## Development

Go 1.27 (see `go.mod`). From the repository root:

```bash
npm run check:connect      # gofmt -l, go vet, go test
npm run build:connect      # the six release binaries and SHA256SUMS in connect/dist/
npm run security:deps:go   # govulncheck
connect/dist/aiqsa-connect-linux-amd64 version
```

`npm run build:connect` uses the same flags as the image's `connect-build`
stage (`CGO_ENABLED=0`, `-trimpath`, `-buildvcs=false`, an empty build id, the
version from `package.json` and `-H windowsgui` for Windows), so the binaries
are reproducible. A development AIQSA serves them from `connect/dist/`; the
release image keeps them root-owned and read-only in `/app/connect/dist/`, and
`scripts/verify-release-connect.cjs` checks them during the image build.
Without a Go toolchain the development server answers
`connect_client_unavailable` for the downloads.

### Layout

- `cmd/aiqsa-connect/`: the command. `main.go` holds a small command registry;
  each subcommand lives in its own `cmd_<name>.go` file and registers itself
  from `init()`. On Windows the same program is its installer and tray
  application (`cmd_install_windows.go`, `cmd_tray_windows.go`). The version is
  stamped with `-ldflags "-X main.version=<version>"` and is `dev` otherwise; a
  `dev` build never updates itself.
- `internal/protocol/`: Go types for the wire protocol. They mirror the
  TypeScript contract in `lib/contracts/connect.ts` and decode strictly. The fixtures in
  `internal/protocol/testdata/` are shared with
  `lib/contracts/connect.test.ts`: `valid/<schema>.<case>.json` must be
  accepted by both suites and `invalid/<schema>.<case>.json` rejected by both;
  `contract.json` holds the limits, codes and paths both suites compare with.
  Adding a fixture file needs no code change.
- `internal/config/`: directories (overridable with `AIQSA_CONNECT_CONFIG_DIR`
  and `AIQSA_CONNECT_STATE_DIR`), origin validation and the private
  credentials file.
- `internal/api/`: the device API client: pairing, the event stream, replies
  and self-revoke.
- `internal/daemon/`: the `up` main loop: reconnects, the single event sender
  and server commands.
- `internal/ops/`: the agent's operations: shell commands and background jobs,
  reading, writing, editing and searching files, and the folder picker.
- `internal/state/`: the connection state the Windows tray shows.
- `internal/winapp/`: the Windows install, uninstall, switch and tray flows,
  testable on any system; the Win32 parts are in the `_windows.go` files.
- `internal/hooks/`: removes the hooks an earlier version added
  (`setup --remove`).
- `internal/update/`: self-update: the server's manifest, checksums and binary,
  verified, run once and renamed over the current binary.
- `internal/service/`: the systemd user unit and the LaunchAgent.
- `internal/logx/`: the content-free log.
- `dist/`: locally built binaries (ignored by Git and Docker).

Tests never touch the user's own client directories or service manager: they
set the directory overrides and replace `systemctl`/`launchctl` with a fake.
The TypeScript side of the shared fixtures runs with
`npx vitest run lib/contracts/connect.test.ts` from the repository root.
