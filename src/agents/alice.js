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
import { readFile, writeFile }          from 'node:fs/promises';
import { existsSync }                   from 'node:fs';
import { join, basename }               from 'node:path';
import { SUBS, STATUS, META, SEVERITY } from '../board-schema.js';

export class Alice extends BaseAgent {
  static priority = 8;
  name        = 'alice';
  description = 'Friendly tester. Writes test suites for implemented code, runs them, and reports results.';
  avatar      = '🧪';
  role        = 'tester';
  readonly    = false;

  async think(ctx) {
    const { board } = ctx;

    // Find recently implemented todos (status = done or review, has Erica comment)
    const todos = await board.getAllPosts({ type: 'todo' }).catch(() => []);
    const needsTests = todos.filter(p =>
      [STATUS.REVIEW, STATUS.DONE].includes(p.status) &&
      !p.meta?.[META.ALICE_TESTED]
    );

    // Coverage map — prioritise genuinely untested files (not random picks)
    const coverage = await ctx.tools.buildCoverageMap().catch(() => null);
    const untested = coverage
      ? coverage.uncovered.slice(0, 10)
      : await this.#findUntestedFiles(ctx);

    // Recent test failures from board
    const testPosts = await board.getPosts(SUBS.TESTS, { status: STATUS.OPEN }).catch(() => []);

    return { needsTests, untested, testPosts, coverage };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { needsTests, untested } = plan;
    const actions = [];

    await board.ensureSub(SUBS.TESTS);

    // Write missing tests with AI — one todo at a time
    if (ctx.ai.isAvailable() && needsTests.length > 0) {
      const todo = needsTests[0];
      const filesWritten = todo.meta?.[META.FILES_WRITTEN] ?? [];
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
      await board.updatePost(todo.id, { meta: { ...todo.meta, [META.ALICE_TESTED]: true } });
    }

    // Run all tests — if failures, send the todo back to Erica
    const testResult = await this.#runTests(ctx);
    if (testResult) {
      this.log(`tests: ${testResult.passed} passed, ${testResult.failed} failed`, ctx);
      if (testResult.failed > 0) {
        // Find the most recently reviewed todo to bounce back
        const inReview = (await board.getPosts(SUBS.TODO, { status: STATUS.REVIEW }).catch(() => []))
          .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

        if (inReview.length > 0) {
          const todo = inReview[0];
          await board.addComment(todo.id, {
            author: this.name,
            body:   `🧪 Alice ran tests — **${testResult.failed} failure(s)**. Bouncing back to Erica.\n\n\`\`\`\n${testResult.output.slice(0, 2000)}\n\`\`\``,
          });
          await board.advanceStatus(todo.id, STATUS.IN_PROGRESS, {
            author: this.name, comment: 'Tests failed — returning to Erica for fixes.',
          });
          actions.push({ type: 'bounced-to-erica', todoId: todo.id, failed: testResult.failed });
        } else {
          // No linked todo — post to tests sub
          if (!await this.findDuplicate(board, SUBS.TESTS, `Test failures`)) {
            await board.ensureSub(SUBS.TESTS);
            await board.createPost(SUBS.TESTS, {
              title:  `Test failures: ${testResult.failed} failing`,
              body:   testResult.output.slice(0, 2000),
              author: this.name,
              type:   'quality',
              meta:   { [META.SEVERITY]: SEVERITY.ERROR, passed: testResult.passed, failed: testResult.failed },
            });
          }
          actions.push({ type: 'test-failure-posted', failed: testResult.failed });
        }
      }
    }

    // Flag untested files (no AI needed)
    if (untested.length > 0) {
      for (const f of untested.slice(0, 3)) {
        const title = `No tests for ${f}`;
        if (!await this.findDuplicate(board, SUBS.QUALITY, title)) {
          await board.createPost(SUBS.QUALITY, {
            title,
            body:   `\`${f}\` has no corresponding test file. Add tests to verify correctness.`,
            author: this.name,
            type:   'quality',
            meta:   { [META.SEVERITY]: SEVERITY.WARNING, file: f },
          });
          actions.push({ type: 'untested-flagged', file: f });
        }
      }
    }

    if (!actions.length) {
      this.log('all tests passing, coverage looks good — idle', ctx);
      return { outcome: 'idle', actions };
    }

    return { outcome: 'tested', count: actions.length, actions };
  }

  async #runTests(ctx) {
    const { targetDir, tools } = ctx;
    const pkgPath = join(targetDir, 'package.json');
    if (!existsSync(pkgPath)) return null;
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (!pkg.scripts?.test || pkg.scripts.test.includes('no test')) return null;
    } catch { return null; }

    const result = await tools.shell('npm test', { timeout: 60_000 });
    const output = `${result.stdout}\n${result.stderr}`.trim().slice(0, 4000);
    const passed = (output.match(/✔|pass/gi) ?? []).length;
    const failed = (output.match(/✗|fail|error/gi) ?? []).length;
    return { passed, failed, output, ok: result.ok };
  }

  async #findUntestedFiles(ctx) {
    const { targetDir, tools } = ctx;

    // Use search tool to find all source files
    const sourceFiles = await tools.findFiles('**/*.{js,mjs,ts}');
    const testPattern = /test|spec/i;
    const untested    = [];

    for (const f of sourceFiles) {
      if (testPattern.test(f)) continue;
      // Look for a test companion
      const testName = f.replace(/\.(js|mjs|ts)$/, '.test.$1');
      const hasTest  = existsSync(join(targetDir, testName)) ||
                       existsSync(join(targetDir, 'test', basename(testName))) ||
                       existsSync(join(targetDir, 'tests', basename(testName)));
      if (!hasTest) untested.push(f);
    }

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
