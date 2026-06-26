# LogBoard CLI

A terminal app for managing Apex debug **trace flags** and viewing, colour-coding, searching, and downloading Salesforce **debug logs** — all without leaving your shell.

LogBoard CLI is a full-screen TUI that turns the usual round-trip through the Salesforce Developer Console into a fast, keyboard-driven workflow. You set a debug duration and toggle logging on or off for yourself, the automated process, or any other user; the most recent logs stream into a live, auto-refreshing table; and you can open any log in a colour-coded viewer, filter it to just `USER_DEBUG` lines, search across every loaded log, jump straight to a match, and save logs to your Downloads folder.

It works directly against the Salesforce **Tooling/REST APIs**, authenticating through the Salesforce CLI session rather than an in-org session. That means **no managed package and no RSS/TSS deployment step** — authenticate once with the CLI, then run. You can switch between any of your authenticated orgs from inside the app.

## Requirements

- Node.js 18+
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`) with at least one authenticated org

## Install

```bash
cd logboard-cli
npm install
npm link        # optional: makes `logboard` available globally
```

If `npm link` fails with `EACCES`, your global npm folder is root-owned. Point npm at a folder you own and retry:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.zshrc && source ~/.zshrc
npm link
```

Or skip linking entirely and run `node bin/logboard.js`.

## Run

```bash
logboard                    # uses your default org
logboard --org myDevHub     # specific org alias/username
logboard --api v60.0        # override API version
node bin/logboard.js        # without npm link
```

## Features

### Trace-flag management

Pick how long debug logging stays on with the duration keys `1`–`5` (1, 2, 3, 5, or 10 minutes), then press `e` to enable and `s` to stop. The header shows a live `● Debug ON` indicator with a countdown to expiry, or `○ Debug disabled`. If no trace flag exists yet for the target user, one is created automatically.

### Traced user

"Current user" is the owner of the CLI access token. Press `u` to toggle between the current user and the **automated process** (`autoproc`); from any other target, `u` jumps straight back to the current user. Press `c` to trace a **specific** user by username or alias (leave it blank to keep the current target).

### Org switching

Press `o` (from the log list) to open a picker of every org your Salesforce CLI is authenticated against, with the default and current org marked. Select one with `↵` to re-authenticate and reload against that org, or `esc` to cancel. Selecting an org also **sets it as your Salesforce CLI default** (`sf config set target-org=<alias> --global`), so it stays selected the next time you run `logboard` — or any other `sf` command. If the switch succeeds but the default can't be saved, the app still switches for the session and shows a warning. You can also choose the org up front with `--org <alias>`.

### Live log list

The most recent 100 `ApexLog` records are shown with start time, operation, status, user, and size. The list **auto-refreshes every 3 seconds** in the background — it keeps your cursor on the same log and reuses cached log bodies, and quietly reports when new logs arrive.

### Log viewer

Press `↵` to open the selected log. The viewer colour-codes events (see below), scrolls with the arrow keys / `j` `k`, and supports:

- `d` — toggle **debug-only** view (just `USER_DEBUG` lines).
- `w` — **download** the log to your Downloads folder.
- `m` — toggle **select-text** mode (see below).
- `esc` — close the viewer.

### Search across logs

Press `/` to search every loaded log (bodies are fetched on first use). Matches are shown with one line of context above and below. Navigate matches with `←` / `→` (or `n` / `p`), open the full log for the current match with `↵` or `o` — the viewer jumps straight to the matched line — download the match's log with `w`, and close with `esc`.

### Download logs

Press `w` to save a log as a `.log` file in your `~/Downloads` folder (falling back to the current directory if it doesn't exist). It works from the table (selected log), the viewer (open log), and search results (current match). The status bar shows the full saved path.

### Select-text mode

Terminal apps capture the mouse, which blocks native click-drag selection. Press `m` to toggle **select-text mode**: it releases the mouse back to your terminal so you can drag-select and copy with your usual shortcut, and pauses background redraws so they don't wipe your selection. Press `m` again to resume.

### Delete logs

Press `x` to delete up to 100 logs from the org (with a confirmation prompt).

## Keys

### Log list (table)

| Key | Action |
|-----|--------|
| `1`–`5` | Select trace duration (1 / 2 / 3 / 5 / 10 min) |
| `e` / `s` | Enable / stop debug logging |
| `u` | Toggle traced user between current user and automated process (`autoproc`) |
| `c` | Trace a specific user by username/alias (blank = keep current) |
| `o` | Select / switch the connected Salesforce org (also sets it as the CLI default) |
| `↵` | View the selected log |
| `w` | Download the selected log to your Downloads folder |
| `m` | Toggle select-text mode |
| `/` | Search across all loaded logs |
| `x` | Delete logs from the org |
| `q` | Quit |

### Log viewer

| Key | Action |
|-----|--------|
| `↑` / `↓` / `j` / `k` | Scroll |
| `d` | Toggle "debug only" |
| `w` | Download the open log |
| `m` | Toggle select-text mode |
| `esc` | Close the viewer |

### Search results

| Key | Action |
|-----|--------|
| `→` / `←` / `n` / `p` | Next / previous match |
| `↵` / `o` | Open the full log for the current match (jumps to the matched line) |
| `w` | Download the current match's log |
| `esc` | Close search |

### Prompts (search box, custom-user box)

| Key | Action |
|-----|--------|
| `↵` | Apply |
| `esc` | Cancel |

## Colour scheme

Log events are colour-coded by type:

| Colour | Log events |
|--------|-----------|
| 🟡 Yellow | `CODE_UNIT_*`, `METHOD_*` |
| 🟣 Purple | `CALLOUT_*` |
| 🩵 Cyan | `SOQL_EXECUTE_*` |
| 🟢 Green | `USER_DEBUG` |
| 🔴 Red | `EXCEPTION_THROWN`, `FATAL_ERROR` |

## How it works

LogBoard CLI is a single-process Node app with a clear split of responsibilities:

- **Session (`sf.js`)** — resolves the access token, instance URL, and org alias from the local Salesforce CLI (`sf org display`), transparently handling redacted tokens, lists every authenticated org for the in-app org switcher, and persists the chosen org as the CLI's global default.
- **API client (`api.js`)** — a thin HTTP client over the Salesforce **Tooling/REST APIs**. It resolves users, queries and creates/updates `TraceFlag` records to start and stop debug logging, queries `ApexLog` records (joining in user names), fetches raw log bodies, and deletes logs.
- **Formatting (`logFormat.js`)** — pure functions that split a raw log into colour-classified lines, filter to debug-only output, and run the cross-log search that returns each match with surrounding context.
- **TUI (`ui.js`)** — a [blessed](https://github.com/chjj/blessed) full-screen interface that wires the above together: the header/status bars, the auto-refreshing log table, the scrollable viewer, the search overlay, and all key bindings.

Trace flags use the `SFDC_DevConsole` debug level, the same one the Salesforce Developer Console uses, so logs captured here match what you'd see there.

## Project layout

```
logboard-cli/
├── bin/logboard.js      # CLI entry point + arg parsing
├── src/
│   ├── sf.js            # CLI session resolution, token retrieval, org listing
│   ├── api.js           # Tooling/REST API client
│   ├── logFormat.js     # parsing, colour coding, search (pure functions)
│   └── ui.js            # blessed full-screen TUI
└── test/logFormat.test.js
```

## Test

```bash
npm test
```

## Notes

- Authentication reuses the Salesforce CLI session — current user, instance URL, and org alias all come from `sf org display`.
- Some CLI versions **redact** the access token in `sf org display`. LogBoard detects this and automatically runs the command the CLI recommends (e.g. `sf org auth show-access-token`), bypassing its confirmation prompt, so no extra setup is needed.
- The log list auto-refreshes every 3 seconds. Log bodies are cached per session and reused across refreshes.
- Search loads every listed log's body on first use, which may take a moment for 100 large logs.
- Switching orgs resets the traced user to "current" and clears the cached log bodies, and sets the selected org as the CLI's global default (so the choice persists across runs).
