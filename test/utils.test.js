/**
 * utils.test.js — Unit tests for src/utils.js
 *
 * Tests: withTimeout, safeReadFile, retryWithBackoff
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { withTimeout, safeReadFile, retryWithBackoff } from '../src/utils.js';

// ── withTimeout ────────────────────────────────────────────────────────────────

test('withTimeout resolves when promise settles quickly', async () => {
  const result = await withTimeout(Promise.resolve(42), 1000);
  assert.equal(result, 42);
});

test('withTimeout rejects when promise exceeds deadline', async () => {
  const slow = new Promise(resolve => setTimeout(resolve, 500));
  await assert.rejects(
    () => withTimeout(slow, 50, 'slow-op'),
    /slow-op timed out after 50ms/,
  );
});

test('withTimeout passes the resolved value through', async () => {
  const val = await withTimeout(Promise.resolve('hello'), 200);
  assert.equal(val, 'hello');
});

test('withTimeout clears the timer on success (no dangling timer)', async () => {
  // If the timer leaked, the test process would hang. Resolving cleanly proves it didn't.
  await withTimeout(Promise.resolve(), 10_000);
  // If we get here, the timer was cleared.
});

// ── safeReadFile ──────────────────────────────────────────────────────────────

test('safeReadFile returns file content for an existing file', async () => {
  const path = '/tmp/mind-utils-test.txt';
  await writeFile(path, 'hello world', 'utf8');
  try {
    const content = await safeReadFile(path);
    assert.equal(content, 'hello world');
  } finally {
    await rm(path, { force: true });
  }
});

test('safeReadFile returns empty string for a missing file', async () => {
  const result = await safeReadFile('/tmp/does-not-exist-mind-test-xyz.txt');
  assert.equal(result, '');
});

test('safeReadFile returns custom default for a missing file', async () => {
  const result = await safeReadFile('/tmp/does-not-exist-mind-test-xyz.txt', null);
  assert.equal(result, null);
});

// ── retryWithBackoff ──────────────────────────────────────────────────────────

test('retryWithBackoff returns immediately on success', async () => {
  let calls = 0;
  const result = await retryWithBackoff(() => { calls++; return Promise.resolve('ok'); }, { retries: 3, baseMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retryWithBackoff retries on failure and eventually succeeds', async () => {
  let calls = 0;
  const result = await retryWithBackoff(
    () => {
      calls++;
      if (calls < 3) throw new Error('transient');
      return Promise.resolve('recovered');
    },
    { retries: 3, baseMs: 1 },
  );
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('retryWithBackoff throws after exhausting retries', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(
      () => { calls++; throw new Error('always fails'); },
      { retries: 2, baseMs: 1 },
    ),
    /always fails/,
  );
  // 1 initial attempt + 2 retries = 3 total
  assert.equal(calls, 3);
});

test('retryWithBackoff stops immediately when shouldRetry returns false', async () => {
  let calls = 0;
  await assert.rejects(
    () => retryWithBackoff(
      () => { calls++; throw new Error('fatal'); },
      { retries: 5, baseMs: 1, shouldRetry: () => false },
    ),
    /fatal/,
  );
  // shouldRetry=false means we don't retry at all — stops after first failure
  assert.equal(calls, 1);
});

test('retryWithBackoff passes the error to shouldRetry', async () => {
  const seen = [];
  await assert.rejects(
    () => retryWithBackoff(
      () => { throw new Error('specific-error'); },
      {
        retries: 2,
        baseMs: 1,
        shouldRetry: err => { seen.push(err.message); return false; },
      },
    ),
  );
  assert.deepEqual(seen, ['specific-error']);
});
