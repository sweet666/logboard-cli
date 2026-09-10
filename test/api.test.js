import { test } from 'node:test';
import assert from 'node:assert/strict';
import { soqlString, chunk, SalesforceClient } from '../src/api.js';

const session = {
  accessToken: 'tok1',
  instanceUrl: 'https://example.my.salesforce.com/',
  username: 'me@example.com',
};

// Swap global fetch for a scripted stub; returns the recorded call list.
function stubFetch(responses) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected fetch: ${url}`);
    return {
      ok: next.status < 400,
      status: next.status,
      text: async () => next.body ?? '',
    };
  };
  calls.restore = () => {
    globalThis.fetch = original;
  };
  return calls;
}

test('soqlString escapes quotes and backslashes', () => {
  assert.equal(soqlString("o'brien"), "o\\'brien");
  assert.equal(soqlString('back\\slash'), 'back\\\\slash');
  // The classic injection: a quote plus a trailing clause must stay inert.
  assert.equal(soqlString("x' OR Name != '"), "x\\' OR Name != \\'");
  assert.equal(soqlString(null), '');
});

test('getUserIdByUsernameOrAlias escapes the value it interpolates', async () => {
  const calls = stubFetch([{ status: 200, body: JSON.stringify({ records: [{ Id: '005x' }] }) }]);
  try {
    const client = new SalesforceClient(session);
    const id = await client.getUserIdByUsernameOrAlias("o'brien");
    assert.equal(id, '005x');
    const sent = decodeURIComponent(calls[0].url);
    assert.ok(sent.includes("Username = 'o\\'brien'"), sent);
  } finally {
    calls.restore();
  }
});

test('chunk splits to the requested size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 200), []);
  assert.equal(chunk(Array.from({ length: 450 }, (_, i) => i), 200).length, 3);
});

test('deleteDebugLogs uses one collections call per 200 ids', async () => {
  const ids = Array.from({ length: 250 }, (_, i) => `07L${i}`);
  const ok = (n) => JSON.stringify(Array.from({ length: n }, () => ({ success: true })));
  const calls = stubFetch([
    { status: 200, body: ok(200) },
    { status: 200, body: ok(50) },
  ]);
  try {
    const client = new SalesforceClient(session);
    const res = await client.deleteDebugLogs(ids);
    assert.equal(res.deleted, 250);
    assert.equal(res.failed.length, 0);
    assert.equal(calls.length, 2); // not 250
    assert.ok(calls[0].url.includes('/composite/sobjects'));
    assert.equal(calls[0].opts.method, 'DELETE');
  } finally {
    calls.restore();
  }
});

test('deleteDebugLogs reports per-record failures from the collections response', async () => {
  const calls = stubFetch([
    {
      status: 200,
      body: JSON.stringify([
        { success: true },
        { success: false, errors: [{ statusCode: 'ENTITY_IS_DELETED', message: 'gone' }] },
      ]),
    },
  ]);
  try {
    const client = new SalesforceClient(session);
    const res = await client.deleteDebugLogs(['a', 'b']);
    assert.equal(res.deleted, 1);
    assert.deepEqual(res.failed, [{ id: 'b', error: 'ENTITY_IS_DELETED: gone' }]);
  } finally {
    calls.restore();
  }
});

test('deleteDebugLogs falls back to per-record deletes when collections fails', async () => {
  const calls = stubFetch([
    { status: 400, body: 'not supported' }, // collections rejected
    { status: 204 },
    { status: 404, body: 'missing' },
  ]);
  try {
    const client = new SalesforceClient(session);
    const res = await client.deleteDebugLogs(['a', 'b']);
    assert.equal(res.deleted, 1);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].id, 'b');
    assert.ok(calls[1].url.endsWith('/sobjects/ApexLog/a'));
  } finally {
    calls.restore();
  }
});

test('deleteDebugLogs does NOT fan out per-record on an auth failure', async () => {
  // A 401 that survives re-auth must propagate, not turn into 200 retries.
  const calls = stubFetch([
    { status: 401, body: 'INVALID_SESSION_ID' },
    { status: 401, body: 'INVALID_SESSION_ID' },
  ]);
  try {
    const client = new SalesforceClient(session, 'v60.0', {
      onUnauthorized: async () => 'tok2',
    });
    await assert.rejects(() => client.deleteDebugLogs(['a', 'b', 'c']), /401/);
    assert.equal(calls.length, 2); // the collections call + its one replay
  } finally {
    calls.restore();
  }
});

test('deleteDebugLogs does not fan out on a server error either', async () => {
  const calls = stubFetch([{ status: 500, body: 'internal' }]);
  try {
    await assert.rejects(
      () => new SalesforceClient(session).deleteDebugLogs(['a', 'b']),
      /500/
    );
    assert.equal(calls.length, 1);
  } finally {
    calls.restore();
  }
});

test('deleteDebugLogs short-circuits on an empty list', async () => {
  const calls = stubFetch([]);
  try {
    assert.deepEqual(await new SalesforceClient(session).deleteDebugLogs([]), {
      deleted: 0,
      failed: [],
    });
    assert.equal(calls.length, 0);
  } finally {
    calls.restore();
  }
});

test('a 401 triggers one re-auth and replays the request', async () => {
  const calls = stubFetch([
    { status: 401, body: 'INVALID_SESSION_ID' },
    { status: 200, body: JSON.stringify({ records: [] }) },
  ]);
  let refreshes = 0;
  try {
    const client = new SalesforceClient(session, 'v60.0', {
      onUnauthorized: async () => {
        refreshes++;
        return 'tok2';
      },
    });
    await client.query('SELECT Id FROM User');
    assert.equal(refreshes, 1);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok1');
    assert.equal(calls[1].opts.headers.Authorization, 'Bearer tok2'); // replayed
    assert.equal(client.token, 'tok2');
  } finally {
    calls.restore();
  }
});

test('a second 401 after re-auth surfaces the error instead of looping', async () => {
  const calls = stubFetch([
    { status: 401, body: 'INVALID_SESSION_ID' },
    { status: 401, body: 'INVALID_SESSION_ID' },
  ]);
  try {
    const client = new SalesforceClient(session, 'v60.0', {
      onUnauthorized: async () => 'tok2',
    });
    await assert.rejects(() => client.query('SELECT Id FROM User'), /401/);
    assert.equal(calls.length, 2);
  } finally {
    calls.restore();
  }
});

test('a failed re-auth surfaces the original 401', async () => {
  const calls = stubFetch([{ status: 401, body: 'INVALID_SESSION_ID' }]);
  try {
    const client = new SalesforceClient(session, 'v60.0', {
      onUnauthorized: async () => {
        throw new Error('sf CLI unavailable');
      },
    });
    await assert.rejects(() => client.query('SELECT Id FROM User'), /401/);
  } finally {
    calls.restore();
  }
});

test('a null/omitted api version falls back to the default, never "null"', async () => {
  for (const v of [null, undefined, '']) {
    const client = new SalesforceClient(session, v);
    assert.equal(client.apiVersion, 'v60.0');
    assert.ok(!client.dataBase.includes('null'), client.dataBase);
    assert.ok(!client.toolingBase.includes('undefined'), client.toolingBase);
  }
});

test('a 401 arriving after another request refreshed replays without re-auth', async () => {
  const original = globalThis.fetch;
  const sent = [];
  let refreshes = 0;
  let client;
  // The first attempt 401s, but by the time it lands a concurrent request has
  // already installed a fresh token — so this one should just replay with it.
  globalThis.fetch = async (url, opts) => {
    sent.push(opts.headers.Authorization);
    if (sent.length === 1) {
      client.token = 'tok2';
      return { ok: false, status: 401, text: async () => 'INVALID_SESSION_ID' };
    }
    return { ok: true, status: 200, text: async () => '{"records":[]}' };
  };
  try {
    client = new SalesforceClient(session, 'v60.0', {
      onUnauthorized: async () => {
        refreshes++;
        return 'tok3';
      },
    });
    await client.query('SELECT Id FROM User');
    assert.equal(refreshes, 0, 'should not spawn a second re-auth');
    assert.deepEqual(sent, ['Bearer tok1', 'Bearer tok2']);
  } finally {
    globalThis.fetch = original;
  }
});

test('concurrent 401s share a single re-auth', async () => {
  const calls = stubFetch([
    { status: 401, body: 'x' },
    { status: 401, body: 'x' },
    { status: 200, body: '{"records":[]}' },
    { status: 200, body: '{"records":[]}' },
  ]);
  let refreshes = 0;
  try {
    const client = new SalesforceClient(session, 'v60.0', {
      onUnauthorized: async () => {
        refreshes++;
        return 'tok2';
      },
    });
    await Promise.all([client.query('A'), client.query('B')]);
    assert.equal(refreshes, 1);
  } finally {
    calls.restore();
  }
});
