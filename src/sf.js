// Salesforce session resolution via the `sf` (or legacy `sfdx`) CLI.
// We reuse an already-authenticated org so no connected app / OAuth setup
// is required — the CLI version skips the RSS/TSS workaround entirely.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runCliJson(cmd, args) {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

async function runCliRaw(cmd, args) {
  const { stdout } = await execFileAsync(cmd, args, {
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

// A Salesforce session id looks like `00D...!AQ...`: it always contains "!"
// and no whitespace. This lets us tell a real token from a redaction string.
function looksLikeToken(value) {
  return typeof value === 'string' && /\S*!\S+/.test(value) && !/\s/.test(value.trim());
}

// Pull a token-shaped substring out of arbitrary command output (raw or JSON).
function extractToken(text) {
  const m = String(text).match(/[^\s"']*![^\s"']+/);
  return m ? m[0] : null;
}

/**
 * Resolve the live access token. Modern Salesforce CLI versions redact the
 * token in `org display`, replacing it with a hint like
 *   "[REDACTED] Use 'sf org auth show-access-token' to view"
 * so we run whatever command the CLI itself recommends to get the real value.
 */
async function resolveAccessToken(displayToken, orgAlias) {
  if (looksLikeToken(displayToken)) return displayToken.trim();

  // Parse the suggested command out of the CLI's own redaction message.
  const cmdMatch = String(displayToken).match(/'([^']+)'/);
  if (!cmdMatch) {
    throw new Error(
      'The CLI redacted the access token and gave no command to retrieve it. ' +
        'Try `sf org login web` to re-authenticate.'
    );
  }

  const parts = cmdMatch[1].trim().split(/\s+/);
  const bin = parts[0];
  const baseCmdArgs = parts.slice(1);
  if (orgAlias) baseCmdArgs.push('--target-org', orgAlias);

  // The reveal command guards behind an interactive confirmation prompt, which
  // times out when run non-interactively ("confirmation denied or timed out").
  // Try `--no-prompt` first to bypass it, then fall back to the bare command.
  let out;
  let lastErr;
  for (const args of [[...baseCmdArgs, '--no-prompt'], baseCmdArgs]) {
    try {
      out = await runCliRaw(bin, args);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (out === undefined) {
    throw new Error(
      `Could not retrieve the access token via \`${cmdMatch[1]}\`: ${lastErr.message}`
    );
  }

  const token = extractToken(out);
  if (!token) {
    throw new Error(
      `\`${cmdMatch[1]}\` did not return a usable access token. ` +
        'Try `sf org login web` to re-authenticate.'
    );
  }
  return token;
}

/**
 * Resolve an access token + instance URL from the local CLI auth.
 * @param {string} [orgAlias] optional org alias / username; defaults to the CLI default org.
 * @returns {Promise<{accessToken: string, instanceUrl: string, username: string, alias: string}>}
 */
export async function getSession(orgAlias) {
  const baseArgs = ['org', 'display', '--json'];
  if (orgAlias) baseArgs.push('--target-org', orgAlias);

  let result;
  try {
    result = await runCliJson('sf', baseArgs);
  } catch (sfErr) {
    // Fall back to the legacy sfdx CLI shape if `sf` is unavailable.
    try {
      const legacyArgs = ['force:org:display', '--json'];
      if (orgAlias) legacyArgs.push('-u', orgAlias);
      result = await runCliJson('sfdx', legacyArgs);
    } catch (sfdxErr) {
      throw new Error(
        'Could not get a Salesforce session. Make sure the Salesforce CLI is ' +
          'installed and you have authenticated an org (`sf org login web`).\n' +
          `sf error: ${sfErr.message}`
      );
    }
  }

  const data = result.result || result;
  const instanceUrl = (data.instanceUrl || '').trim();
  const username = data.username;
  // `org display` reports the alias; fall back to the alias the user passed.
  const alias = data.alias || orgAlias || '';

  if (!instanceUrl) {
    throw new Error(
      'The CLI returned no instance URL. Try `sf org login web` or pass --org <alias>.'
    );
  }

  // The token in `org display` is often redacted; resolve the real one.
  const accessToken = await resolveAccessToken(data.accessToken, orgAlias);

  return { accessToken, instanceUrl, username, alias };
}

// The CLI's own stderr explains *why* a command failed far better than the
// generic "Command failed: …" line Node puts in err.message, so prefer it.
function cliError(err) {
  const detail = String(err.stderr || err.stdout || err.message || '').trim();
  return detail.split('\n').filter(Boolean).pop() || err.message;
}

/**
 * Persist an org as the CLI's default target org, so it stays selected across
 * future runs (equivalent to `sf config set target-org <alias> --global`).
 *
 * `--global` is required: without it, `sf config set` writes project-local
 * config and fails when LogBoard isn't run from inside a Salesforce DX project.
 * @param {string} target org alias or username to make default.
 */
export async function setDefaultOrg(target) {
  if (!target) throw new Error('No org specified to set as default.');
  try {
    await runCliRaw('sf', ['config', 'set', `target-org=${target}`, '--global']);
  } catch (sfErr) {
    // Fall back to the legacy sfdx config key.
    try {
      await runCliRaw('sfdx', ['config:set', `defaultusername=${target}`, '--global']);
    } catch (sfdxErr) {
      throw new Error(`Could not set default org: ${cliError(sfErr)}`);
    }
  }
}

/**
 * List the orgs the CLI is authenticated against.
 * @returns {Promise<Array<{alias:string, username:string, instanceUrl:string, isDefault:boolean, connectedStatus:string}>>}
 */
export async function listOrgs() {
  let result;
  try {
    result = await runCliJson('sf', ['org', 'list', '--json']);
  } catch (sfErr) {
    try {
      result = await runCliJson('sfdx', ['force:org:list', '--json']);
    } catch (sfdxErr) {
      throw new Error(`Could not list orgs: ${sfErr.message}`);
    }
  }

  // `org list` groups orgs into arrays (nonScratchOrgs, scratchOrgs, …).
  // Flatten every array of org objects and de-dupe by username.
  const groups = result.result || {};
  const seen = new Map();
  for (const value of Object.values(groups)) {
    if (!Array.isArray(value)) continue;
    for (const o of value) {
      if (!o || !o.username || seen.has(o.username)) continue;
      seen.set(o.username, {
        alias: o.alias || (Array.isArray(o.aliases) ? o.aliases[0] : '') || '',
        username: o.username,
        instanceUrl: o.instanceUrl || '',
        isDefault: Boolean(o.isDefaultUsername || o.isDefaultDevHubUsername),
        connectedStatus: o.connectedStatus || o.status || '',
      });
    }
  }
  return [...seen.values()];
}
