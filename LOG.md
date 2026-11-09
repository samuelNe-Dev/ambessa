# Build log

One entry per working day: what changed, what I learned, what's next. Newest first.

## 2026-11-09 · Day 1

- Started Ambessa as a new public repo. It grows out of a private prototype I've been running on my own projects since October.
- Settled the plan: the improvement loop comes first, then the factory. TypeScript with zero runtime dependencies. Adapters for each harness. No model calls in the CLI.
- Accepted [decision record 0001](docs/decisions/0001-normalized-session-format.md), the normalized session format. Before deciding, I mapped how Claude Code and Codex actually log sessions. The biggest surprise was how differently the two count tokens: Codex's input includes cached tokens and its counters accumulate, while Claude's input excludes the cache. Summing them naively would make every cost number wrong.
- Started v0.0.1 with the toolchain: TypeScript, vitest, and CI on Node 22 and 24. Installing it showed that Node 20 reached end of life in April 2026 and current vitest needs 22.12+, so I raised the minimum to Node 22.12 rather than supporting an unpatched runtime.
- Wrote the Claude Code adapter test-first against hand-made sample transcripts, then ran it over all 443 of my real transcripts (3.5 GB, 29 s, 0 crashes). Real data caught two things the samples didn't: hook blocks are filed as permission denials, and most tools leave out the error flag when they succeed. Fixing both cut tool calls with an unknown outcome from 30% to 12.5%. I kept the rest as `unknown` instead of guessing.
- Built the archive and `ambessa ingest`. First run over my 445 transcripts: 38 s; the next run: 0.45 s, because unchanged files are skipped. The archive is 14 MB, against 3.5 GB of transcripts.
- Three lessons from real data and review. A line reader created before an unrelated `await` can close before anyone reads it and hang forever. Subagent meta files are `agent-<id>.meta.json`, not `.json`; the tests passed on the wrong name, so tests built on assumptions only check those assumptions. And MCP connectors can be registered under account UUIDs, which were leaking into tool names. That led to [decision record 0002](docs/decisions/0002-mcp-server-names.md).
- **Next:** `ambessa sessions`, then release v0.0.1.
