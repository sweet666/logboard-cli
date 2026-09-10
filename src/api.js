// Salesforce Tooling/REST API client — the terminal equivalent of
// LogBoardController.cls. Every method maps to a plain HTTP call against the
// org, authenticated with the access token from the local Salesforce CLI.

const API_VERSION = 'v60.0';
const AUTOMATED_USER_ALIAS = 'autoproc';
const DEV_CONSOLE_LEVEL = 'SFDC_DevConsole';

// sObject Collections accepts at most 200 ids per request.
const COLLECTION_LIMIT = 200;

// Statuses that mean "this org/API version doesn't offer that endpoint for
// this object" — the only case where retrying one record at a time can help.
const UNSUPPORTED_ENDPOINT_STATUSES = new Set([400, 404, 405, 501]);

/**
 * Escape a value for use inside a single-quoted SOQL string literal.
 * SOQL only requires backslash and quote characters to be escaped; without
 * this, a username containing an apostrophe (or a deliberately crafted one)
 * breaks out of the literal and changes the query.
 * @param {unknown} value
 */
export function soqlString(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

/** Split an array into chunks of at most `size` items. */
export function chunk(items, size) {
  const step = Math.max(1, Math.floor(size) || 1); // a 0 step would loop forever
  const out = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

export class SalesforceClient {
  /**
   * @param {{accessToken:string, instanceUrl:string, username:string, alias?:string}} session
   * @param {string} [apiVersion]
   * @param {{onUnauthorized?: () => Promise<string|null>}} [opts]
   *   onUnauthorized — called once when the org rejects the token with 401, and
   *   expected to resolve a fresh access token (or null to give up). Lets the
   *   app survive the CLI session expiring mid-run instead of failing every
   *   subsequent call.
   */
  constructor(session, apiVersion, { onUnauthorized } = {}) {
    this.token = session.accessToken;
    this.instanceUrl = session.instanceUrl.replace(/\/$/, '');
    this.username = session.username;
    this.alias = session.alias || '';
    // A default parameter wouldn't catch null, which callers can produce when
    // no --api was supplied; that would put "null" straight into request URLs.
    this.apiVersion = apiVersion || API_VERSION;
    this.onUnauthorized = onUnauthorized || null;
    // Shared across concurrent 401s so a burst of failing requests triggers a
    // single re-auth rather than one CLI invocation each.
    this._refreshPromise = null;
  }

  get toolingBase() {
    return `${this.instanceUrl}/services/data/${this.apiVersion}/tooling`;
  }

  get dataBase() {
    return `${this.instanceUrl}/services/data/${this.apiVersion}`;
  }

  /**
   * Ask the host app for a fresh access token, at most once per burst.
   * @returns {Promise<string|null>} the new token, or null if unavailable.
   */
  async _refreshToken() {
    if (!this.onUnauthorized) return null;
    if (!this._refreshPromise) {
      this._refreshPromise = Promise.resolve()
        .then(() => this.onUnauthorized())
        .then((token) => {
          if (token) this.token = token;
          return token || null;
        })
        .catch(() => null)
        .finally(() => {
          this._refreshPromise = null;
        });
    }
    return this._refreshPromise;
  }

  async _request(url, { method = 'GET', body, raw = false, _retried = false } = {}) {
    // Remember which token this attempt used, so a 401 that arrives after a
    // concurrent request already refreshed can be replayed without spawning a
    // second `sf` invocation of its own.
    const tokenUsed = this.token;
    const headers = {
      Authorization: `Bearer ${tokenUsed}`,
      'Content-Type': 'application/json',
    };
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      // An expired CLI session shows up as 401 on every call. Refresh once and
      // replay the request so a long-running session heals itself.
      if (res.status === 401 && !_retried) {
        if (this.token !== tokenUsed) {
          // Someone else already refreshed while this was in flight.
          return this._request(url, { method, body, raw, _retried: true });
        }
        const token = await this._refreshToken();
        if (token) return this._request(url, { method, body, raw, _retried: true });
      }
      const text = await res.text();
      const err = new Error(`Salesforce API ${res.status}: ${text}`);
      err.status = res.status;
      throw err;
    }

    if (raw) return res.text();
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  // --- Queries ---------------------------------------------------------------

  async query(soql, { tooling = false } = {}) {
    const base = tooling ? this.toolingBase : this.dataBase;
    const url = `${base}/query/?q=${encodeURIComponent(soql)}`;
    return this._request(url);
  }

  // --- Users -----------------------------------------------------------------

  async getCurrentUserId() {
    // Resolve the token owner via SOQL on the username the CLI already gave us.
    // The /services/oauth2/userinfo identity endpoint requires an OAuth-scoped
    // token and returns "403 Missing_OAuth_Token" for some `sf org display`
    // sessions, even though the same token works for the query API below.
    if (this.username) {
      const soql = `SELECT Id FROM User WHERE Username = '${soqlString(this.username)}' LIMIT 1`;
      const data = await this.query(soql);
      if (data.records && data.records.length) return data.records[0].Id;
    }
    // Fallback to the identity endpoint if no username is available.
    const data = await this._request(`${this.instanceUrl}/services/oauth2/userinfo`);
    return data.user_id;
  }

  async getUserIdByUsernameOrAlias(value) {
    const v = soqlString(value);
    const soql = `SELECT Id FROM User WHERE Username = '${v}' OR Alias = '${v}' LIMIT 1`;
    const data = await this.query(soql);
    if (!data.records.length) throw new Error(`No user found for "${value}".`);
    return data.records[0].Id;
  }

  /**
   * Resolve a trace target to a user id.
   * @param {'current'|'automated'|string} target
   */
  async resolveUserId(target) {
    if (target === 'current') return this.getCurrentUserId();
    if (target === 'automated') return this.getUserIdByUsernameOrAlias(AUTOMATED_USER_ALIAS);
    return this.getUserIdByUsernameOrAlias(target);
  }

  // --- Trace flags -----------------------------------------------------------

  async getDevConsoleDebugLevelId() {
    const soql = `SELECT Id FROM DebugLevel WHERE DeveloperName = '${DEV_CONSOLE_LEVEL}'`;
    const data = await this.query(soql, { tooling: true });
    if (!data.records.length) {
      throw new Error(`DebugLevel "${DEV_CONSOLE_LEVEL}" not found in this org.`);
    }
    return data.records[0].Id;
  }

  /**
   * Returns the existing USER_DEBUG trace flag for a user (creating one if none
   * exists), plus whether it is currently active.
   * @returns {Promise<{id:string, expirationDate:Date|null, active:boolean}>}
   */
  async getActiveTraceFlag(userId) {
    const soql =
      `SELECT Id, ExpirationDate, TracedEntityId FROM TraceFlag ` +
      `WHERE LogType = 'USER_DEBUG' AND TracedEntityId = '${soqlString(userId)}'`;
    const data = await this.query(soql, { tooling: true });

    if (data.records && data.records.length) {
      const now = Date.now();
      let flag = data.records[0];
      for (const rec of data.records) {
        flag = rec;
        if (new Date(rec.ExpirationDate).getTime() > now) break;
      }
      const exp = new Date(flag.ExpirationDate);
      const active = exp.getTime() > now;
      return { id: flag.Id, expirationDate: active ? exp : null, active };
    }

    // None exists yet — create a (briefly-expiring) placeholder flag.
    const id = await this.createTraceFlag(userId);
    return { id, expirationDate: null, active: false };
  }

  async createTraceFlag(userId) {
    const levelId = await this.getDevConsoleDebugLevelId();
    const now = Date.now();
    const body = {
      StartDate: new Date(now + 2000).toISOString(),
      ExpirationDate: new Date(now + 4000).toISOString(),
      DebugLevelId: levelId,
      LogType: 'USER_DEBUG',
      TracedEntityId: userId,
    };
    const data = await this._request(`${this.toolingBase}/sobjects/TraceFlag`, {
      method: 'POST',
      body,
    });
    return data.id;
  }

  /** Enable/extend a trace flag for `durationMinutes`. Returns the new expiry. */
  async enableTraceFlag(traceId, durationMinutes) {
    const expiry = new Date(Date.now() + durationMinutes * 60 * 1000);
    await this._request(`${this.toolingBase}/sobjects/TraceFlag/${traceId}`, {
      method: 'PATCH',
      body: {
        StartDate: new Date().toISOString(),
        ExpirationDate: expiry.toISOString(),
      },
    });
    return expiry;
  }

  /** Immediately expire a trace flag. */
  async stopTraceFlag(traceId) {
    const expiry = new Date(Date.now() + 2000);
    await this._request(`${this.toolingBase}/sobjects/TraceFlag/${traceId}`, {
      method: 'PATCH',
      body: {
        StartDate: new Date().toISOString(),
        ExpirationDate: expiry.toISOString(),
      },
    });
  }

  // --- Logs ------------------------------------------------------------------

  /**
   * Most recent 100 ApexLog records, with user names resolved.
   * @param {string} [filter] optional extra SOQL WHERE clause. This is a raw
   *   clause, not a value, so it is interpolated verbatim and cannot be
   *   escaped — only pass a clause this code constructed. Never pass user
   *   input straight through; build it from `soqlString`-escaped literals.
   */
  async getDebugLogs(filter = '') {
    let soql =
      'SELECT Id, StartTime, Status, Operation, LogUserId, LogLength FROM ApexLog';
    if (filter && filter.trim()) soql += ` WHERE ${filter}`;
    soql += ' ORDER BY StartTime DESC LIMIT 100';

    const data = await this.query(soql);
    const logs = data.records || [];
    const userIds = [...new Set(logs.map((l) => l.LogUserId))];

    let userMap = {};
    if (userIds.length) {
      const inList = userIds.map((id) => `'${soqlString(id)}'`).join(',');
      const users = await this.query(
        `SELECT Id, Name FROM User WHERE Id IN (${inList})`
      );
      userMap = Object.fromEntries(users.records.map((u) => [u.Id, u.Name]));
    }

    return logs.map((log) => {
      const sizeMb = log.LogLength / (1024 * 1024);
      const rounded = Math.round(sizeMb * 100) / 100;
      return {
        id: log.Id,
        startTime: log.StartTime,
        status: log.Status,
        operation: log.Operation,
        userName: userMap[log.LogUserId] || log.LogUserId,
        size: (rounded !== 0 ? rounded : 0.01).toFixed(2),
      };
    });
  }

  /** Raw text body of a single log. */
  async getLogBody(logId) {
    return this._request(`${this.toolingBase}/sobjects/ApexLog/${logId}/Body/`, {
      raw: true,
    });
  }

  /**
   * Delete logs, preferring the sObject Collections endpoint (200 ids per
   * call) over one request per record. Falls back to per-record DELETEs if the
   * org rejects the collections call, so this works regardless of API version.
   * @param {string[]} ids
   * @returns {Promise<{deleted:number, failed:Array<{id:string, error:string}>}>}
   */
  async deleteDebugLogs(ids) {
    const list = (ids || []).filter(Boolean);
    if (!list.length) return { deleted: 0, failed: [] };

    const failed = [];
    let deleted = 0;

    for (const batch of chunk(list, COLLECTION_LIMIT)) {
      let results;
      try {
        // allOrNone=false so one undeletable log doesn't abort the whole batch.
        const url =
          `${this.dataBase}/composite/sobjects?allOrNone=false` +
          `&ids=${batch.map(encodeURIComponent).join(',')}`;
        results = await this._request(url, { method: 'DELETE' });
      } catch (err) {
        // Only retry record-by-record when the *endpoint* looks unsupported.
        // Falling back on an auth or network failure would replay the same
        // failure up to 200 more times (and re-auth on each one), burying the
        // real cause, so those propagate untouched.
        if (!UNSUPPORTED_ENDPOINT_STATUSES.has(err.status)) throw err;
        const fallback = await this._deleteOneByOne(batch);
        deleted += fallback.deleted;
        failed.push(...fallback.failed);
        continue;
      }

      // Collections returns a per-record result array, not an HTTP error, when
      // individual deletes fail — so successes must be counted per record.
      for (let i = 0; i < batch.length; i++) {
        const r = (results && results[i]) || {};
        if (r.success) deleted++;
        else failed.push({ id: batch[i], error: describeSaveErrors(r.errors) });
      }
    }

    return { deleted, failed };
  }

  /** Per-record DELETE fallback; never throws, reports failures per id. */
  async _deleteOneByOne(ids) {
    const failed = [];
    let deleted = 0;
    for (const id of ids) {
      try {
        await this._request(`${this.dataBase}/sobjects/ApexLog/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        deleted++;
      } catch (err) {
        failed.push({ id, error: err.message });
      }
    }
    return { deleted, failed };
  }
}

/** Flatten the Collections API's per-record error array into one line. */
function describeSaveErrors(errors) {
  if (!Array.isArray(errors) || !errors.length) return 'Unknown error';
  return errors
    .map((e) => [e.statusCode, e.message].filter(Boolean).join(': '))
    .join('; ');
}
