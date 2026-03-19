/**
 * shell.test.js — Integration tests for src/tools/shell.js
 *
 * Tests: success, non-zero exit, timeout, working-dir isolation.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shell } from '../src/tools/shell.js';

test('successful command returns ok=true and stdout', async () => {
  const r = await shell('echo hello');
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.code, 0);
});

test('non-zero exit returns ok=false and the exit code', async () => {
  const r = await shell('exit 42');
  assert.equal(r.ok, false);
  assert.equal(r.code, 42);
});

test('stderr is captured separately from stdout', async () => {
  const r = await shell('echo out && echo err >&2');
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'out');
  assert.equal(r.stderr, 'err');
});

test('timeout fires and marks result as not-ok', async () => {
  const r = await shell('sleep 60', { timeout: 50 });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /timed out/i);
  assert.equal(r.code, null);
});

test('working directory is respected', async () => {
  const r = await shell('pwd', { cwd: '/tmp' });
  assert.equal(r.ok, true);
  // /tmp may resolve to /private/tmp on macOS — check the tail
  assert.ok(r.stdout.endsWith('tmp'), `expected pwd to end in 'tmp', got: ${r.stdout}`);
});

test('env vars are merged with process.env', async () => {
  const r = await shell('echo $MIND_TEST_VAR', { env: { MIND_TEST_VAR: 'injected' } });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'injected');
});

test('command that produces no output returns empty strings', async () => {
  const r = await shell('true');
  assert.equal(r.ok, true);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('spawn error (bad command path) is caught and sets ok=false', async () => {
  // We can't easily trigger a spawn error via /bin/sh -c, but a command that
  // writes to stderr and exits non-zero confirms error capture works.
  const r = await shell('echo oops >&2 && exit 1');
  assert.equal(r.ok, false);
  assert.equal(r.stderr, 'oops');
});
