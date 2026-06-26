// Full-screen interactive TUI — the terminal equivalent of the LogBoard
// Lightning component. Built on blessed.

import blessed from 'blessed';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getSession, listOrgs, setDefaultOrg } from './sf.js';
import { SalesforceClient } from './api.js';
import { formatLog, searchLogs, toBlessed } from './logFormat.js';

const DURATIONS = [1, 2, 3, 5, 10]; // minutes

function fmtRemaining(ms) {
  if (ms <= 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

export class LogBoardUI {
  /** @param {import('./api.js').SalesforceClient} client */
  constructor(client) {
    this.client = client;

    this.traceTarget = 'current';
    this.traceFlag = null; // {id, expirationDate, active}
    this.durationIndex = 0; // default 1 minute
    this.logs = [];
    this.bodyCache = new Map();
    this.searchResults = [];
    this.searchIndex = 0;
    this.searchTerm = '';

    // Background log polling.
    this.autoRefresh = true;
    this.autoRefreshMs = 3000;
    this._refreshing = false;
    this._promptOpen = false;

    // When true, the mouse is released to the terminal for native text
    // selection and redraws are paused so they don't wipe the selection.
    this._selectionMode = false;

    this._buildScreen();
  }

  // --- Layout ----------------------------------------------------------------

  _buildScreen() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'LogBoard',
      fullUnicode: true,
    });

    this.header = blessed.box({
      top: 0,
      left: 0,
      width: '100%',
      height: 4,
      tags: true,
      border: { type: 'line' },
      style: { border: { fg: 'gray' } },
    });

    this.table = blessed.listtable({
      top: 4,
      left: 0,
      width: '100%',
      bottom: 1,
      align: 'left',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'gray' },
        header: { fg: 'cyan', bold: true },
        cell: { selected: { bg: 'blue', fg: 'white' } },
      },
    });

    this.status = blessed.box({
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: { fg: 'white', bg: 'black' },
    });

    // Full-screen overlay used by both the log viewer and search results.
    this.viewer = blessed.box({
      top: 'center',
      left: 'center',
      width: '95%',
      height: '90%',
      hidden: true,
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: ' ', style: { bg: 'cyan' } },
      border: { type: 'line' },
      label: ' Log View ',
      style: { border: { fg: 'cyan' } },
      padding: { left: 1, right: 1 },
    });

    this.screen.append(this.header);
    this.screen.append(this.table);
    this.screen.append(this.status);
    this.screen.append(this.viewer);

    this._bindKeys();
    this.table.focus();
  }

  // --- Rendering -------------------------------------------------------------

  renderHeader() {
    const durBar = DURATIONS.map((d, i) =>
      i === this.durationIndex ? `{green-fg}{bold}[${d}]{/bold}{/green-fg}` : ` ${d} `
    ).join(' ');

    let statusText;
    if (this.traceFlag && this.traceFlag.active && this.traceFlag.expirationDate) {
      const remaining = this.traceFlag.expirationDate.getTime() - Date.now();
      statusText = `{green-fg}{bold}● Debug ON{/bold}{/green-fg}  {yellow-fg}${fmtRemaining(
        remaining
      )}{/yellow-fg}`;
    } else {
      statusText = `{red-fg}○ Debug disabled{/red-fg}`;
    }

    const targetLabel =
      this.traceTarget === 'current'
        ? 'Current User'
        : this.traceTarget === 'automated'
        ? 'Automated Process'
        : this.traceTarget;

    const aliasLabel = this.client.alias ? ` {gray-fg}(${this.client.alias}){/gray-fg}` : '';

    this.header.setContent(
      ` ${statusText}    Duration(min): ${durBar} min    User: {cyan-fg}${targetLabel}{/cyan-fg}\n` +
        ` {gray-fg}org:{/gray-fg} ${this.client.username || ''}${aliasLabel}`
    );
    this.screen.render();
  }

  renderTable({ keepId = null } = {}) {
    const rows = [['Start Time', 'Operation', 'Status', 'User', 'Size (MB)']];
    for (const log of this.logs) {
      const started = new Date(log.startTime);
      const hhmmss = started.toLocaleTimeString('en-GB');
      const dd = String(started.getDate()).padStart(2, '0');
      const mon = started.toLocaleString('en-US', { month: 'short' });
      rows.push([
        `${hhmmss}, ${dd} ${mon}`,
        (log.operation || '').slice(0, 40),
        log.status === 'Success' ? `{green-fg}${log.status}{/}` : `{red-fg}${log.status}{/}`,
        log.userName || '',
        log.size,
      ]);
    }
    if (this.logs.length === 0) rows.push(['—', 'No logs', '', '', '']);
    this.table.setData(rows);
    // Keep the cursor on the same log across a refresh, even if rows shifted.
    if (keepId) {
      const i = this.logs.findIndex((l) => l.id === keepId);
      if (i >= 0) this.table.select(i + 1); // +1 for the header row
    }
    this.screen.render();
  }

  _selectedLogId() {
    const idx = this.table.selected - 1; // minus header row
    return this.logs[idx] ? this.logs[idx].id : null;
  }

  // Key hints for the current context, so they persist after any action.
  _contextHint() {
    if (!this.viewer.hidden) {
      if (this._mode === 'search') {
        return '←/→ or n/p: nav  ↵/o: open  w: download  esc: close';
      }
      return 'd: debug-only  w: download  m: select-text  esc: close';
    }
    return 'e:enable s:stop 1-5:duration u:user c:custom-user o:org ↵:view w:download m:select-text /:search-in-logs x:delete q:quit';
  }

  setStatus(msg, color = 'white') {
    this.status.setContent(
      `{${color}-fg} ${msg}{/}  {gray-fg}| ${this._contextHint()}{/}`
    );
    this.screen.render();
  }

  // --- Data actions ----------------------------------------------------------

  async initTrace() {
    this.setStatus('Resolving trace flag…');
    this._initError = null;
    // Keep the in-flight promise so other actions (e.g. enable) can await it
    // instead of racing against an unresolved trace flag.
    this._initPromise = (async () => {
      const userId = await this.client.resolveUserId(this.traceTarget);
      this.traceFlag = await this.client.getActiveTraceFlag(userId);
    })();
    try {
      await this._initPromise;
      this.setStatus('Ready');
    } catch (err) {
      this.traceFlag = null;
      this._initError = err;
      this.setStatus(`Trace error: ${err.message}`, 'red');
    }
    this.renderHeader();
  }

  /**
   * Reload the log list.
   * @param {{silent?:boolean, clearCache?:boolean}} [opts]
   *   silent     — background poll: don't show "Loading…", keep cursor, only
   *                report when new logs appear, swallow transient errors.
   *   clearCache — drop all cached log bodies (manual `r`); when false, only
   *                prune bodies for logs that no longer exist.
   */
  async refreshLogs({ silent = false, clearCache = true } = {}) {
    if (this._refreshing) return;
    this._refreshing = true;
    if (!silent) this.setStatus('Loading logs…');
    try {
      const logs = await this.client.getDebugLogs();

      const prevIds = new Set(this.logs.map((l) => l.id));
      const added = logs.filter((l) => !prevIds.has(l.id)).length;
      const keepId = silent ? this._selectedLogId() : null;

      if (clearCache) {
        this.bodyCache.clear();
      } else {
        const ids = new Set(logs.map((l) => l.id));
        for (const id of [...this.bodyCache.keys()]) {
          if (!ids.has(id)) this.bodyCache.delete(id);
        }
      }

      this.logs = logs;
      this.renderTable({ keepId });

      if (!silent) {
        this.setStatus(`Loaded ${this.logs.length} logs`);
      } else if (added > 0) {
        this.setStatus(
          `${added} new log${added === 1 ? '' : 's'} (${this.logs.length} total)`,
          'green'
        );
      }
    } catch (err) {
      // Don't spam the status bar with transient background failures.
      if (!silent) this.setStatus(`Load error: ${err.message}`, 'red');
    } finally {
      this._refreshing = false;
    }
  }

  async enable() {
    if (!this.traceFlag) {
      // Either init is still running (race) or it failed. Wait for / retry it
      // so we proceed once resolved, and surface the real cause if it failed.
      this.setStatus('Resolving trace flag…');
      if (this._initPromise) {
        try {
          await this._initPromise;
        } catch {
          /* handled below via _initError */
        }
      }
      if (!this.traceFlag) await this.initTrace();
    }
    if (!this.traceFlag) {
      const why = this._initError ? `: ${this._initError.message}` : '';
      return this.setStatus(`Could not resolve trace flag${why}`, 'red');
    }
    if (this.traceFlag.active) return this.setStatus('Already enabled', 'yellow');
    const mins = DURATIONS[this.durationIndex];
    this.setStatus(`Enabling for ${mins} min…`);
    try {
      const expiry = await this.client.enableTraceFlag(this.traceFlag.id, mins);
      this.traceFlag.active = true;
      this.traceFlag.expirationDate = expiry;
      this.setStatus(`Debug enabled for ${mins} min`, 'green');
    } catch (err) {
      this.setStatus(`Enable error: ${err.message}`, 'red');
    }
    this.renderHeader();
  }

  async stop() {
    if (!this.traceFlag || !this.traceFlag.active)
      return this.setStatus('Nothing to stop', 'yellow');
    this.setStatus('Stopping…');
    try {
      await this.client.stopTraceFlag(this.traceFlag.id);
      this.traceFlag.active = false;
      this.traceFlag.expirationDate = null;
      this.setStatus('Debug stopped', 'green');
    } catch (err) {
      this.setStatus(`Stop error: ${err.message}`, 'red');
    }
    this.renderHeader();
  }

  async getBody(logId) {
    if (this.bodyCache.has(logId)) return this.bodyCache.get(logId);
    const body = await this.client.getLogBody(logId);
    this.bodyCache.set(logId, body);
    return body;
  }

  // Build a readable, filesystem-safe filename for a downloaded log.
  _logFilename(log, logId) {
    const id = (log && log.id) || logId;
    if (log) {
      const d = new Date(log.startTime);
      const stamp = isNaN(d.getTime())
        ? ''
        : d.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '_';
      const op = (log.operation || 'log').replace(/[^\w.-]+/g, '_').slice(0, 40);
      return `${stamp}${op}_${id}.log`;
    }
    return `apexlog_${id}.log`;
  }

  // Default save location: the user's Downloads folder, falling back to the
  // current working directory if it doesn't exist.
  _downloadDir() {
    const downloads = path.join(os.homedir(), 'Downloads');
    return existsSync(downloads) ? downloads : process.cwd();
  }

  // Save a single log body to the downloads directory.
  async downloadLog(logId, body) {
    if (!logId) return this.setStatus('No log to download', 'yellow');
    this.setStatus('Downloading log…');
    try {
      const text = body != null ? body : await this.getBody(logId);
      const log = this.logs.find((l) => l.id === logId);
      const dest = path.resolve(this._downloadDir(), this._logFilename(log, logId));
      await writeFile(dest, text, 'utf8');
      this.setStatus(`Saved log to ${dest}`, 'green');
    } catch (err) {
      this.setStatus(`Download error: ${err.message}`, 'red');
    }
  }

  // Download the log currently highlighted in the table.
  downloadSelected() {
    const id = this._selectedLogId();
    if (!id) return this.setStatus('No log selected', 'yellow');
    return this.downloadLog(id);
  }

  // Toggle native terminal text selection. Releases the mouse so click-drag
  // selects/copies via the terminal, and pauses redraws that would clear it.
  toggleSelectionMode() {
    this._selectionMode = !this._selectionMode;
    const prog = this.screen.program;
    if (this._selectionMode) {
      try {
        prog.disableMouse();
      } catch {
        /* ignore */
      }
      this.setStatus(
        'Select-text mode ON — drag to select & copy with your terminal, press m to resume',
        'yellow'
      );
    } else {
      try {
        prog.enableMouse();
      } catch {
        /* ignore */
      }
      this.setStatus('Select-text mode OFF', 'green');
      this.screen.render();
    }
  }

  // Download whatever the viewer is currently showing: the open log, or the
  // log behind the highlighted search match.
  downloadCurrentView() {
    if (this.viewer.hidden) return;
    if (this._mode === 'search') {
      const r = this.searchResults[this.searchIndex];
      if (r) return this.downloadLog(r.logId);
      return;
    }
    if (this._currentLogId) return this.downloadLog(this._currentLogId, this._currentBody);
  }

  async viewSelected() {
    const idx = this.table.selected - 1; // minus header row
    const log = this.logs[idx];
    if (!log) return;
    this.setStatus('Fetching log…');
    try {
      const body = await this.getBody(log.id);
      this._currentBody = body;
      this._currentLogId = log.id;
      this._debugOnly = false;
      this._showViewer(body, false, ` Log View — ${log.operation || log.id} `);
      this.setStatus('Viewing log');
    } catch (err) {
      this.setStatus(`Fetch error: ${err.message}`, 'red');
    }
  }

  _showViewer(body, debugOnly, label, scrollToLine = 0) {
    const segments = formatLog(body, { debugOnly });
    this.viewer.setLabel(label || ' Log View ');
    this.viewer.setContent(toBlessed(segments));
    this.viewer.hidden = false;
    // The viewer overlay fully covers the table; hiding it keeps blessed from
    // re-rendering a large list on every scroll, which keeps scrolling smooth.
    this.table.hidden = true;
    this.viewer.focus();
    // Render first so blessed computes wrapped-line metrics, then scroll to the
    // target line (mapped through wrapping), keeping a few lines of context.
    this.screen.render();
    this.viewer.setScroll(this._realScrollLine(scrollToLine, 3));
    this.screen.render();
  }

  // Map a logical (unwrapped) line index to the rendered-line offset, since
  // blessed wraps long lines into several rows. `context` lines are kept above.
  _realScrollLine(logicalLine, context = 0) {
    let real = logicalLine;
    const cl = this.viewer._clines;
    if (cl && Array.isArray(cl.ftor) && cl.ftor[logicalLine] != null) {
      const mapped = cl.ftor[logicalLine];
      real = Array.isArray(mapped) ? (mapped[0] != null ? mapped[0] : logicalLine) : mapped;
    }
    return Math.max(0, real - context);
  }

  _closeViewer() {
    this.viewer.hidden = true;
    this.table.hidden = false;
    this._mode = null;
    // Header repaints were paused while viewing; refresh it now it's visible.
    this.renderHeader();
    this.table.focus();
    this.setStatus('Ready');
  }

  toggleDebugOnly() {
    if (this.viewer.hidden || this._mode === 'search') return;
    this._debugOnly = !this._debugOnly;
    this._showViewer(
      this._currentBody,
      this._debugOnly,
      this._debugOnly ? ' Log View — Debug only ' : ' Log View '
    );
    this.setStatus(`Debug only: ${this._debugOnly ? 'ON' : 'OFF'}`);
  }

  async doSearch() {
    const prompt = blessed.textbox({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 3,
      border: { type: 'line' },
      label: ' Search in logs (↵ search, esc cancel) ',
      inputOnFocus: true,
      style: { border: { fg: 'cyan' } },
    });
    this._promptOpen = true;

    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      this._promptOpen = false;
      prompt.destroy();
      this.table.focus();
      this.screen.render();
      const term = (value || '').trim();
      if (term) this._runSearch(term);
      else this.setStatus('Search cancelled');
    };

    // Submit on Enter (some terminals send `enter`, others `return`); cancel on
    // Escape. Bind explicitly so it works regardless of how the terminal maps
    // the Return key.
    prompt.key(['enter', 'return', 'C-m'], () => finish(prompt.value));
    prompt.key(['escape'], () => finish(null));

    prompt.focus();
    // Enter input mode; the callback is a fallback for terminals that do fire
    // it (deduped by the `done` guard above).
    prompt.readInput((err, value) => finish(value));
    this.screen.render();
  }

  async _runSearch(term) {
    this.searchTerm = term;
    this.setStatus(`Searching "${term}" across ${this.logs.length} logs…`);
    try {
      // Ensure all bodies are loaded.
      const withBodies = [];
      for (const log of this.logs) {
        const body = await this.getBody(log.id);
        withBodies.push({ id: log.id, operation: log.operation, body });
      }
      this.searchResults = searchLogs(withBodies, term);
      this.searchIndex = 0;
      if (!this.searchResults.length) {
        this.setStatus(`No matches for "${term}"`, 'yellow');
        this.table.focus();
        return;
      }
      this._mode = 'search';
      this._renderSearchResult();
      this.setStatus(
        `${this.searchResults.length} match${this.searchResults.length === 1 ? '' : 'es'} for "${term}" — match 1/${this.searchResults.length}`
      );
    } catch (e) {
      this.setStatus(`Search error: ${e.message}`, 'red');
    }
  }

  _renderSearchResult() {
    const r = this.searchResults[this.searchIndex];
    if (!r) return;
    const lines = r.context.map((c) => ({
      text: (c.match ? '▶ ' : '  ') + c.text,
      color: c.color,
    }));
    this.viewer.setLabel(
      ` Search "${this.searchTerm}" — ${this.searchIndex + 1}/${this.searchResults.length} (${r.operation}) `
    );
    const hint =
      '{gray-fg}←/→ or n/p: prev/next match   ↵ or o: open full log   w: download   esc: close{/gray-fg}';
    this.viewer.setContent(`${hint}\n\n${toBlessed(lines)}`);
    this.viewer.hidden = false;
    this.table.hidden = true;
    this.viewer.setScroll(0);
    this.viewer.focus();
    this.screen.render();
  }

  _searchStatus() {
    this.setStatus(`Match ${this.searchIndex + 1}/${this.searchResults.length}`);
  }

  nextResult() {
    if (this._mode !== 'search' || !this.searchResults.length) return;
    this.searchIndex = (this.searchIndex + 1) % this.searchResults.length;
    this._renderSearchResult();
    this._searchStatus();
  }

  prevResult() {
    if (this._mode !== 'search' || !this.searchResults.length) return;
    this.searchIndex =
      (this.searchIndex - 1 + this.searchResults.length) % this.searchResults.length;
    this._renderSearchResult();
    this._searchStatus();
  }

  async openFullFromSearch() {
    if (this._mode !== 'search') return;
    const r = this.searchResults[this.searchIndex];
    if (!r) return;
    const body = await this.getBody(r.logId);
    this._currentBody = body;
    this._currentLogId = r.logId;
    this._debugOnly = false;
    this._mode = null;
    // With debug-only off, segment index == body line index; _showViewer maps
    // that through line-wrapping and scrolls there with context above.
    this._showViewer(body, false, ` Log View — line ${r.lineIndex + 1} `, r.lineIndex);
    this.setStatus(`Viewing full log — line ${r.lineIndex + 1}`);
  }

  // Toggle between the current user and the automated process. From any other
  // (custom) target, jump straight back to the current user.
  async cycleUser() {
    this.traceTarget = this.traceTarget === 'current' ? 'automated' : 'current';
    await this.initTrace();
  }

  // Prompt for a specific username/alias to trace (blank/esc = no change).
  async enterCustomUser() {
    const prompt = blessed.textbox({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 3,
      border: { type: 'line' },
      label: ' Trace username/alias (↵ apply, esc cancel) ',
      inputOnFocus: true,
      style: { border: { fg: 'cyan' } },
    });
    this._promptOpen = true;

    let done = false;
    const finish = async (value) => {
      if (done) return;
      done = true;
      this._promptOpen = false;
      prompt.destroy();
      this.table.focus();
      this.screen.render();
      const v = (value || '').trim();
      if (v) {
        this.traceTarget = v;
        await this.initTrace();
      } else {
        this.setStatus('Trace user unchanged');
      }
    };

    // Explicit Enter/Escape handling so it works regardless of how the terminal
    // maps the Return key (the default readInput callback is a deduped fallback).
    prompt.key(['enter', 'return', 'C-m'], () => finish(prompt.value));
    prompt.key(['escape'], () => finish(null));

    prompt.focus();
    prompt.readInput((err, value) => finish(value));
    this.screen.render();
  }

  // Pick an org from the CLI's authenticated list and switch to it.
  async selectOrg() {
    this.setStatus('Loading orgs…');
    let orgs;
    try {
      orgs = await listOrgs();
    } catch (e) {
      return this.setStatus(`Org list error: ${e.message}`, 'red');
    }
    if (!orgs.length) return this.setStatus('No authenticated orgs found', 'yellow');

    const items = orgs.map((o) => {
      const name = o.alias ? `${o.alias}  {gray-fg}${o.username}{/gray-fg}` : o.username;
      const marks =
        (o.isDefault ? ' {yellow-fg}(default){/yellow-fg}' : '') +
        (o.username === this.client.username ? ' {green-fg}● current{/green-fg}' : '');
      return ` ${name}${marks}`;
    });

    const list = blessed.list({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '70%',
      height: '60%',
      border: { type: 'line' },
      label: ' Select org — ↵ switch + set default, esc cancel ',
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: { ch: ' ', style: { bg: 'cyan' } },
      style: { border: { fg: 'cyan' }, selected: { bg: 'blue', fg: 'white' } },
      items,
    });

    this._promptOpen = true;
    const curIdx = orgs.findIndex((o) => o.username === this.client.username);
    if (curIdx >= 0) list.select(curIdx);
    list.focus();
    this.screen.render();

    list.key('escape', () => {
      this._promptOpen = false;
      list.destroy();
      this.table.focus();
      this.setStatus('Org switch cancelled');
    });

    list.on('select', (item, idx) => {
      list.destroy();
      this.screen.render();
      // _promptOpen stays true until switchOrg finishes.
      this.switchOrg(orgs[idx]);
    });
  }

  async switchOrg(org) {
    const target = org.alias || org.username;
    this.setStatus(`Switching to ${target}…`);
    try {
      const session = await getSession(target);
      this.client = new SalesforceClient(session, this.client.apiVersion);
      // Reset everything tied to the previous org.
      this.traceTarget = 'current';
      this.traceFlag = null;
      this._initError = null;
      this.logs = [];
      this.bodyCache.clear();
      this.searchResults = [];
      this.searchIndex = 0;
      this._mode = null;
      this.renderHeader();
      this.renderTable();
      await this.initTrace();
      await this.refreshLogs();

      // Persist the selection as the CLI's default org so it sticks next run.
      const label = this.client.alias || this.client.username;
      try {
        await setDefaultOrg(target);
        if (!this._initError) {
          this.setStatus(`Switched to ${label} — set as default org`, 'green');
        }
      } catch (defErr) {
        // Switching still worked; only the persistence failed.
        this.setStatus(`Switched to ${label} (could not set default: ${defErr.message})`, 'yellow');
      }
    } catch (e) {
      this.setStatus(`Switch error: ${e.message}`, 'red');
    } finally {
      this._promptOpen = false;
      this.table.focus();
      this.screen.render();
    }
  }

  async deleteLogs() {
    const question = blessed.question({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: '50%',
      height: 'shrink',
      border: { type: 'line' },
      style: { border: { fg: 'red' } },
    });
    this._promptOpen = true;
    question.ask('Delete up to 100 logs from the org? (y/N)', async (err, ok) => {
      this._promptOpen = false;
      if (!ok) return this.setStatus('Delete cancelled');
      this.setStatus('Deleting…');
      try {
        await this.client.deleteDebugLogs(this.logs.map((l) => l.id));
        this.setStatus('Logs deleted', 'green');
        await this.refreshLogs();
      } catch (e) {
        this.setStatus(`Delete error: ${e.message}`, 'red');
      }
    });
  }

  // --- Keys ------------------------------------------------------------------

  // Table-level actions are allowed only with no overlay/prompt open.
  _canAct() {
    return this.viewer.hidden && !this._promptOpen;
  }

  _bindKeys() {
    const s = this.screen;

    s.key(['q', 'C-c'], () => {
      if (!this._promptOpen) process.exit(0);
    });

    s.key('escape', () => {
      if (!this.viewer.hidden) this._closeViewer();
    });

    // Duration selection 1..5 (only when no overlay open)
    ['1', '2', '3', '4', '5'].forEach((k, i) => {
      s.key(k, () => {
        if (!this._canAct()) return;
        this.durationIndex = i;
        this.renderHeader();
        this.setStatus(`Duration: ${DURATIONS[i]} min`);
      });
    });

    s.key('e', () => this._canAct() && this.enable());
    s.key('s', () => this._canAct() && this.stop());
    s.key('u', () => this._canAct() && this.cycleUser());
    s.key('c', () => this._canAct() && this.enterCustomUser());
    s.key('x', () => this._canAct() && this.deleteLogs());

    // Download: from the table, the selected log. From the viewer (log view or
    // search results), the log on screen — bound on the viewer too so it fires
    // reliably while the viewer is focused.
    s.key('w', () => {
      if (this._promptOpen) return;
      if (this.viewer.hidden) this.downloadSelected();
    });
    this.viewer.key('w', () => {
      if (!this._promptOpen) this.downloadCurrentView();
    });

    // Toggle native text selection (works from the table or the viewer).
    s.key('m', () => {
      if (!this._promptOpen) this.toggleSelectionMode();
    });

    s.key('/', () => this._canAct() && this.doSearch());

    this.table.key('enter', () => this.viewSelected());

    s.key('d', () => this.toggleDebugOnly());
    s.key('n', () => this.nextResult());
    s.key('p', () => this.prevResult());

    // Search-results navigation: left/right move between matches, Enter opens
    // the full log for the current match.
    s.key('right', () => this.nextResult());
    s.key('left', () => this.prevResult());
    this.viewer.key('enter', () => {
      if (this._mode === 'search') this.openFullFromSearch();
    });

    // `o`: open the full log while viewing search results, otherwise (from the
    // table) open the org picker.
    s.key('o', () => {
      if (this._mode === 'search') this.openFullFromSearch();
      else if (this._canAct()) this.selectOrg();
    });
  }

  // --- Entry point -----------------------------------------------------------

  async start() {
    this.renderHeader();
    this.renderTable();
    this.setStatus('Starting…');

    // Live countdown.
    this._timer = setInterval(() => {
      if (this._selectionMode) return; // don't redraw over a selection
      if (this.traceFlag && this.traceFlag.active && this.traceFlag.expirationDate) {
        if (this.traceFlag.expirationDate.getTime() <= Date.now()) {
          this.traceFlag.active = false;
          this.traceFlag.expirationDate = null;
        }
        // A header repaint forces a full screen.render(), which re-parses and
        // re-wraps the large log viewer and makes scrolling stutter. The header
        // is covered by the viewer anyway, so defer the repaint until it closes.
        if (this.viewer.hidden) this.renderHeader();
      }
    }, 1000);

    // Background log polling. Quietly reloads the table on an interval,
    // keeping the cursor and cached bodies; skips while a prompt is open, a
    // refresh is already in flight, or text selection is active.
    this._autoRefreshTimer = setInterval(() => {
      if (
        !this.autoRefresh ||
        this._refreshing ||
        this._promptOpen ||
        this._selectionMode ||
        !this.viewer.hidden // viewing a log: don't reload/repaint mid-scroll
      )
        return;
      this.refreshLogs({ silent: true, clearCache: false });
    }, this.autoRefreshMs);

    await this.initTrace();
    await this.refreshLogs();
    // Don't bury a trace-resolution failure behind "Ready".
    if (this._initError) {
      this.setStatus(`Trace error: ${this._initError.message}`, 'red');
    } else {
      this.setStatus('Ready');
    }
  }
}
