// Salesforce Tooling/REST API client — the terminal equivalent of
// LogBoardController.cls. Every method maps to a plain HTTP call against the
// org, authenticated with the access token from the local Salesforce CLI.

const API_VERSION = 'v60.0';
const AUTOMATED_USER_ALIAS = 'autoproc';
const DEV_CONSOLE_LEVEL = 'SFDC_DevConsole';

export class SalesforceClient {
  /** @param {{accessToken:string, instanceUrl:string, username:string, alias?:string}} session */
  constructor(session, apiVersion = API_VERSION) {
    this.token = session.accessToken;
    this.instanceUrl = session.instanceUrl.replace(/\/$/, '');
    this.username = session.username;
    this.alias = session.alias || '';
    this.apiVersion = apiVersion;
  }

  get toolingBase() {
    return `${this.instanceUrl}/services/data/${this.apiVersion}/tooling`;
  }

  get dataBase() {
    return `${this.instanceUrl}/services/data/${this.apiVersion}`;
  }

  async _request(url, { method = 'GET', body, raw = false } = {}) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Salesforce API ${res.status}: ${text}`);
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
      const soql = `SELECT Id FROM User WHERE Username = '${this.username}' LIMIT 1`;
      const data = await this.query(soql);
      if (data.records && data.records.length) return data.records[0].Id;
    }
    // Fallback to the identity endpoint if no username is available.
    const data = await this._request(`${this.instanceUrl}/services/oauth2/userinfo`);
    return data.user_id;
  }

  async getUserIdByUsernameOrAlias(value) {
    const soql = `SELECT Id FROM User WHERE Username = '${value}' OR Alias = '${value}' LIMIT 1`;
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
      `WHERE LogType = 'USER_DEBUG' AND TracedEntityId = '${userId}'`;
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
   * @param {string} [filter] optional extra SOQL WHERE clause.
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
      const inList = userIds.map((id) => `'${id}'`).join(',');
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

  /** Delete up to 100 logs. */
  async deleteDebugLogs(ids) {
    for (const id of ids) {
      await this._request(`${this.dataBase}/sobjects/ApexLog/${id}`, {
        method: 'DELETE',
      });
    }
  }
}
