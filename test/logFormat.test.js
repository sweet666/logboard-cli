import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLine, formatLog, searchLogs, COLORS } from '../src/logFormat.js';

test('classifyLine maps event types to the correct colours', () => {
  assert.equal(classifyLine('10:00 CODE_UNIT_STARTED foo'), COLORS.unit);
  assert.equal(classifyLine('10:00 METHOD_ENTRY foo'), COLORS.unit);
  assert.equal(classifyLine('10:00 CALLOUT_REQUEST foo'), COLORS.callout);
  assert.equal(classifyLine('10:00 SOQL_EXECUTE_BEGIN foo'), COLORS.soql);
  assert.equal(classifyLine('10:00 USER_DEBUG|[1]|DEBUG|hi'), COLORS.debug);
  assert.equal(classifyLine('10:00 EXCEPTION_THROWN x'), COLORS.error);
  assert.equal(classifyLine('10:00 FATAL_ERROR x'), COLORS.error);
  assert.equal(classifyLine('10:00 HEAP_ALLOCATE'), COLORS.none);
});

test('formatLog returns one segment per line', () => {
  const body = 'A USER_DEBUG x\nB SOQL_EXECUTE_BEGIN y\nC nothing';
  const segs = formatLog(body);
  assert.equal(segs.length, 3);
  assert.equal(segs[0].color, COLORS.debug);
  assert.equal(segs[1].color, COLORS.soql);
  assert.equal(segs[2].color, COLORS.none);
});

test('formatLog debugOnly keeps only USER_DEBUG lines', () => {
  const body = 'A USER_DEBUG x\nB SOQL_EXECUTE_BEGIN y\nC USER_DEBUG z';
  const segs = formatLog(body, { debugOnly: true });
  assert.equal(segs.length, 2);
  assert.ok(segs.every((s) => s.color === COLORS.debug));
});

test('formatLog debugOnly with no matches shows placeholder', () => {
  const segs = formatLog('A SOQL_EXECUTE_BEGIN y', { debugOnly: true });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'Nothing to show');
});

test('searchLogs returns matches with one line of context each side', () => {
  const logs = [
    { id: '07L1', operation: 'VF', body: 'line0\nNEEDLE here\nline2\nother' },
  ];
  const results = searchLogs(logs, 'needle');
  assert.equal(results.length, 1);
  assert.equal(results[0].logId, '07L1');
  assert.equal(results[0].context.length, 3); // before, match, after
  assert.equal(results[0].context[1].match, true);
  assert.equal(results[0].context[1].text, 'NEEDLE here');
});

test('searchLogs is case-insensitive and finds multiple matches', () => {
  const logs = [{ id: 'x', body: 'foo\nBar\nfoo' }];
  assert.equal(searchLogs(logs, 'foo').length, 2);
  assert.equal(searchLogs(logs, '').length, 0);
});

test('searchLogs context clamps at file boundaries', () => {
  const logs = [{ id: 'x', body: 'match\nsecond' }];
  const [r] = searchLogs(logs, 'match');
  assert.equal(r.context.length, 2); // no line before line 0
  assert.equal(r.context[0].match, true);
});
