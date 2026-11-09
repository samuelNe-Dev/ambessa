# Build log

One entry per working day: what changed, what I learned, what's next. Newest first.

## 2026-11-09 · Day 1

- Started Ambessa as a new public repo. It grows out of a private prototype I've been running on my own projects since October.
- Settled the plan: the improvement loop comes first, then the factory. TypeScript with zero runtime dependencies. Adapters for each harness. No model calls in the CLI.
- Accepted [decision record 0001](docs/decisions/0001-normalized-session-format.md), the normalized session format. Before deciding, I mapped how Claude Code and Codex actually log sessions. The biggest surprise was how differently the two count tokens: Codex's input includes cached tokens and its counters accumulate, while Claude's input excludes the cache. Summing them naively would make every cost number wrong.
- **Next:** v0.0.1. Set up TypeScript and write the Claude Code adapter test-first, against small hand-made sample transcripts.
