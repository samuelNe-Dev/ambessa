# Ambessa

**Ambessa is a self-improving software factory for coding agents: it builds your issues into proven PRs, measures every session, and keeps only the changes to itself that measurably help.**

> **Status: day 1.** Nothing runs yet. This repo is built in public, one small step a day. Follow along in [`LOG.md`](LOG.md).

## Why

Coding agents repeat the same mistakes. They retry the same failing command, write a file before reading it, or need the same correction from you again. Most agent setups fix this by piling up instructions and hoping they help. Ambessa treats every change to the setup as an experiment:

1. **Measure.** It reads your agent sessions and counts friction: repeated errors, your corrections, retries, and token spend per task.
2. **Propose.** It suggests one targeted fix per problem, and records the baseline rate it is meant to reduce.
3. **Grade.** After enough new sessions, it compares the rate before and after. The fix is graded *effective*, *partial* or *ineffective*.
4. **Keep or revert.** Fixes that don't help get reverted. Your setup only keeps changes that have evidence behind them.

On top of that loop runs a **factory**. It picks the next issue, builds it in an isolated worktree, proves the change with tests or before/after evidence, and hands you a PR. Factory jobs are sessions too, so the loop measures and improves the factory as well.

## Principles

- **Harness-agnostic.** Each harness writes sessions differently. One small adapter per harness converts them into a single normalized format. Claude Code comes first and Codex second, and any other harness can add an adapter.
- **No model calls.** The CLI is deterministic: it counts, compares and schedules. Judgement, such as writing a proposal, runs inside the agent you already use, through plain markdown skills.
- **Your data stays local.** Sessions, code and project names never leave your machine. Only aggregate numbers are shared, and only when you choose to.
- **Evidence before claims.** Every self-change carries a baseline and a grade. Every factory PR carries proof.
- **Zero runtime dependencies.** TypeScript on Node 20+, run with `npx ambessa`.

## Roadmap

| Version | Milestone |
|---|---|
| v0.0.1 | Normalized session format + Claude Code adapter |
| v0.0.2 | `ambessa signals`: friction report per session |
| v0.0.3 | Proposals with recorded baselines |
| v0.0.4 | Grading and automatic revert |
| **v0.1.0** | **The full improvement loop** |
| v0.2 | Codex adapter |
| v0.3 | Factory: web projects (Next.js, Vite) |
| v0.4 | Factory: iOS projects (SwiftUI, simulator evidence) |
| v1.0 | Everything above, dogfooded on real projects |

## How it's built

Every module starts as a decision record in [`docs/decisions/`](docs/decisions): the problem, the options, the choice and its tradeoffs. Progress is logged daily in [`LOG.md`](LOG.md), and results are published weekly as graded numbers.

## Influences

Ambessa's ideas build on public work by [Matt Pocock](https://github.com/mattpocock/skills) (alignment, triage and TDD skills), [Superpowers](https://github.com/obra/superpowers) ("evidence before claims", subagent execution) and the *isolate → build → prove → ship* software-factory pattern. Ambessa doesn't bundle their code or skills.

## Name

*Ambessa* (አንበሳ) is Amharic for lion.

## License

[MIT](LICENSE)
