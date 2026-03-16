/**
 * template.js — Default project template.
 *
 * When mind-server starts against a fresh project (empty board),
 * it creates a welcome post and the standard subreddits so agents
 * know where to look.
 *
 * Standard subreddit layout:
 *   r/general     — general discussion, announcements
 *   r/requests    — user feature requests and bug reports (agent: Monica reads this)
 *   r/todo        — structured tasks (agent: Erica implements, Rita reviews)
 *   r/quality     — code quality findings (agent: Sandra posts here)
 *   r/dispatch    — agent dispatch log (agent: Vera posts here)
 *
 * Called once by server.js on startup if the board is empty.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';

export async function initBoard(board, targetDir) {
  // Only initialise if board is truly empty
  const subs = await board.listSubs();
  if (subs.length > 0) return;

  // Detect project name
  let projectName = basename(targetDir);
  let projectDesc = '';
  const pkgPath = join(targetDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (pkg.name) projectName = pkg.name;
      if (pkg.description) projectDesc = pkg.description;
    } catch { /* skip */ }
  }

  // Create standard subreddits
  await board.ensureSub('general');
  await board.ensureSub('requests');
  await board.ensureSub('todo');
  await board.ensureSub('quality');
  await board.ensureSub('dispatch');

  // Welcome post
  await board.createPost('general', {
    title:  `Welcome to ${projectName}`,
    author: 'mind-server',
    type:   'announcement',
    body:   [
      projectDesc ? `> ${projectDesc}\n` : '',
      `# Welcome to the ${projectName} development board`,
      '',
      'This board coordinates your software development team — human and AI alike.',
      '',
      '## How to get started',
      '',
      '1. **Make a request** — post what you want built in `r/requests`:',
      '   ```',
      `   POST /r/requests  { "title": "Add a feature that...", "author": "you" }`,
      '   ```',
      '',
      '2. **Monica** reads your request and creates a structured plan in `r/todo`.',
      '3. **Erica** picks up the plan, writes the code, and moves it to review.',
      '4. **Rita** reviews the code and approves or requests changes.',
      '5. **Sandra** scans for quality issues and posts findings to `r/quality`.',
      '6. **Vera** orchestrates the whole team — run her first if you want to kick things off.',
      '',
      '## Subreddits',
      '| Sub | Purpose |',
      '|-----|---------|',
      '| `r/requests` | Post what you want built here |',
      '| `r/todo`     | Structured tasks — Monica creates, Erica implements |',
      '| `r/quality`  | Code quality findings from Sandra |',
      '| `r/dispatch` | Agent activity log — who is doing what |',
      '| `r/general`  | Announcements and general discussion |',
      '',
      '## Running agents',
      '',
      'Trigger an agent cycle:',
      '```bash',
      'curl -X POST http://localhost:3002/agents/vera/run',
      '```',
      '',
      'Or use the interactive CLI:',
      '```bash',
      'mind-server-agent vera',
      '```',
      '',
      '## API',
      '- Full spec: `GET /openapi.json`',
      '- Real-time events: `GET /events` (SSE)',
      '- Board summary: `GET /summary`',
    ].join('\n'),
  });
}
