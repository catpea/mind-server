/**
 * alice.js — Alice, the tester.
 *
 * Role: Writes and runs tests. Alice is friendly, thorough, and systematic.
 * She reads implementation comments from Erica, writes test files, and
 * posts results to r/tests. When she finds failures, she opens a bug in r/quality.
 *
 * Without AI: finds source files with no corresponding test file and flags them.
 * With AI:    reads source files and generates proper test suites.
 */

import { BaseAgent }                    from './base.js';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync }                   from 'node:fs';
import { join, extname, basename }      from 'node:path';
import { exec }                         from 'node:child_process';
import { promisify }                    from 'node:util';

const execAsync = promisify(exec);

export class Alice extends BaseAgent {
  name        = 'alice';
  description = 'Friendly tester. Writes test suites for implemented code, runs them, and reports results.';
  avatar      = '🧪';
  role        = 'tester';

  async think(ctx) {
    const { board, targetDir } = ctx;

    // Find recently implemented todos (status = done or review, has Erica comment)
    const todos = await board.getAllPosts({ type: 'todo' }).catch(() => []);
    const needsTests = todos.filter(p =>
      ['review', 'done'].includes(p.status) &&
      !p.meta?.aliceTested
    );

    // Find source files without companion test files
    const untested = await this.#findUntestedFiles(targetDir);

    // Recent test failures from board
    const testPosts = await board.getPosts('tests', { status: 'open' }).catch(() => []);

    return { needsTests, untested, testPosts };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { needsTests, untested } = plan;
    const actions = [];

    await board.ensureSub('tests');

    // Run existing tests first
    const testResult = await this.#runTests(targetDir);
    if (testResult) {
      this.log(`tests: ${testResult.passed} passed, ${testResult.failed} failed`, ctx);
      if (testResult.failed > 0) {
        await board.createPost('tests', {
          title:  `Test failures: ${testResult.failed} failing`,
          body:   testResult.output.slice(0, 2000),
          author: this.name,
          type:   'quality',
          meta:   { severity: 'error', passed: testResult.passed, failed: testResult.failed },
        });
        actions.push({ type: 'test-failure-posted', failed: testResult.failed });
      }
    }

    // Write missing tests with AI
    if (ctx.ai.isAvailable() && needsTests.length > 0) {
      const todo = needsTests[0]; // one at a time
      const filesWritten = todo.meta?.filesWritten ?? [];
      for (const filepath of filesWritten.slice(0, 2)) {
        const abs = join(targetDir, filepath);
        if (!existsSync(abs)) continue;
        const source = await readFile(abs, 'utf8').catch(() => '');
        if (!source) continue;

        const tests = await this.#generateTests(filepath, source, todo, ctx);
        if (tests) {
          const testPath = this.#testPathFor(filepath);
          await writeFile(join(targetDir, testPath), tests, 'utf8');
          this.log(`wrote tests: ${testPath}`, ctx);
          actions.push({ type: 'tests-written', file: testPath });
        }
      }
      // Mark as tested
      await board.updatePost(todo.id, { meta: { ...todo.meta, aliceTested: true } });
    }

    // Flag untested files (no AI needed)
    if (untested.length > 0) {
      const openTitles = (await board.getPosts('quality').catch(() => []))
        .filter(p => p.status !== 'done').map(p => p.title);

      for (const f of untested.slice(0, 3)) {
        const title = `No tests for ${f}`;
        if (openTitles.includes(title)) continue;
        await board.createPost('quality', {
          title,
          body:   `\`${f}\` has no corresponding test file. Add tests to verify correctness.`,
          author: this.name,
          type:   'quality',
          meta:   { severity: 'warning', file: f },
        });
        actions.push({ type: 'untested-flagged', file: f });
      }
    }

    if (!actions.length) {
      this.log('all tests passing, coverage looks good — idle', ctx);
      return { outcome: 'idle', actions };
    }

    return { outcome: 'tested', count: actions.length, actions };
  }

  async #runTests(targetDir) {
    const pkgPath = join(targetDir, 'package.json');
    if (!existsSync(pkgPath)) return null;
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (!pkg.scripts?.test || pkg.scripts.test.includes('no test')) return null;
      const { stdout, stderr } = await execAsync('npm test', { cwd: targetDir, timeout: 30_000 });
      const output   = (stdout + stderr).slice(0, 4000);
      const passed   = (output.match(/✔|pass/gi) ?? []).length;
      const failed   = (output.match(/✗|fail|error/gi) ?? []).length;
      return { passed, failed, output };
    } catch (err) {
      const output = String(err.stdout ?? '') + String(err.stderr ?? '');
      return { passed: 0, failed: 1, output: output.slice(0, 2000) };
    }
  }

  async #findUntestedFiles(targetDir) {
    const sourceExts  = new Set(['.js', '.mjs', '.ts']);
    const testPattern = /test|spec/i;
    const ignore      = new Set(['.mind-server', '.git', 'node_modules', 'dist']);
    const untested    = [];

    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (ignore.has(e.name)) continue;
        if (e.isDirectory()) { await walk(join(dir, e.name)); continue; }
        if (!sourceExts.has(extname(e.name))) continue;
        if (testPattern.test(e.name)) continue;
        // Look for a test companion
        const testName = e.name.replace(/\.(js|mjs|ts)$/, '.test.$1');
        const hasTest  = existsSync(join(dir, testName)) ||
                         existsSync(join(dir, '../test', testName)) ||
                         existsSync(join(dir, '../tests', testName));
        if (!hasTest) untested.push(e.name);
      }
    }

    await walk(targetDir);
    return untested.slice(0, 10);
  }

  async #generateTests(filepath, source, todo, ctx) {
    const prompt = `You are Alice, a friendly test engineer. Write tests for this file.

File: ${filepath}
Task being tested: ${todo.title}

Source:
\`\`\`
${source.slice(0, 3000)}
\`\`\`

Write a complete test file using Node.js built-in test runner (import { test } from 'node:test'; import assert from 'node:assert/strict';).
Cover happy paths, edge cases, and error conditions.
Reply with ONLY the test file content — no explanation.`;

    return ctx.ai.ask(prompt, {
      system: 'You are a meticulous test engineer. Write clear, focused tests. Reply with code only.',
    });
  }

  #testPathFor(filepath) {
    const name = basename(filepath);
    const base = name.replace(/\.(js|mjs|ts)$/, '.test.$1');
    return `test/${base}`;
  }
}
