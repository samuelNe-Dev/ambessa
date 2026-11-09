# 0001. Normalized session format

Status: accepted
Date: 2026-11-09

## Context

Ambessa measures friction in coding-agent sessions and grades its own fixes by comparing signal rates before and after a change. To do that across harnesses, every detector must read **one** format, not one per harness.

The two first harnesses log sessions very differently:

- **Claude Code** writes JSONL per session. One API response is split into several partial `assistant` entries sharing a `message.id`. Tool errors carry only an `is_error` flag (true, false or absent) with the reason in text. `input_tokens` excludes cached tokens. Subagents live in separate files but reuse the parent's `sessionId`, and the parent also records an aggregate usage for each subagent. Entry types change often across versions.
- **Codex** writes JSONL "rollouts" as an envelope of `{timestamp, type, payload}`. The same event appears on several layers. Tool outputs have no error flag, but command items carry real exit codes. `input_tokens` includes cached tokens, and counters are cumulative. Subagents get their own id with a `parent_thread_id`. An older flat layout has no token data at all.
- Both record interruptions, permission denials, API errors and rate limits as structured data.
- Transcripts don't live forever: Claude Code keeps only a few weeks of history on disk, but grading needs baselines that are older than that.
- Transcripts contain private material: prompts, code, file paths, account ids.

This decision comes first because everything else stands on it. Signals, proposals, grading and the factory's metrics all read this format. If it's wrong, the errors are silent: a double-counted subagent or a misread token field produces confident numbers that are simply false, and a grade built on false numbers is worse than no grade. It's also the hardest decision to change later, because the archive (decision 5) will hold months of data in this shape.

## Options

- **Unit.** A *flat event list* per session is simpler, but turns can't be recovered from it afterwards, and without turns there's no fair way to compare a two-prompt session with a forty-prompt one. Making *tasks* the top unit now would answer "tokens per task" directly, but neither harness has a task id, so it would rest on guesswork before anything else worked.
- **Subagents.** *Nesting* subagents inside the parent makes one huge record per root session that can't be streamed, and it hides that a subagent is a session in its own right. *Ignoring* them would make most factory work invisible, since the factory delegates heavily.
- **Tokens.** *Session totals* are smaller, but per-turn or per-task spend could never be reconstructed. *Raw fields normalized later* would push every harness quirk into every detector, which defeats the point of adapters.
- **Errors.** A *boolean plus raw text* is closest to the prototype, but it means matching English text with regexes (brittle) and storing text (private). A *detailed taxonomy* up front would mean inventing categories before real data shows which ones matter.
- **Storage.** An archive with *short text excerpts* makes reports nicer to read, but it means keeping private text on disk indefinitely. *No archive* is simplest, but baselines would disappear after a few weeks and grading would break.
- **Format.** *SQLite* is great for queries, but Node 20 has no stable built-in driver, so it would cost the zero-dependency rule. *One JSON document per session* can't be streamed or appended, and transcripts reach over 100 MB.

## Decision

1. **Unit: session with turns.** A *session* is one harness session (one transcript). A *turn* runs from one human prompt to the final answer. Grouping sessions into *tasks* (resume, fork, handoff) gets its own later record.

   Turns are the natural unit of work from the user's side: one request, one outcome. Rates per turn ("0.4 corrections per turn") stay comparable between short and long sessions, which rates per session don't. Both harnesses already mark turns, so the adapter can find them without guessing.

2. **Subagents: linked child sessions.** Each subagent is its own session with `parentId` and `depth`. Its tokens come only from its own model calls; the parent's aggregate is ignored, so nothing is counted twice. Signals inside subagents count, both per session and rolled up to the root. A subagent with no resolvable parent keeps `parentId: null` and is flagged `orphan`.

   A subagent does real work with its own errors and its own spend, so it gets the same treatment as any session. Counting tokens at exactly one place (the child's own calls) is the only way to guarantee totals add up. Keeping orphans, instead of dropping them, keeps their friction visible even when the link is broken.

3. **Tokens: per model call, five fields.** `inputUncached`, `cacheRead`, `cacheWrite`, `output`, and `reasoning` (a part of `output`). Adapters normalize: Claude dedupes partial entries by message id (last one wins); Codex subtracts cached tokens from input and turns cumulative counters into per-call deltas. Unknown values are `null`, never `0`. No currency in v0.0.1.

   Per-call data can always be summed into turns, sessions or tasks; totals can never be split again. `null` matters because `0` is a claim: "this call used no tokens." The legacy Codex layout has no token data, and treating that as zero would make old sessions look cheap and every later change look like a regression. Currency is left out because prices change and only one harness records cost. A versioned price table can come later.

4. **Errors: three-state outcome plus a kind.** Every tool call has `outcome: ok | error | unknown`. Errors carry a `kind`: `nonzero_exit`, `rejected_by_user`, `permission_denied`, `hook_blocked`, `interrupted`, `api_error`, `rate_limited`, `other`. Adapters use structured fields before text matching. Every tool call gets a `category` (`shell`, `read`, `write`, `search`, `web`, `agent`, `mcp`, `plan`, `other`) plus its raw name, so detectors never need to know a harness's tool names.

   `unknown` keeps the data honest: Claude often doesn't say whether a call failed, and guessing "ok" would undercount errors. The kinds are the ones both harnesses already record in structured form, so they're grounded in real data. `other` catches the rest until data shows a new kind is worth adding. Categories let a detector say "a write before any read of the same file" once, instead of once per harness.

5. **Storage: a redacted local archive.** Ambessa keeps its own long-lived archive of normalized sessions on the user's machine. Adapters redact while reading. Message text, tool inputs and outputs, file paths and account ids are never stored. What is stored: structure, enums, counts, tokens, durations and hashed ids, plus a pointer (source file and line) for drill-down while the original transcript still exists. Anything that leaves the machine is an aggregate.

   Grading needs baselines older than the harness keeps, so Ambessa must own its history. Redacting at read time means private text never reaches Ambessa's storage at all, so there's nothing to leak, no matter what later code does with the archive. Redacting at export would mean the archive holds everything and every future feature has to remember not to leak it. The pointer keeps debugging possible without copying content.

6. **Format: JSONL with a schema version.** One JSONL file of events per session plus a summary record; every record carries `schemaVersion`. Adapters stream line by line. Unknown harness entry types are skipped and counted, never fatal. Each adapter documents the minimum harness version it supports.

   JSONL streams, appends, diffs and greps, and it needs no dependency. `schemaVersion` on every record lets the archive outlive changes to this format. Harnesses add entry types often, so failing on an unknown type would break Ambessa after every harness update. Skipping silently would hide drift, so skipped types are counted and reported.

## Consequences

- **Easier:** detectors are harness-neutral, so adding a harness means writing one adapter and changing no detector. Adapters are testable with small hand-made fixture files. The archive can't leak text, because it never stores any.
- **Harder:** adapters carry every per-harness quirk and must keep up with harness releases. Some debugging needs the original transcript, which may be gone. Signals that depend on wording (for example, detecting a correction from what the user typed) can only use structured cues or must run at read time without storing the text.
- **Signs this was wrong:** a growing share of `unknown` outcomes or skipped entry types, which means an adapter is drifting from its harness; a useful signal we can't build without stored text; token totals that disagree with what the harness itself reports.
