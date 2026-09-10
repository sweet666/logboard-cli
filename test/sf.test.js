import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseOrgTarget } from '../src/sf.js';

test('chooseOrgTarget picks the sole authenticated org', () => {
  const choice = chooseOrgTarget([
    { alias: 'dev', username: 'me@dev.com', connectedStatus: 'Connected' },
  ]);
  assert.deepEqual(choice, { target: 'dev' });
});

test('chooseOrgTarget falls back to username when no alias', () => {
  const choice = chooseOrgTarget([{ username: 'me@dev.com', connectedStatus: 'Connected' }]);
  assert.deepEqual(choice, { target: 'me@dev.com' });
});

test('chooseOrgTarget prefers a flagged default among several', () => {
  const choice = chooseOrgTarget([
    { alias: 'dev', username: 'a', connectedStatus: 'Connected' },
    { alias: 'prod', username: 'b', isDefault: true, connectedStatus: 'Connected' },
  ]);
  assert.deepEqual(choice, { target: 'prod' });
});

test('chooseOrgTarget reports ambiguity when several orgs and no default', () => {
  const orgs = [
    { alias: 'dev', username: 'a', connectedStatus: 'Connected' },
    { alias: 'prod', username: 'b', connectedStatus: 'Connected' },
  ];
  const choice = chooseOrgTarget(orgs);
  assert.equal(choice.ambiguous, true);
  assert.equal(choice.orgs.length, 2);
});

test('chooseOrgTarget restricts to connected orgs when some are connected', () => {
  const choice = chooseOrgTarget([
    { alias: 'dead', username: 'a', connectedStatus: 'Unknown' },
    { alias: 'live', username: 'b', connectedStatus: 'Connected' },
  ]);
  assert.deepEqual(choice, { target: 'live' });
});

test('chooseOrgTarget uses all orgs when none report Connected', () => {
  const choice = chooseOrgTarget([
    { alias: 'only', username: 'a', connectedStatus: 'Unknown' },
  ]);
  assert.deepEqual(choice, { target: 'only' });
});

test('chooseOrgTarget reports empty when there are no orgs', () => {
  assert.deepEqual(chooseOrgTarget([]), { empty: true });
  assert.deepEqual(chooseOrgTarget(undefined), { empty: true });
});
