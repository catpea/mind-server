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
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync }                   from 'node:fs';
import { join, extname, relative }      from 'node:path';

// File extensions Erica will read (avoid binaries)
const READABLE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx',
  '.json', '.md', '.css', '.html', '.sh', '.py',
  '.yaml', '.yml', '.toml', '.env.example',
]);

export class Erica extends BaseAgent {
  name        = 'erica';
  description = 'Implementer. Reads todo posts and writes actual code.';
  avatar      = '👩‍💻';
  role        = 'implementer';

  async think(ctx) {
    const { board } = ctx;

    // Check DMs first
    const dms = await board.getDMs({ to: this.name, unreadOnly: true });
    for (const dm of dms) await board.markDMRead(dm.id);

    // Find workable todos
    const todos = await board.getPosts('todo', { status: 'open' }).catch(() => []);
    const planned = await board.getPosts('todo', { status: 'planned' }).catch(() => []);
    const workable = [...todos, ...planned].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    return { workable, dms };
  }

  async act(plan, ctx) {
    const { board, targetDir } = ctx;
    const { workable, dms }    = plan;
    const actions              = [];

    if (!workable.length) {
      this.log('no todos to implement — idle', ctx);
      return { outcome: 'idle', actions };
    }

    // Work one item per cycle (quality over quantity)
    const todo = workable[0];
    this.log(`implementing: "${todo.title}"`, ctx);

    // Mark as in-progress
    await board.advanceStatus(todo.id, 'in-progress', {
      author:  this.name,
      comment: 'Starting implementation.',
    });

    if (!ctx.ai.isAvailable()) {
      await board.addComment(todo.id, {
        author: this.name,
        body:   '⚠ Cannot implement: `ANTHROPIC_API_KEY` is not set. Set it and re-run.',
      });
      await board.advanceStatus(todo.id, 'open'); // revert
      return { outcome: 'blocked', reason: 'no-ai', actions };
    }

    // Read relevant files
    const files = await this.#readRelevantFiles(todo, targetDir);

    // Ask Claude for implementation
    const implementation = await this.#implement(todo, files, ctx);
    if (!implementation) {
      await board.addComment(todo.id, { author: this.name, body: '⚠ AI returned no implementation.' });
      await board.advanceStatus(todo.id, 'open');
      return { outcome: 'failed', reason: 'no-ai-response', actions };
    }

    // Write files
    const written = [];
    for (const [filepath, content] of Object.entries(implementation.files ?? {})) {
      const abs = join(targetDir, filepath);
      await writeFile(abs, content, 'utf8');
      written.push(filepath);
      this.log(`wrote ${filepath}`, ctx);
    }

    // Post implementation as comment (as a diff-style summary)
    const diffSummary = this.#formatImplementation(implementation, written);
    await board.addComment(todo.id, {
      author: this.name,
      body:   diffSummary,
      meta:   { filesWritten: written },
    });

    // Advance to review + DM Rita
    await board.advanceStatus(todo.id, 'review', {
      author:  this.name,
      comment: `Implementation complete. ${written.length} file(s) changed: ${written.join(', ')}`,
    });

    await board.sendDM({
      from:    this.name,
      to:      'rita',
      subject: `Ready for review: ${todo.title}`,
      body:    `Todo ${todo.id} is ready for review. Files changed: ${written.join(', ')}`,
      meta:    { todoId: todo.id },
    });

    actions.push({ type: 'implemented', todoId: todo.id, filesWritten: written });
    return { outcome: 'implemented', todoId: todo.id, filesWritten: written, actions };
  }

  async #readRelevantFiles(todo, targetDir) {
    const files = {};

    // Extract file hints from the todo body
    const body        = todo.body ?? '';
    const fileHints   = [];
    const filePattern = /(?:^|\s)([\w./\\-]+\.[a-z]{1,5})/gm;
    let m;
    while ((m = filePattern.exec(body)) !== null) {
      fileHints.push(m[1].trim());
    }

    // Try to read hinted files
    for (const hint of fileHints) {
      const abs = join(targetDir, hint);
      if (existsSync(abs) && READABLE_EXTS.has(extname(hint))) {
        try {
          files[hint] = await readFile(abs, 'utf8');
        } catch { /* skip */ }
      }
    }

    // Also include package.json if present (project context)
    const pkgPath = join(targetDir, 'package.json');
    if (existsSync(pkgPath) && !files['package.json']) {
      try { files['package.json'] = await readFile(pkgPath, 'utf8'); } catch { /* skip */ }
    }

    return files;
  }

  async #implement(todo, files, ctx) {
    const fileContext = Object.entries(files)
      .map(([path, content]) => `### ${path}\n\`\`\`\n${content.slice(0, 3000)}\n\`\`\``)
      .join('\n\n');

    const prompt = `You are Erica, a software engineer. Implement the following task.

## Task
${todo.title}

## Plan
${todo.body ?? '(no plan body)'}

## Existing Files
${fileContext || '(no relevant files found)'}

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

    return ctx.ai.askJSON(prompt, {
      system:    'You are a senior software engineer. Write clean, idiomatic code. Reply with JSON only.',
      maxTokens: 8192,
    });
  }

  #formatImplementation(impl, written) {
    const lines = [
      `## Implementation`,
      '',
      impl.summary ?? '',
      '',
    ];

    if (written.length) {
      lines.push('**Files changed:**');
      for (const f of written) lines.push(`- \`${f}\``);
      lines.push('');
    }

    if (impl.notes) {
      lines.push('**Notes:**');
      lines.push(impl.notes);
    }

    return lines.join('\n');
  }
}
