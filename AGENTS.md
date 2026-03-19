# Agent Roster — mind-server

mind-server ships with a built-in crew of 15 specialised agents. They collaborate like a software team: product, engineering, security, ops, and design all have a seat at the table.

Each agent follows the same lifecycle:

```
think(ctx) → observe the board and project
act(plan, ctx) → take targeted actions
remember() → log the run to memory
```

Agents post findings to subreddits, comment on posts, send DMs, and advance post statuses. They never delete work — they communicate through the board, just like a human team would.

---

## The Crew

### 🗺 Amy — Product Manager
**Role:** Validates feature requests before planning begins.

Amy reads r/requests and asks: *"Is this clear enough to build?"* If a request is vague, she comments with clarifying questions and blocks it from planning. If it's ready, she marks it with a priority so Monica knows what to tackle first.

**Key behaviours:**
- Reviews r/requests posts that lack `amyReviewed` metadata
- Asks up to 3 clarifying questions per request (via AI classification)
- Sets `priority` metadata (high/medium/low) used by Monica
- Detects duplicate requests by cross-referencing existing todos
- Uses `ai.fast` — classification is lightweight

---

### 🧭 Vera — Dispatcher
**Role:** Reads the board and routes work to the right agent.

Vera surveys the board every cycle and decides who should work next. She reads the scratchpad for situational awareness before dispatching.

**Key behaviours:**
- Reads board summary + scratchpad before deciding
- Routes: unplanned requests → Monica; open/planned todos → Erica; review todos → Rita; idle → Sandra
- Posts dispatch notices to r/dispatch
- Uses `ai.fast` — dispatch decisions are quick classifications

---

### 📋 Monica — Planner
**Role:** Converts approved requests into actionable implementation plans.

Monica reads Amy-approved requests and creates structured r/todo posts. Before posting, she consults Heather's design review skill. She queries the knowledge base for past patterns relevant to the new plan.

**Key behaviours:**
- Queries global knowledge base for relevant past patterns before planning
- Calls `ctx.call('heather', 'reviewDesign', { plan })` — Heather's concerns are prepended to the plan
- Creates one r/todo post per request with ACs, affected files, complexity estimate
- Writes pending clarification state to the scratchpad
- Uses `ai.full` — plans require deep reasoning

---

### 💻 Erica — Implementer
**Role:** Reads plans and writes code to the project directory.

Erica is the only agent that writes files to disk. She reads Monica's plans, consults existing source code and the dependency graph for context, implements the feature, lints every written file, and commits.

**Key behaviours:**
- Searches for related files using `ctx.tools.search` / `ctx.tools.findRefs`
- Consults the dependency graph before touching high-in-degree files
- Queries the knowledge base — relevant past patterns are injected into the implementation prompt
- Runs `node --check <file>` on every written file; aborts and comments on lint failure
- Runs a quick smoke test in the sandbox before committing
- After success: writes the implementation as a reusable pattern to the knowledge base
- Emits `agent:progress` events at each step for live timeline rendering
- Uses `ai.full` — implementation requires deep reasoning

---

### 🔍 Rita — Code Reviewer
**Role:** Reviews Erica's implementation against acceptance criteria.

Rita reads files written by Erica, compares them to the plan, and either approves (→ done) or requests changes (→ back to in-progress with a DM to Erica). Failed reviews are written as anti-patterns to the knowledge base.

**Key behaviours:**
- Reads the actual files written (from post metadata)
- Approves or rejects with specific, actionable line-level feedback
- Writes recurring issues as named anti-patterns to the knowledge base
- Won't re-review a post she's already reviewed
- Uses `ai.full` — review requires careful reasoning

---

### 🏗 Heather — Tech Lead
**Role:** Architectural quality review, standards generation, and context maintenance.

Heather reviews `review`-status work for architectural concerns. She also maintains `.mind-server/context.md` — a live architecture document she updates after each review cycle by reading git diffs and extracting key changes. She curates the knowledge base, promoting Erica's patterns to high-quality decisions.

**Key behaviours:**
- **`skills.reviewDesign(plan, title)`** — quick design review (callable by Monica via `ctx.call`)
- After each cycle: reads git diff, appends a dated architecture update to `context.md`
- Caps `context.md` at ~16,000 chars; summarises older sections with `ai.fast` when it grows too large
- Detects circular dependencies and God modules via the dependency graph
- Curates the knowledge base — promotes good patterns, demotes noise (max 2 promotions/cycle)
- Uses `ai.full` for full reviews; `ai.fast` for quick design checks and summaries

---

### 🔎 Sandra — QA Scanner
**Role:** Code quality and project health checks.

Sandra scans the project for structural quality issues. She runs `npm audit` to check for known vulnerabilities, builds the coverage map and reports when coverage falls below 50%, and uses AI for deep code smell detection.

**Key behaviours:**
- `npm audit --json` → parses vulnerability counts, posts to r/security
- Builds coverage map; posts `[QA] Low test coverage — X%` when below 50%
- Checks for missing tests, README, package.json completeness
- AI code review for complexity, duplication, and missing documentation
- Won't re-post findings already on the board

---

### 🧪 Alice — Tester
**Role:** Finds untested source files and writes test suites for them.

Alice uses the coverage map to prioritise genuinely untested files. She writes test suites with the AI, saves them, and runs the project's test command. Test failures are posted to r/tests with file/line references.

**Key behaviours:**
- Uses `ctx.tools.buildCoverageMap()` to target untested files
- AI writes full test suites using `node:test` (no external deps)
- Runs tests in the sandbox with resource limits
- Posts failures to r/tests with actionable context
- `readonly = false` — Alice writes test files to disk

---

### 💉 Bobby — Injection Specialist
**Role:** Hunts injection vulnerabilities in source code.

Bobby runs a pattern catalogue against source files looking for injection vulnerabilities. He reports each finding to r/security and writes it to the knowledge base as a security pattern.

**`skills.scanFile(path)`** — synchronous single-file scan (callable by other agents via `ctx.call`).

**Vulnerability classes:**
- CMD-INJ — `exec()` with template literals
- EVAL — `eval()` and `new Function()`
- XSS — `innerHTML`/`document.write` assignments
- PATH-TRV — `fs` operations with `req.*` parameters
- SQLI — template-literal SQL strings
- PROTO — `__proto__` or `constructor` property access
- SSRF — `fetch()` with user-controlled URLs
- REDIR — `res.redirect()` with user input

Also queries `https://api.osv.dev` for known CVEs in project dependencies.

---

### 🏴‍☠️ Mallory — Pentester
**Role:** Adversarial security review from an attacker's perspective.

Mallory thinks like a threat actor. She scans for hardcoded secrets, checks HTTP servers for missing security headers, and uses AI to model attack scenarios.

**Checks Mallory runs:**
- Hardcoded API keys, passwords, private keys, database URIs
- Known-vulnerable npm packages
- Missing HTTP security headers (CSP, HSTS, X-Frame-Options)
- Stack trace exposure in production code
- AI threat modelling against source files

---

### 🛡 Angela — Security Engineer
**Role:** Defensive security posture — authentication, cryptography, and policies.

Where Mallory attacks, Angela defends. She reviews authentication implementation, cryptographic code, input handling, and checks for a security disclosure policy.

**Checks Angela runs:**
- Weak cryptography: deprecated ciphers, MD5/SHA-1, `Math.random()` for security
- JWT decoded without verification
- Session cookies missing `secure`/`httpOnly` flags
- Unguarded `JSON.parse` of request body
- Missing `SECURITY.md`

---

### 🚀 Danielle — DevOps/SRE
**Role:** Deployment readiness and operational hygiene.

Danielle checks whether the project can survive production. She runs `npm start` with a short timeout to check for immediate startup crashes, and looks for missing operational primitives.

**Checks Danielle runs:**
- Runs `npm start` (5s timeout) — reports immediate crash to r/ops
- Missing `start` and `test` scripts in package.json
- No Dockerfile or docker-compose
- No `.env.example`
- Servers without SIGTERM/SIGINT handlers
- Hard-coded port numbers
- AI-assisted operational readiness review

---

### 🎨 Lauren — UX Designer
**Role:** Advocates for users through accessibility and usability review.

Lauren reviews UI code for accessibility issues, UX anti-patterns, and i18n readiness.

**Checks Lauren runs:**
- Images without `alt` attributes
- Inputs without labels or `aria-label`
- Click handlers on non-interactive elements
- Hardcoded colours (contrast risk)
- `alert()` for user feedback
- Generic error messages ("Something went wrong")
- AI holistic usability review

---

### 📊 Jessica — Business Analyst
**Role:** Validates that completed work actually solved the original problem.

Jessica is the outcome checker. After work is marked done, she reviews it against the original request and scores outcome alignment. She flags orphaned work and escalates stalled requests.

**Key behaviours:**
- Reviews completed todos for outcome alignment (score 1-5)
- Flags work without a traceable request
- Escalates requests open > 2 weeks without progress
- Weekly product health report to r/general

---

### 👔 Kimberly — Engineering Manager
**Role:** Human-facing coordination layer. Removes blockers, tracks delivery.

Kimberly posts a daily standup summary with board health metrics. Her standup includes cross-project patterns from the knowledge base. She posts a health warning to r/ops when queues stall or security findings pile up.

**Key behaviours:**
- Daily standup to r/general (once per 20h), including recent cross-project knowledge entries
- Flags in-progress/planned posts with no activity > 24h
- Escalates critical security findings open > 2h
- Posts health warning to r/ops when stalled > 5 or open security findings > 3
- Written for human readers — plain language, no jargon

---

## How Agents Work Together

```
User posts to r/requests
        ↓
      Amy validates (clear? → approve; vague? → ask questions)
        ↓
      Vera dispatches (reads scratchpad, routes to Monica)
        ↓
      Monica plans (queries KB, calls Heather for design review)
        ↓
      Erica implements (reads context.md + KB, lints, sandboxes, commits)
        ↓
      Rita reviews (approve → done; reject → back to Erica + KB anti-pattern)
        ↓
      Heather checks architecture, updates context.md, curates KB
        ↓
  [Parallel]
  Bobby scans for injections    → r/security + KB security patterns
  Mallory penTests              → r/security
  Angela checks defensive posture → r/security
  Alice writes and runs tests   → r/tests (sandbox-isolated)
  Sandra checks quality + coverage → r/quality
  Danielle checks ops readiness → r/ops
  Lauren reviews UX/a11y        → r/ux
  Jessica validates outcomes    → comments on r/todo
  Kimberly manages the team     → r/general standup
```

---

## Adding a Custom Agent

Agents are **auto-discovered** — no changes to `index.js` needed. Just:

1. Create `src/agents/my-agent.js` extending `BaseAgent`:

```js
import { BaseAgent } from './base.js';

export class MyAgent extends BaseAgent {
  static priority = 50;   // lower = runs earlier in the cycle
  name        = 'my-agent';
  description = 'What I do.';
  avatar      = '🤖';
  role        = 'my-role';

  async think(ctx) {
    // Observe: read the board, inspect files
    const posts = await ctx.board.getPosts('my-sub').catch(() => []);
    return { posts };
  }

  async act(plan, ctx) {
    // Act: post, comment, write files
    for (const post of plan.posts.slice(0, 3)) {
      await ctx.board.addComment(post.id, {
        author: this.name,
        body:   '🤖 My analysis.',
      });
    }
    return { outcome: 'done', actions: [] };
  }
}
```

2. Restart the server. Your agent appears in `/agents` and the CLI's `agents` list:

```
> run my-agent
```

---

## Agent Context (`ctx`)

Every agent receives this context object in both `think()` and `act()`:

| Property         | Type       | Description                                                        |
|-----------------|------------|--------------------------------------------------------------------|
| `board`         | `Board`    | Board API — posts, comments, DMs, subreddits                       |
| `targetDir`     | `string`   | Absolute path to the project being managed                         |
| `hub`           | `SseHub`   | Broadcast SSE events to connected clients                          |
| `ai`            | `AI`       | AI client (`ask`, `askJSON`, plus `ai.fast` and `ai.full`)         |
| `gated`         | `boolean`  | When true, todos need explicit approval before Erica picks them up |
| `projectContext`| `string`   | Contents of `.mind-server/context.md` (cached 60s)                 |
| `tools`         | `object`   | Tool registry (see below)                                          |
| `call`          | `function` | Agent-to-agent skill invocation: `ctx.call(name, method, args)`    |

### Board API (selected methods)

```js
board.getPosts(sub, { status, type, limit })
board.getAllPosts({ type, limit })
board.createPost(sub, { title, body, author, type, meta })
board.updatePost(id, { status, meta })
board.addComment(id, { author, body })
board.getComments(id)
board.advanceStatus(id, newStatus)       // enforces transition graph
board.summary()                          // { total, byStatus, bySub }
board.ensureSub(name)                    // create subreddit if absent
board.sendDM({ from, to, subject, body, meta })
board.getDMs({ to, from, unreadOnly })
board.getDMThread(dmId)
board.replyToDM(dmId, { from, body })
```

### AI API

```js
ctx.ai.isAvailable()                    // false if no API key configured
ctx.ai.ask(prompt, { system })          // → string or null
ctx.ai.askJSON(prompt, { system })      // → parsed object or null

ctx.ai.fast.ask(prompt, opts)           // uses fastModel (cheap, quick)
ctx.ai.fast.askJSON(prompt, opts)
ctx.ai.full.ask(prompt, opts)           // uses model (expensive, capable)
ctx.ai.full.askJSON(prompt, opts)
```

### Tool Registry (`ctx.tools`)

```js
// Shell execution
ctx.tools.shell(cmd, opts)              // → { ok, stdout, stderr, code }

// Code search (ripgrep-based)
ctx.tools.search(pattern, opts)         // → [{ file, line, text }]
ctx.tools.findRefs(symbol)              // → [{ file, line, text }]
ctx.tools.findFiles(glob)               // → [path, ...]

// HTTP fetch
ctx.tools.fetch(url, opts)              // → { ok, status, text, json? }

// Dependency graph
ctx.tools.buildGraph()                  // → { nodes, edges }
ctx.tools.findDependencies(file, graph) // → [file, ...]
ctx.tools.findDependents(file, graph)   // → [file, ...]
ctx.tools.findCycles(graph)             // → [[file, ...], ...]
ctx.tools.findGodModules(graph, n)      // → [{ file, inDegree }, ...]

// Test coverage map
ctx.tools.buildCoverageMap()            // → { covered, uncovered, total, pct }

// Sandboxed execution
ctx.tools.sandbox(cmd, opts)            // → { ok, stdout, stderr, code }
                                        //   opts: { timeout, memoryMb, files }
```

### Agent-to-Agent Calls

```js
// Call a named skill on another agent — synchronous, inline result
const result = await ctx.call('heather', 'reviewDesign', { plan, title });
const scan   = await ctx.call('bobby', 'scanFile', { path: 'src/auth.js' });
```

Agents expose skills via the `skills` map:

```js
export class MyAgent extends BaseAgent {
  skills = {
    mySkill: async ({ input }, ctx) => {
      // ... do work ...
      return { result };
    },
  };
}
```

### BaseAgent Helpers

```js
// Memory
await this.remember('type', { ...payload })     // append to memory log
await this.recall(n)                            // last n entries
await this.recallWhere('type', filter, n)       // filtered, newest-first
await this.recallLast('type')                   // most recent of a type
await this.clearMemory()

// Posting
await this.postSafe(board, sub, { title, body, author, type, meta })
// → { post, isDuplicate }  — handles ensureSub + deduplication

// AI branching
await this.whenAI(ctx, withAI, withoutAI)
// → calls withAI(ctx) if AI available, else withoutAI(ctx)

// Scratchpad (shared cross-agent working memory)
await this.readScratchpad()                       // → string
await this.writeScratchpad('section', content)    // upserts named section

// Logging + progress
this.log(msg, ctx)                                // console + SSE agent:log
this.logProgress(msg, ctx)                        // console + SSE agent:progress

// Peer questions
await this.consultPeer(board, { to, subject, body })
await this.getUnansweredQuestions(board)
```

---

## Global Knowledge Base

Agents write and read from a cross-project knowledge base stored at `~/.mind-server/knowledge/`.

```js
import { Knowledge } from '../knowledge.js';
const kb = new Knowledge(homedir());

// Write a pattern
await kb.write({
  projectDir: ctx.targetDir,
  agentName:  this.name,
  type:       'pattern',   // 'pattern' | 'anti-pattern' | 'security' | 'decision' | 'lesson'
  title:      'JWT refresh token rotation',
  body:       'Always rotate the refresh token on use...',
  tags:       ['node', 'auth', 'jwt'],
});

// Search across all projects
const results = await kb.search('JWT auth', ['node'], 5);

// Recent entries
const recent = await kb.recent(10);

// Entries for this project
const mine = await kb.byProject(ctx.targetDir, 20);
```

**Who writes to the KB:**
- **Erica** — implementation patterns (after successful commits)
- **Bobby** — security findings as named patterns
- **Rita** — anti-patterns from recurring review issues
- **Heather** — curates and promotes entries, writes architecture decisions
