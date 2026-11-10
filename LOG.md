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
- Added `ambessa sessions`: root sessions newest first, with subagents' tool calls and tokens rolled up. One design call made by a failing test: a subagent's prompts don't count as turns, because they come from its parent agent, not from me. Counting them would inflate every per-turn rate. Over my archive it reads 232 sessions in 0.9 s.
- Prepared v0.0.1.
- Held back the npm release. Publishing from an agent's shell can't answer npm's interactive login. Rather than keep a long-lived token on my laptop, I'll publish from GitHub Actions with npm trusted publishing ([#5](https://github.com/samuelNe-Dev/ambessa/issues/5)). Until then the README says to run from source.
- Built v0.0.2, friction signals ([decision record 0003](docs/decisions/0003-friction-signals.md)). There are 12 signals, each a rate in its own unit (per 100 tool, shell, write or read calls, or per human turn), compared week over week. Text-only signals like "File has been modified since read" are tagged at ingest, so the archive still holds no text.
- First real reading: `stale-file` is my biggest text-tagged friction at about 3 in every 100 edits, and tokens per human turn halved this week (9.2M to 4.3M). Real data also caught one more misleading number: a tiny but real rate printed as `0.00`. It now prints `<0.01`.
- Writing the tests first caught two of my own mistakes before any code existed: exactly −20% is not a trend under a "more than 20%" rule, and a session with a human turn but no model calls still lowers the average tokens per turn.
- **Next:** v0.0.3: proposals with recorded baselines.

## 2026-11-10 · Day 2

- Released v0.0.2 and reordered the roadmap: the factory now comes right after the loop (v0.2), ahead of Codex. The README promises a factory first, so it shouldn't be the last thing built.
- Settled v0.0.3 in [decision record 0004](docs/decisions/0004-proposals.md). A proposal is one setup change aimed at one signal, with a 14-day baseline. A skill drafts it, and I apply it.
- First piece: project identity. Each session now knows its project as a hashed git repository, so the factory's worktrees count as one project. Over my archive that's 50 working folders in 37 projects.
- The archive proved its point overnight: Claude Code deleted 11 transcripts since yesterday, and their sessions are still in the archive.
