/**
 * tools/sandbox.js — Isolated code execution with resource limits.
 *
 * Runs a shell command in an isolated subprocess with strict limits:
 *   - CPU time:  timeout parameter (default 10s)
 *   - Memory:    memoryMb parameter via ulimit -v (default 128 MB)
 *   - Network:   no special isolation (use with care)
 *   - Filesystem: cwd is a temp directory, cleaned up after
 *
 * Uses ulimit (bash built-in) for resource limits. Falls back gracefully
 * if ulimit is unavailable.
 *
 * Result: { ok, stdout, stderr, code }
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir }      from 'node:os';
import { join }        from 'node:path';
import { shell }       from './shell.js';

export async function sandbox(cmd, {
  timeout   = 10_000,
  memoryMb  = 128,
  files     = {},   // { 'filename': 'content' } — written into sandbox dir before exec
} = {}) {
  // Create a temp directory for isolation
  const dir = await mkdtemp(join(tmpdir(), 'msbox-'));
  try {
    // Write any provided files into the sandbox dir
    if (Object.keys(files).length) {
      const { writeFile } = await import('node:fs/promises');
      for (const [name, content] of Object.entries(files)) {
        await writeFile(join(dir, name), content, 'utf8');
      }
    }

    // Wrap with ulimit for memory constraint
    // ulimit -v = virtual memory in KB; -t = CPU time in seconds
    const cpuSecs = Math.ceil(timeout / 1000) + 5; // add buffer for process startup
    const memKb   = memoryMb * 1024;
    const wrapped = `ulimit -v ${memKb} -t ${cpuSecs} 2>/dev/null; ${cmd}`;

    return await shell(wrapped, { cwd: dir, timeout: timeout + 2000 });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
