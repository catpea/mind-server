/**
 * erica.js — Erica, the implementer.
 *
 * Role: Reads todo posts and writes actual code.
 *
 * What she does each cycle:
 *   1. Checks DMs for dispatch from Vera or Monica
 *   2. Reads r/todo for posts in 'open' or 'planned' status
 *   3. Picks the highest-priority item
 *   4. Reads relevant source files from the target project
 *   5. Asks Claude for a concrete implementation
 *   6. Writes the files to disk
 *   7. Posts the diff as a comment
 *   8. Advances status to 'review'
 *   9. DMs Rita
 *
 * When AI not available:
 *   Comments on the todo with a note: "needs AI to implement — ANTHROPIC_API_KEY not set"
 */

import { BaseAgent }                    from './base.js';
import { readFile, writeFile }          from 'node:fs/promises';
import { existsSync }                   from 'node:fs';
import { join, extname }                from 'node:path';
import { homedir }                      from 'node:os';
import * as git                         from '../git.js';
import { SUBS, STATUS, META }           from '../board-schema.js';
import { PERSONAS }                     from './personas.js';
import { Knowledge }                    from '../knowledge.js';

// File extensions Erica will read (avoid binaries)
const READABLE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.json', '.md', '.css', '.html', '.sh', '.py',
  '.yaml', '.yml', '.toml', '.env.example',
]);

export class Erica extends BaseAgent {
  static priority = 4;
  name        = 'erica';
  description = 'Implementer. Reads todo posts and writes actual code.';
  avatar      = '👩‍💻';
  role        = 'implementer';
  readonly    = false;

  #kb = new Knowledge(homedir());

  async think(ctx) {
    const { board, targetDir } = ctx;

    // Check DMs first
    const dms = await board.getDMs({ to: this.name, unreadOnly: true });
    for (const dm of dms) await board.markDMRead(dm.id);

    // Find workable todos — respect gate: with gate, only 'approved'; without, 'open'+'planned'
    const gated  = ctx.gated ?? true;
    const picks  = gated ? [STATUS.APPROVED] : [STATUS.OPEN, STATUS.PLANNED];
    const workable = (await Promise.all(
      picks.map(s => board.getPosts(SUBS.TODO, { status: s }).catch(() => []))
    )).flat().sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    // Read git diff so Erica can make targeted edits rather than full rewrites.
    // null = git unavailable; '' = clean; string = actual diff
    const currentDiff = await git.diff(targetDir);
    if (currentDiff === null) {
      this.log('git unavailable — proceeding without diff context', ctx);
    }

    return { workable, dms, currentDiff };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { workable, dms, currentDiff } = plan;
    const actions              = [];

    if (!workable.length) {
      this.log('no todos to implement — idle', ctx);
      return { outcome: 'idle', actions };
    }

    // Work one item per cycle (quality over quantity)
    const todo = workable[0];

    // Check if I'm still waiting for Rita's pre-implementation feedback on this todo
    const pendingFeedback = await this.pendingQuestion(board, `Pre-impl check: ${todo.title}`);
    if (pendingFeedback) {
      this.log(`waiting for Rita's feedback on "${todo.title}" — skipping this cycle`, ctx);
      return { outcome: 'waiting-for-peer', waitingFor: 'rita', actions };
    }

    // Check if Rita replied since last cycle — incorporate feedback
    const replies = await this.getConversationReplies(board);
    const ritaFeedback = replies.find(r => r.from === 'rita');
    if (ritaFeedback) {
      await board.markDMRead(ritaFeedback.id);
      this.log(`incorporating Rita's feedback: ${ritaFeedback.body.slice(0, 80)}`, ctx);
      actions.push({ type: 'feedback-received', from: 'rita', body: ritaFeedback.body });
    }

    this.log(`implementing: "${todo.title}"`, ctx);

    // Write starting note to scratchpad so Vera and peers can see what we're doing
    await this.writeScratchpad('erica', `Implementing: "${todo.title}" (todoId: ${todo.id})\nStarted: ${new Date().toISOString()}`);

    // Mark as in-progress
    await board.advanceStatus(todo.id, STATUS.IN_PROGRESS, {
      author:  this.name,
      comment: 'Starting implementation.',
    });

    if (plan.currentDiff === null) {
      await board.addComment(todo.id, {
        author: this.name,
        body:   '⚠ Note: git is unavailable in this directory. Implementation will proceed without diff context — Erica may rewrite files rather than making targeted edits.',
      });
    }

    if (!ctx.ai.isAvailable()) {
      await board.addComment(todo.id, {
        author: this.name,
        body:   '⚠ Cannot implement: `ANTHROPIC_API_KEY` is not set. Set it and re-run.',
      });
      await board.advanceStatus(todo.id, STATUS.OPEN); // revert
      return { outcome: 'blocked', reason: 'no-ai', actions };
    }

    // Read relevant files (uses search + dep graph to discover related files)
    this.logProgress('reading relevant files', ctx);
    const files = await this.#readRelevantFiles(todo, ctx);
    this.logProgress(`found ${Object.keys(files).length} file(s) — calling AI`, ctx);

    // Consult dependency graph — warn if a file we'll touch has many dependents
    try {
      const graph = await ctx.tools.buildGraph();
      const depWarnings = [];
      for (const f of Object.keys(files)) {
        const users = ctx.tools.findDependents(f, graph);
        if (users.length >= 3) {
          depWarnings.push(`\`${f}\` is imported by ${users.length} files (${users.slice(0, 3).join(', ')}…) — be careful with interface changes`);
        }
      }
      if (depWarnings.length) {
        this.log(`dep graph warning: ${depWarnings[0]}`, ctx);
        await board.addComment(todo.id, {
          author: this.name,
          body:   `⚠ Dependency note before implementation:\n${depWarnings.map(w => `- ${w}`).join('\n')}`,
        });
      }
    } catch { /* dep graph is advisory — never block */ }

    // For complex todos (body > 500 chars or L complexity), ask Rita for a pre-impl check
    // before spending tokens on a full implementation
    const isComplex = (todo.body?.length ?? 0) > 500 || /complexity.*L|L.*complexity/i.test(todo.body ?? '');
    if (isComplex && ctx.ai.isAvailable() && !ritaFeedback) {
      const fileList = Object.keys(files).join(', ') || 'none found';
      await this.consultPeer(board, {
        to:      'rita',
        subject: `Pre-impl check: ${todo.title}`,
        body:    `I'm about to implement this todo. Before I write code, does the approach look right to you?\n\n**Todo:** ${todo.title}\n\n**Plan:**\n${todo.body?.slice(0, 800) ?? '(no plan body)'}\n\n**Files I found:** ${fileList}\n\nAny concerns I should address first?`,
      });
      await board.advanceStatus(todo.id, STATUS.APPROVED); // revert to approved so it's re-picked next cycle
      this.log(`asked Rita for pre-impl feedback on "${todo.title}" — deferring`, ctx);
      actions.push({ type: 'consulted-peer', peer: 'rita', todoId: todo.id });
      return { outcome: 'consulting-peer', actions };
    }

    // Ask Claude for implementation (pass git diff + Rita's feedback if any)
    const feedbackNote = ritaFeedback
      ? `\n\n## Reviewer Feedback (from Rita)\n${ritaFeedback.body}`
      : '';
    const implementation = await this.#implement(todo, files, currentDiff, ctx, feedbackNote);
    if (!implementation) {
      await board.addComment(todo.id, { author: this.name, body: '⚠ AI returned no implementation.' });
      await board.advanceStatus(todo.id, STATUS.OPEN);
      return { outcome: 'failed', reason: 'no-ai-response', actions };
    }

    // Write files
    const written = [];
    for (const [filepath, content] of Object.entries(implementation.files ?? {})) {
      const abs = join(targetDir, filepath);
      await writeFile(abs, content, 'utf8');
      written.push(filepath);
      this.log(`wrote ${filepath}`, ctx);
      this.logProgress(`wrote ${filepath}`, ctx);
    }

    // Lint check: run `node --check` on each JS file before committing
    const lintFailures = [];
    for (const filepath of written.filter(f => /\.(js|mjs|cjs)$/.test(f))) {
      const result = await ctx.tools.shell(`node --check ${JSON.stringify(filepath)}`);
      if (!result.ok) {
        lintFailures.push({ file: filepath, error: result.stderr.slice(0, 500) });
        this.log(`lint failed: ${filepath}`, ctx);
      }
    }

    if (lintFailures.length === 0 && written.length > 0) {
      this.logProgress('lint OK — committing', ctx);
    }

    if (lintFailures.length > 0) {
      const detail = lintFailures.map(f => `- \`${f.file}\`:\n  ${f.error}`).join('\n');
      await board.addComment(todo.id, {
        author: this.name,
        body:   `⚠ Lint errors detected — reverting to planned:\n\n${detail}`,
      });
      await board.advanceStatus(todo.id, STATUS.PLANNED, {
        author: this.name, comment: 'Lint check failed — needs revision.',
      });
      return { outcome: 'lint-failed', lintFailures, actions };
    }

    // Commit to git if in a repo
    const sha = await git.commit(
      targetDir,
      `fix: ${todo.title.slice(0, 72)} [board:${todo.id.slice(0, 8)}]`,
    );
    if (sha) {
      this.log(`committed ${sha}`, ctx);
      this.logProgress(`committed ${sha}`, ctx);
    }

    // Post implementation as comment (as a diff-style summary)
    const diffSummary = this.#formatImplementation(implementation, written, sha);
    await board.addComment(todo.id, {
      author: this.name,
      body:   diffSummary,
      meta:   { [META.FILES_WRITTEN]: written, [META.COMMIT_SHA]: sha },
    });

    // Advance to review + DM Rita
    await board.advanceStatus(todo.id, STATUS.REVIEW, {
      author:  this.name,
      comment: `Implementation complete. ${written.length} file(s) changed: ${written.join(', ')}${sha ? ` (${sha})` : ''}`,
    });

    await board.sendDM({
      from:    this.name,
      to:      'rita',
      subject: `Ready for review: ${todo.title}`,
      body:    `Todo ${todo.id} is ready for review. Files changed: ${written.join(', ')}`,
      meta:    { [META.TODO_ID]: todo.id },
    });

    // Update scratchpad with completion note
    await this.writeScratchpad('erica', `Completed: "${todo.title}" (todoId: ${todo.id})\nFiles: ${written.join(', ')}\nCommit: ${sha ?? 'none'}\nDone: ${new Date().toISOString()}`);

    // Write pattern to knowledge base (AI generates a brief description)
    if (ctx.ai.isAvailable()) {
      try {
        const patternDesc = await ctx.ai.fast.ask(
          `In 2-3 sentences, describe the pattern used to solve this task. What problem was solved, how was it solved, and which key files were involved?\n\nTask: ${todo.title}\nFiles: ${written.join(', ')}\nSummary: ${implementation.summary ?? ''}`,
          { system: 'You extract reusable patterns from implementation work. Be concise and specific.' }
        );
        await this.#kb.write({
          projectDir: ctx.targetDir,
          agentName:  this.name,
          type:       'pattern',
          title:      todo.title,
          body:       patternDesc ?? implementation.summary ?? '',
          tags:       ['implementation'],
        });
      } catch { /* knowledge write is advisory — never block */ }
    }

    actions.push({ type: 'implemented', todoId: todo.id, filesWritten: written });
    return { outcome: 'implemented', todoId: todo.id, filesWritten: written, actions };
  }

  async #readRelevantFiles(todo, ctx) {
    const { targetDir, tools } = ctx;
    const files = {};

    // Extract file hints from the todo body
    const body        = todo.body ?? '';
    const fileHints   = [];
    const filePattern = /(?:^|\s)([\w./\\-]+\.[a-z]{1,5})/gm;
    let m;
    while ((m = filePattern.exec(body)) !== null) {
      fileHints.push(m[1].trim());
    }

    // Try to read hinted files first
    for (const hint of fileHints) {
      const abs = join(targetDir, hint);
      if (existsSync(abs) && READABLE_EXTS.has(extname(hint))) {
        try {
          files[hint] = await readFile(abs, 'utf8');
        } catch { /* skip */ }
      }
    }

    // Use search to discover files related to symbols mentioned in the plan
    // Extract identifiers: camelCase, PascalCase, snake_case words (3+ chars)
    const symbols = [...new Set((body.match(/\b[A-Z][a-zA-Z]{2,}|\b[a-z]{3,}[A-Z][a-zA-Z]*/g) ?? []))].slice(0, 5);
    for (const sym of symbols) {
      if (Object.keys(files).length >= 8) break;
      const refs = await tools.findRefs(sym);
      for (const ref of refs.slice(0, 3)) {
        const abs = join(targetDir, ref.file);
        if (files[ref.file] || !READABLE_EXTS.has(extname(ref.file))) continue;
        try { files[ref.file] = await readFile(abs, 'utf8'); } catch { /* skip */ }
        if (Object.keys(files).length >= 8) break;
      }
    }

    // Also include package.json if present (project context)
    const pkgPath = join(targetDir, 'package.json');
    if (existsSync(pkgPath) && !files['package.json']) {
      try { files['package.json'] = await readFile(pkgPath, 'utf8'); } catch { /* skip */ }
    }

    // Query knowledge base for relevant past patterns
    try {
      const query   = `${todo.title} ${(todo.body ?? '').slice(0, 200)}`;
      const results = await this.#kb.search(query);
      if (results.length) {
        files['[knowledge]'] = results
          .map(r => `${r.title}: ${r.body}`)
          .join('\n\n')
          .slice(0, 2000);
      }
    } catch { /* knowledge search is advisory — never block */ }

    return files;
  }

  async #implement(todo, files, currentDiff, ctx, feedbackNote = '') {
    const fileContext = Object.entries(files)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``)
      .join('\n\n');

    const diffSection = currentDiff  // null = unavailable, '' = clean — both falsy, skip
      ? `\n## Uncommitted Changes (git diff)\n\`\`\`diff\n${currentDiff.slice(0, 2000)}\n\`\`\``
      : '';

    const contextSection = ctx.projectContext
      ? `\n## Project Context\n${ctx.projectContext}\n`
      : '';

    const prompt = `You are Erica, a software engineer. Implement the following task.
${contextSection}
## Task
${todo.title}

## Plan
${todo.body ?? '(no plan body)'}

## Existing Files
${fileContext || '(no relevant files found)'}${diffSection}${feedbackNote}

## Instructions
- Write production-quality code.
- Only modify or create the files necessary.
- Do not add unnecessary comments or console.logs.
- Respond with JSON in this exact shape:
  {
    "summary": "One sentence describing what you did.",
    "files": {
      "path/to/file.js": "<full file content>",
      ...
    },
    "notes": "Any caveats or follow-up items."
  }`;

    return ctx.ai.full.askJSON(prompt, {
      system:    PERSONAS.erica,
      maxTokens: 8192,
    });
  }

  #formatImplementation(impl, written, sha) {
    const lines = [
      `## Implementation`,
      '',
      impl.summary ?? '',
      '',
    ];

    if (written.length) {
      lines.push('**Files changed:**');
      for (const f of written) lines.push(`- \`${f}\``);
      if (sha) lines.push(`\n**Commit:** \`${sha}\``);
      lines.push('');
    }

    if (impl.notes) {
      lines.push('**Notes:**');
      lines.push(impl.notes);
    }

    return lines.join('\n');
  }
}
