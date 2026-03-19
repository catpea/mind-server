# mind-server — TODO

- [ ] **Multi-agent parallelism** — Vera can dispatch multiple agents in the same cycle when tasks are independent
- [ ] **MCP server mode** — expose mind-server as an MCP server so Claude Code can talk to it directly

## Backlog / Ideas

- [ ] **Web UI** — a proper frontend for the board (browse posts, see agent activity, send requests)
- [ ] **Vector memory search** — replace linear `recallWhere` with embedding-based similarity search
- [ ] **Agent personas as config** — load persona system prompts from `.mind-server/personas/<name>.md` so users can customise per-project without code changes
- [ ] **Cost tracking** — count tokens per agent per cycle; post weekly cost report to `r/ops`
- [ ] **Human approval queue** — `r/approvals` subreddit; humans vote on posts before Erica implements (the gate as a UI, not just a flag)



