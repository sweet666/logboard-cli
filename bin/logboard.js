#!/usr/bin/env node
// LogBoard CLI — terminal version of the Salesforce LogBoard component.
//
// Usage:
//   logboard [--org <alias>] [--api <version>]
//   logboard --help
//
// Auth comes from the Salesforce CLI (`sf org display`), so authenticate once
// with `sf org login web` and you're ready.

import { getSession } from '../src/sf.js';
import { SalesforceClient } from '../src/api.js';
import { LogBoardUI } from '../src/ui.js';

function parseArgs(argv) {
  const args = { org: undefined, api: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
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
  -h, --help          Show this help

Keys (inside the app):
  1-5         select trace duration (1/2/3/5/10 min)
  e / s       enable / stop debug logging
  u           cycle traced user (current → automated → custom)
  r           refresh log list
  ↵           view selected log
  d           toggle "debug only" in the viewer
  /           search across all loaded logs
  n / p       next / previous search result
  o           open the full log for the current search result
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

  let session;
  try {
    session = await getSession(args.org);
  } catch (err) {
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
