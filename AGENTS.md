# Agent Roster — mind-server

mind-server ships with a built-in crew of 15 specialised agents. They collaborate like a software team: product, engineering, security, ops, and design all have a seat at the table.

Each agent follows the same lifecycle:

```
think(ctx) → observe the board and project
act(plan, ctx) → take targeted actions
```

Agents post findings to subreddits (r/quality, r/security, r/ux, r/ops, r/standards), comment on posts, send DMs, and advance post statuses. They never delete work — they communicate through the board, just like a human team would.

---

## The Crew

### 🗺 Amy — Product Manager
**Role:** Validates feature requests before planning begins.

Amy reads r/requests and asks: *"Is this clear enough to build?"* If a request is vague, she comments with clarifying questions and blocks it from planning. If it's ready, she marks it with a priority (high/medium/low) so Monica knows what to tackle first.

**Key behaviours:**
- Requests r/requests posts that lack `amyReviewed` metadata
- Asks up to 3 clarifying questions per request
- Sets `priority` metadata used by Monica for planning order
- Detects duplicate requests by cross-referencing existing todos

---

### 🧭 Vera — Dispatcher
**Role:** Reads the board and routes work to the right agent.

Vera is the team lead. She surveys the board every cycle and decides who should do what next: Monica gets unplanned requests, Erica gets planned todos that need work, Rita gets completed work that needs review, Sandra scans when nothing else is active.

**Key behaviours:**
- Reads board summary and dispatches via DM + r/dispatch post
- Heuristic: unplanned requests → Monica; needsWork todos → Erica; review todos → Rita; idle → Sandra
- Won't redispatch work that's already been dispatched recently

---

### 📋 Monica — Planner
**Role:** Converts approved requests into actionable implementation plans.

Monica reads r/requests posts approved by Amy and creates structured r/todo posts with acceptance criteria, implementation steps, and file suggestions. She then DMs Erica to get started.

**Key behaviours:**
- Picks the highest-priority Amy-approved requests
- Creates one r/todo post per request with a full implementation plan
- DMs Erica once a todo is created

---

### 💻 Erica — Implementer
**Role:** Reads plans and writes code to the project directory.

Erica is the only agent that writes files to disk. She reads Monica's plans, asks the AI to write the implementation, writes the files, and advances the post to `review` status. She DMs Rita when ready.

**Key behaviours:**
- Reads up to 5 existing source files for context before implementing
- Writes files to `targetDir` (the project being managed)
- Stores filenames in post metadata (`filesWritten`) for downstream agents
- DMs Rita to trigger review

---

### 🔍 Rita — Code Reviewer
**Role:** Reviews Erica's implementation against acceptance criteria.

Rita reads files written by Erica, compares them to the plan, and either approves (→ done) or requests changes (→ back to in-progress with a DM to Erica explaining what to fix).

**Key behaviours:**
- Reads the actual files written (from post metadata)
- Approves or rejects with specific, actionable feedback
- Won't approve a post she's already reviewed

---

### 🏗 Heather — Tech Lead
**Role:** Architectural quality review and setting technical standards.

Heather reviews work in `review` status for architectural concerns: coupling, naming consistency, hidden dependencies, and technical debt. She also generates and posts project-specific architectural standards to r/standards when the board is fresh.

**Key behaviours:**
- Reviews code for separation of concerns, naming conventions, and simplicity
- Posts 3 architectural standards to r/standards on a fresh project
- Standards are generated from the project's actual package.json

---

### 🔎 Sandra — QA Scanner
**Role:** Code quality and project health checks.

Sandra scans the project for structural quality issues: missing tests, missing README, missing descriptions in package.json, and AI-powered code smells. She posts findings to r/quality.

**Key behaviours:**
- Checks for test files, README, package.json completeness
- AI code review for quality issues (complexity, duplication, missing docs)
- Won't re-post findings she's already posted

---

### 🧪 Alice — Tester
**Role:** Finds untested source files and writes test suites for them.

Alice identifies source files with no corresponding test file, writes a test suite for each using the AI, saves the file, then runs the project's test command and posts any failures to r/tests.

**Key behaviours:**
- Detects source files without matching `*.test.js` or `test/*.test.js`
- AI writes full test suites using `node:test` (no external deps)
- Runs `npm test` and parses failure output
- Posts test failures to r/tests with file and line references

---

### 💉 Bobby — Injection Specialist
**Role:** Hunts injection vulnerabilities in source code.

Bobby runs a pattern catalogue against source files looking for command injection, SQL injection, XSS, path traversal, eval(), SSRF, and prototype pollution. She reports each finding to r/security with file/line references and concrete remediation steps.

**Vulnerability classes:**
- CMD-INJ — exec() with template literals
- EVAL — eval() and new Function()
- XSS — innerHTML/document.write assignments
- PATH-TRV — fs operations with req. parameters
- SQLI — template literal SQL strings
- PROTO — `__proto__` or `constructor` property access
- SSRF — fetch() with user-controlled URLs
- REDIR — res.redirect() with user input

---

### 🏴‍☠️ Mallory — Pentester
**Role:** Adversarial security review from an attacker's perspective.

Mallory thinks like a threat actor. She scans for hardcoded secrets and credentials, reviews dependencies for known-vulnerable packages, checks HTTP servers for missing security headers and stack trace disclosure, and uses AI to model attack scenarios.

**Checks Mallory runs:**
- Hardcoded API keys, passwords, private keys, database URIs
- Known-vulnerable npm packages
- Missing HTTP security headers (CSP, HSTS, X-Frame-Options)
- Stack trace exposure in production code
- AI threat modelling against source files

---

### 🛡 Angela — Security Engineer
**Role:** Defensive security posture — authentication, cryptography, and policies.

Where Mallory attacks, Angela defends. She reviews authentication implementation for missing controls, checks cryptographic code for weak algorithms, validates input handling, audits dependency hygiene, and checks for a security disclosure policy.

**Checks Angela runs:**
- Weak cryptography: deprecated ciphers, MD5/SHA-1, Math.random() for security
- JWT decoded without verification
- Session cookies missing secure/httpOnly flags
- Unguarded JSON.parse of request body
- Missing SECURITY.md

---

### 🚀 Danielle — DevOps/SRE
**Role:** Deployment readiness and operational hygiene.

Danielle checks whether the project can survive production. She looks for missing npm scripts, container configuration, graceful shutdown handling, hard-coded ports, and operational concerns like health checks and structured logging.

**Checks Danielle runs:**
- Missing `start` and `test` scripts in package.json
- No Dockerfile or docker-compose
- No .env.example
- Servers without SIGTERM/SIGINT handlers
- Hard-coded port numbers
- AI-assisted operational readiness review

---

### 🎨 Lauren — UX Designer
**Role:** Advocates for users through accessibility and usability review.

Lauren reviews UI code for accessibility issues (missing alt text, unlabelled inputs, non-interactive click targets), UX anti-patterns (alert() dialogs, disabled elements without explanation, generic error messages), and i18n readiness.

**Checks Lauren runs:**
- Images without `alt` attributes
- Inputs without labels or aria-label
- Click handlers on non-interactive elements
- Hardcoded colours (contrast risk)
- `alert()` for user feedback
- Generic error messages ("Something went wrong")
- AI holistic usability review

---

### 📊 Jessica — Business Analyst
**Role:** Validates that completed work actually solved the original problem.

Jessica is the outcome checker. After work is marked done, she reviews it against the original request and scores outcome alignment. She flags orphaned work (implemented without a request), escalates stalled requests, and posts a weekly product health report.

**Key behaviours:**
- Reviews completed todos for outcome alignment (score 1-5)
- Flags work without a traceable request
- Escalates requests open > 2 weeks without progress
- Weekly product health report to r/general

---

### 👔 Kimberly — Engineering Manager
**Role:** Human-facing coordination layer. Removes blockers, tracks delivery.

Kimberly is the manager. She posts a daily standup summary with board health metrics, flags work that has been in-progress for more than 24 hours without activity, and escalates unaddressed critical security findings to the team.

**Key behaviours:**
- Daily standup to r/general (once per 20h)
- Flags in-progress/planned posts with no activity > 24h
- Escalates critical security findings open > 2h
- Written for human readers — plain language, no jargon

---

## How Agents Work Together

```
User posts to r/requests
        ↓
      Amy validates (clear? → approve; vague? → ask questions)
        ↓
      Vera dispatches (routes to Monica)
        ↓
      Monica plans (creates r/todo with acceptance criteria)
        ↓
      Erica implements (writes files to disk)
        ↓
      Rita reviews (approve → done; reject → back to Erica)
        ↓
      Heather checks architecture (r/standards if needed)
        ↓
  [Parallel]
  Bobby scans for injections    → r/security
  Mallory penTests              → r/security
  Angela checks defensive posture → r/security
  Alice writes and runs tests   → r/tests
  Sandra checks code quality    → r/quality
  Danielle checks ops readiness → r/ops
  Lauren reviews UX/a11y        → r/ux
  Jessica validates outcomes    → comments on r/todo
  Kimberly manages the team     → r/general standup
```

---

## Adding a Custom Agent

1. Create `src/agents/my-agent.js` extending `BaseAgent`:

```js
import { BaseAgent } from './base.js';

export class MyAgent extends BaseAgent {
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
    return { outcome: 'done' };
  }
}
```

2. Add to `src/agents/index.js`:

```js
import { MyAgent } from './my-agent.js';

const AGENT_CLASSES = [
  Amy, Vera, Monica, /* ... */, MyAgent,
];
```

3. Restart the server. Your agent appears in the `/agents` endpoint and can be run via the CLI:

```
> run my-agent
```

---

## Agent Context (`ctx`)

Every agent receives this context object in both `think()` and `act()`:

| Property     | Type          | Description                                      |
|-------------|---------------|--------------------------------------------------|
| `board`     | `Board`       | Board API — posts, comments, DMs, subreddits     |
| `targetDir` | `string`      | Absolute path to the project being managed       |
| `hub`       | `SseHub`      | Broadcast SSE events to connected clients        |
| `ai`        | `AI`          | Multi-provider AI client (`ask`, `askJSON`)      |

### Board API (selected methods)

```js
board.getPosts(sub, { status, type, limit })
board.getAllPosts({ type, limit })
board.createPost(sub, { title, body, author, type, meta })
board.updatePost(id, { status, meta })
board.addComment(id, { author, body })
board.getComments(id)
board.summary()          // { total, byStatus, bySub }
board.ensureSub(name)    // create subreddit if it doesn't exist
```

### AI API

```js
ctx.ai.isAvailable()                    // false if no API key configured
ctx.ai.ask(prompt, { system })          // → string or null
ctx.ai.askJSON(prompt, { system })      // → parsed object or null
```

### Agent Memory

```js
await this.remember('type', { ...payload })   // save a memory entry
await this.recall(n)                          // get last n entries
await this.clearMemory()                      // wipe this agent's memory
```

Memory is per-agent, per-project — stored in `.mind-server/agents/<name>/memory.json`.
