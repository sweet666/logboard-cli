import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LruCache } from '../src/lruCache.js';

// 'a'.repeat(n) is n bytes in utf8, so budgets below are in characters.
const body = (n, ch = 'a') => ch.repeat(n);

test('stores and returns values like a Map', () => {
  const c = new LruCache({ maxBytes: 1000 });
  c.set('a', body(10));
  assert.equal(c.has('a'), true);
  assert.equal(c.get('a'), body(10));
  assert.equal(c.size, 1);
  assert.equal(c.bytes, 10);
});

test('evicts the least recently used entry when over budget', () => {
  const c = new LruCache({ maxBytes: 30 });
  c.set('a', body(10));
  c.set('b', body(10));
  c.set('c', body(10));
  c.set('d', body(10)); // pushes to 40 bytes, 'a' must go
  assert.equal(c.has('a'), false);
  assert.equal(c.has('d'), true);
  assert.ok(c.bytes <= 30);
});

test('reading an entry makes it most recently used', () => {
  const c = new LruCache({ maxBytes: 30 });
  c.set('a', body(10));
  c.set('b', body(10));
  c.set('c', body(10));
  c.get('a'); // 'b' is now the oldest
  c.set('d', body(10));
  assert.equal(c.has('a'), true);
  assert.equal(c.has('b'), false);
});

test('re-setting a key does not double-count its bytes', () => {
  const c = new LruCache({ maxBytes: 1000 });
  c.set('a', body(10));
  c.set('a', body(20));
  assert.equal(c.bytes, 20);
  assert.equal(c.size, 1);
});

test('delete and clear keep the byte count honest', () => {
  const c = new LruCache({ maxBytes: 1000 });
  c.set('a', body(10));
  c.set('b', body(10));
  assert.equal(c.delete('a'), true);
  assert.equal(c.delete('a'), false);
  assert.equal(c.bytes, 10);
  c.clear();
  assert.equal(c.bytes, 0);
  assert.equal(c.size, 0);
});

test('a value bigger than the whole budget is not cached', () => {
  const c = new LruCache({ maxBytes: 50 });
  c.set('a', body(10));
  c.set('huge', body(100));
  assert.equal(c.has('huge'), false);
  assert.equal(c.has('a'), true); // and it did not evict everything else
});

test('multi-byte characters are counted in bytes, not characters', () => {
  const c = new LruCache({ maxBytes: 1000 });
  c.set('a', '€€€'); // 3 chars, 9 bytes
  assert.equal(c.bytes, 9);
});

test('keys() reflects eviction order', () => {
  const c = new LruCache({ maxBytes: 20 });
  c.set('a', body(10));
  c.set('b', body(10));
  assert.deepEqual([...c.keys()], ['a', 'b']);
  c.get('a');
  assert.deepEqual([...c.keys()], ['b', 'a']);
});
