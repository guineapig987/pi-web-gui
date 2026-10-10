<div align="center">

# pi-web

**A browser GUI for the [pi](https://github.com/earendil-works/pi) coding agent**

Zero dependencies · No installer · Works on desktop and phone

[한국어](README.md) · English · [简体中文](README.zh-CN.md)

</div>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/session-dark.png">
    <img src="docs/images/session.png" alt="pi-web: project sidebar, conversation and code diff" width="860">
  </picture>
  &nbsp;
  <img src="docs/images/mobile.png" alt="Phone layout" width="190">
</p>

<p align="center"><sub>Screenshots use sample data. The interface language is Korean.</sub></p>

## Overview

pi-web is a small gateway server. It starts one `pi --mode rpc` process per session and talks to the browser over HTTP and Server-Sent Events. It reads and writes the same session files as the terminal pi (`~/.pi/agent/sessions`), so you can continue a terminal conversation in the browser and vice versa.

## Features

- **Project sidebar**: every project and session in one place, grouped by folder. Running sessions show their state (working, waiting for you); saved sessions resume with one click.
- **Turn-based conversation view**: exploration (reads, searches) collapses to a single line, while shell, edit and write steps show their output and diffs inline. Each turn ends with the list of changed files plus tokens and cost.
- **Changes panel**: the full diff of every file touched in the session.
- **File and image attachments**: drag and drop, paste, or use the paperclip button.
- **Account, settings and updates**: sign in with a subscription (OAuth) or an API key, change common pi settings, and check for and install pi updates, all from the UI.
- **Command palette** (`Ctrl+K`), `/` command and `@` file completion, `!` shell commands, dark mode, completion notifications.
- **Use it anywhere**: responsive layout, installable as an app (PWA), remote access over Tailscale, autostart at login.

## Requirements

- Node.js 22.19 or later
- [pi](https://github.com/earendil-works/pi), installed and signed in (run `pi` in a terminal and use `/login`)
- Platform: developed and verified on Windows. The server (`node server.mjs`) is written to work on macOS and Linux but has not been verified there. Helper scripts such as `start.cmd` and `piweb` are Windows-only.

## Quick start

1. Install Node.js and pi. `node -v` must print `v22.19` or newer.
2. Get the code: use **Code → Download ZIP** and extract it anywhere, or:
   ```bash
   git clone https://github.com/guineapig987/pi-web-gui.git
   cd pi-web-gui
   ```
3. Run it. The folder can live anywhere, and there is no `npm install` step.
   - Windows: double-click `start.cmd`
   - Elsewhere: `node server.mjs --open`
4. Your browser opens <http://127.0.0.1:8787>. Close the console window to stop the server.

> If pi cannot be found automatically, point to it with the `PI_CLI` environment variable (see below).

## Usage

### Layout

| Area | Description |
|---|---|
| Sidebar | Running and saved sessions per project. Use `+` on a project row to start a session in that folder, **Add folder** to add a project, and the search box to find any session. Toggle with `Ctrl+B`. |
| Home | Project list and session list, grouped by today, this week and this month. |
| Conversation | Your messages, the agent's work (exploration, edits, shell), changed files, and model, duration, tokens and cost. |
| Changes panel | Per-file diff for the whole session; resizable. |
| Composer | Model and thinking-level pickers, attachments, send and stop. Confirmation and selection prompts from extensions appear as cards above the input. |

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` | Command palette (commands and sessions across all projects) |
| `Ctrl+Shift+S` | New session |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+L` | Focus the input |
| `Ctrl+Shift+E` | Changes panel |
| `Alt+0` / `Alt+1…9` | Home / switch to the Nth session in the sidebar |
| `Enter` / `Shift+Enter` | Send / new line |
| `Enter` / `Ctrl+Enter` while working | Steer now / send after the run finishes |
| `Esc` | Stop the current run |

### Attachments

Images are passed to the model as-is. Other files (documents, code, archives…) are stored on the server machine under `~/.pi/agent/web-uploads/`, and their paths are added to the prompt so pi can read them with its tools. The limit is 100 MB per file (`PI_WEB_MAX_UPLOAD_MB`). Uploaded files are not deleted automatically. Formats pi can read directly, such as text and code, work best.

### Sign-in and settings

- **Account**: pick a provider and sign in with a subscription (OAuth) or store an API key. The server runs the same code as the terminal `/login`. Keys and tokens travel only from the browser to the server and are never shown again in the UI or logs.
- **Settings**: edits the commonly used entries of pi's global `settings.json` (thinking level, auto-compaction, auto-retry, proxy…). Entries not listed in the UI and project-level `.pi/settings.json` files are left untouched.

### pi updates

At startup and every six hours, pi-web compares the installed pi with the latest release (pi.dev). When a newer version exists, a notice appears in the top bar. Open it (or use `/update`) to see the current and latest versions with release notes, then choose **Update now** to run `pi update`. Updates are refused while a session is working; idle sessions restart automatically afterwards to pick up the new version. If you installed pi by some means other than npm, update it that way instead.

## Configuration

### Command-line options

| Option | Description |
|---|---|
| `--port <n>` | Port (default `8787`, env `PI_WEB_PORT`) |
| `--cwd <dir>` | Project folder to open first (default `~/Documents/pi`) |
| `--host <addr>` | Bind address (default `127.0.0.1`, env `PI_WEB_HOST`) |
| `--remote` | Accept connections from other devices: listen on all interfaces. **There is no login.** See [Remote access](#remote-access) |
| `--open` | Open the browser on start |

### Environment variables

| Variable | Description |
|---|---|
| `PI_CLI` | Path to pi's `cli.js` or executable (when auto-detection fails) |
| `PI_WEB_DEFAULT_DIR` | Default working folder for new sessions (default `~/Documents/pi`, created if missing) |
| `PI_WEB_PI_PACKAGE` | Folder of the pi package (`@earendil-works/pi-coding-agent`), if the sign-in feature cannot find the library |
| `PI_WEB_PI_ARGS` | Extra arguments passed to pi (for example `--approve`) |
| `PI_WEB_ALLOWED_HOSTS` | Comma-separated Host headers to accept, when serving through a domain or proxy |
| `PI_WEB_MAX_UPLOAD_MB` | Maximum size of one attachment (default 100) |
| `PI_WEB_IDLE_MINUTES` | Minutes before an unwatched idle session is shut down (default 30) |
| `PI_WEB_NO_UPDATE_CHECK` | Set to `1` to skip checking for new pi versions (`PI_OFFLINE` has the same effect) |

PowerShell example:

```powershell
$env:PI_CLI = "$env:APPDATA\npm\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js"
node server.mjs --open
```

## Remote access

pi can read and write files and run commands on the server machine. **This server has no login, so never expose it directly to the internet.** Instead of forwarding a router port, use [Tailscale](https://tailscale.com), a free personal VPN that connects only your own devices.

1. Install Tailscale on the server machine and on the device you will connect from (phone, laptop…) and sign in to the **same account**.
2. Start the server in remote mode on the server machine:
   ```bash
   npm run start:remote        # same as: node server.mjs --remote
   ```
3. Open the `Tailscale: http://100.x.y.z:8787` address printed at startup in the other device's browser. If Windows Firewall asks, allow it on private networks.
4. If you need an HTTPS address (`https://<machine>.<tailnet>.ts.net`), run `tailscale serve --bg 8787` on the server machine.

**Security notes**

- Every device signed in to your Tailscale account can use this server. Turn on two-factor authentication for that account.
- On a public network (a café, say), `--remote` or `--host 0.0.0.0` lets anyone on that network connect.
- In remote mode the native folder picker and the sign-in terminal window, which open on the server machine's screen, are disabled. Pick folders from the in-page list.
- The server cannot be reached while the machine is off or asleep.

### Install as an app (PWA)

Use the install icon in the address bar of Chrome or Edge (or menu → Install app) to get a standalone window. Browsers only allow installation from `localhost` or an HTTPS address, so for remote installation use the `tailscale serve` address above.

### Keep it running (Windows)

pi-web can run in the background with no console window and start automatically when you sign in. Type `piweb` (`.\piweb` in PowerShell) inside the project folder to see the command list and status. Run `piweb setup` once and open a new terminal to use `piweb` from any folder (`piweb unsetup` reverts it).

| Command | Action |
|---|---|
| `piweb install` | Register autostart at login (Task Scheduler entry `pi-web`) and start. Runs in remote mode. |
| `piweb uninstall` | Remove autostart and stop |
| `piweb status` / `open` / `log` | Status and addresses / open the browser / recent log |
| `piweb start` / `stop` / `restart` | Start / stop / restart (after changing the code) |

Logs go to `logs/`. If you move the project folder, run `piweb install` again. `piweb.cmd` calls the script regardless of the PowerShell execution policy.

## Known limitations

- Terminal-only pi UI (`ctx.ui.custom()` and similar) and built-in TUI commands such as `/tree` do not work in RPC mode.
- Opening the **same** session in the terminal pi and in the browser at once can corrupt the session file. Close one side first.
- A project's `.pi/` extensions and settings load only if a trust decision is stored (`/trust` in terminal pi, or `PI_WEB_PI_ARGS=--approve`).
- The sidebar builds its list by reading all session files, so refreshes can slow down with thousands of sessions.

## Project layout

```
server.mjs                  HTTP server, API routing, SSE
lib/pi-launcher.mjs         Locates pi (Windows .cmd shim -> real cli.js)
lib/pi-process.mjs          pi RPC process (JSONL framing, request/response matching)
lib/live-session.mjs        Running sessions, event buffer, replay on reconnect
lib/session-store.mjs       Session file listing
lib/auth-service.mjs        Sign-in and sign-out (pi ModelRuntime)
lib/settings-service.mjs    Read and write settings.json
lib/uploads.mjs             Attachment uploads
lib/pi-update.mjs           pi version check and `pi update`
lib/native-picker.mjs       Native OS folder dialog
lib/files.mjs               @ file search, folder browser, new-folder creation
public/js/reducer.js        pi events -> UI state (shared by server and browser)
public/js/*.js              UI (conversation, tool cards, composer, modals)
start.cmd, piweb.cmd, pi-web-service.ps1   Windows launch and background management
test/                       Tests (fake pi, real pi, browser)
```

## Testing

Checks run against the real pi by default. The fake pi (`test/fake-pi.mjs`) is only used by automated tests that must replay fixed events without calling a model.

```bash
node test/unit.mjs                # pure logic (reducer, markdown, version and attachment handling)
node test/server-auth.mjs         # server API: sign-in, settings, update, upload (fake pi)
node test/real-pi.mjs             # real-pi smoke test (free): version, sign-in state, session start, model list, upload
node test/real-pi.mjs --prompt    # + two short model prompts (uses a few tokens of your account)
node test/real-server.mjs         # run the UI against the real pi (http://127.0.0.1:8791)
node test/e2e.mjs                 # browser tests (fake pi, requires Playwright)
```

Real-pi tests use your sign-in (`~/.pi/agent`) but keep conversation history in a temporary folder that is deleted afterwards. If the model cannot be called because of an account issue (plan limit, expired login), the step is reported as skipped rather than failed. `npm test` runs only the fake-pi tests.

## License

[MIT](LICENSE)
