#!/usr/bin/env node
// LogBoard CLI — terminal version of the Salesforce LogBoard component.
//
// Usage:
//   logboard [--org <alias>] [--api <version>]
//   logboard --help
//
// Auth comes from the Salesforce CLI (`sf org display`), so authenticate once
// with `sf org login web` and you're ready.

import { readFileSync } from 'node:fs';
import { getSession } from '../src/sf.js';
import { SalesforceClient } from '../src/api.js';
import { LogBoardUI } from '../src/ui.js';

// Read the version from package.json so it can never drift from the release.
function readVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    );
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

function parseArgs(argv) {
  const args = { org: undefined, api: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--version' || a === '-v') args.version = true;
    else if (a === '--org' || a === '-o') args.org = argv[++i];
    else if (a === '--api') args.api = argv[++i];
  }
  return args;
}

const HELP = `LogBoard CLI — manage Apex trace flags and view/search debug logs.

Usage:
  logboard [options]

Options:
  -o, --org <alias>   Target org alias/username (defaults to your CLI default org)
      --api <version> Salesforce API version (e.g. v60.0)
  -v, --version       Show the LogBoard version
  -h, --help          Show this help

Keys (inside the app):
  1-5         select trace duration (1/2/3/5/10 min)
  e / s       enable / stop debug logging
  u           toggle traced user (current ↔ automated process)
  c           trace a specific user by username/alias
  o           from the log list: select / switch org
              in search results: open the full log for the current match
  r           refresh the log list now
  a           pause / resume auto-refresh
  ↵           view selected log
  d           toggle "debug only" in the viewer
  w           download the current log
  m           toggle select-text mode
  /           search across all loaded logs
  n / p       next / previous search result
  x           delete logs from the org
  esc         close viewer / search
  q           quit
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (args.version) {
    process.stdout.write(`logboard ${readVersion()}\n`);
    process.exit(0);
  }

  let session;
  try {
    session = await getSession(args.org);
  } catch (err) {
    // No default org but several are authenticated: launch straight into the
    // in-app org picker instead of failing.
    if (err.code === 'NO_DEFAULT_ORG') {
      const ui = new LogBoardUI(null, args.api);
      await ui.start({ pickOrg: true });
      return;
    }
    process.stderr.write(`\n${err.message}\n`);
    process.exit(1);
  }

  const client = new SalesforceClient(session, args.api);
  const ui = new LogBoardUI(client);
  await ui.start();
}

main().catch((err) => {
  process.stderr.write(`\nFatal: ${err.stack || err.message}\n`);
  process.exit(1);
});
