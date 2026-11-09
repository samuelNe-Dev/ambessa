# 0003. Friction signals

Status: accepted
Date: 2026-11-09

## Context

v0.0.1 counts what happened in a session. v0.0.2 has to say what went *wrong*, as rates that can be compared week over week. These rates are what v0.0.4 will use to grade a fix before and after it ships, so each one must mean the same thing every time it's computed.

Two constraints shape this:

- The archive stores no text ([0001](0001-normalized-session-format.md), point 5). But some of the most useful signals exist only in text. Claude Code says "File has not been read yet" when the agent writes a file it never read, and nothing structured records that.
- The prototype's 21 rules were mostly regexes over text, several were project-specific, and every rate was "hits per session". That made long sessions look worse just for being long.

## Options

- **Where text-based signals come from.** Rules could run at ingest and store only the resulting tag, use structured data only, or store redacted error "shapes" so new rules can run on old sessions. Structured-only loses three of the most actionable signals. Stored shapes are text in the archive, which reopens 0001.
- **What a rate is divided by.** Options were one unit for everything (per session, or per human turn) or a natural unit per signal. Per session punishes long sessions. Per turn punishes tool-heavy turns for tool errors.
- **User corrections.** The options were phrase-matching on what the user typed, or structured proxies (interruptions, rejected tool calls). Phrase-matching catches more, but its precision is unknown, it's English-only, and pasted text produces false positives.
- **Custom rules.** A user rule file now, or built-in rules only until the format has proven itself.

## Decision

1. **Text-based signals are tagged at ingest.** While reading a transcript, the adapter runs its text rules and stores only the resulting tag on the event (`tool_call.signals: ["read-before-write"]`). The text is never stored. The patterns belong to the adapter, because they match one harness's wording. The tags are harness-neutral ids.

2. **Every signal has a natural unit.**

   | Group | Signal | Counts | Per |
   |---|---|---|---|
   | Tool friction | `tool-errors` | tool calls that failed | 100 tool calls |
   | | `nonzero-exit` | shell commands that exited non-zero | 100 shell calls |
   | | `retry-loops` | runs of the same tool failing two or more times in a row, counted once per run | 100 tool calls |
   | | `blocked` | calls stopped by a permission rule or a hook | 100 tool calls |
   | Conversation | `interruptions` | times the user stopped the agent | human turn |
   | | `rejected-calls` | tool calls the user said no to | human turn |
   | Cost and context | `tokens` | input and output tokens, subagents included | human turn |
   | | `compactions` | context compactions | human turn |
   | | `api-errors` | failed model requests, rate limits included | human turn |
   | Text-tagged | `read-before-write` | writes to a file the agent hadn't read | 100 write calls |
   | | `stale-file` | edits to a file that changed since it was read | 100 write calls |
   | | `file-not-found` | reads of a file that doesn't exist | 100 read calls |

   A subagent's activity counts toward its root session. Sessions with no human turns, such as scheduled or fully automated runs, are left out of the per-human-turn signals, which would otherwise divide by zero. The report says how many were left out.

3. **Corrections use structured proxies for now.** `interruptions` and `rejected-calls` stand in for "the user corrected the agent". Phrase-matching waits until there is a labelled set to measure its precision against.

4. **Built-in rules only.** Every rule is project-agnostic and tested. A user rule file comes later.

5. **Rule changes re-tag what's still on disk.** Each session records the `rulesVersion` it was tagged with, and that version is part of the ingest fingerprint. When rules change, the next ingest re-reads every transcript still on disk. Sessions whose transcript is gone keep their old tags. Text-tagged signals count only sessions tagged by the current rules, so both weeks are always compared like with like. The report says how many sessions were left out for having older tags.

6. **`ambessa signals` compares this week with last week.** One row per signal shows its rate over sessions that started in the last 7 days and in the 7 days before, plus a trend.
   - **Up or down:** the rate moved more than 20%.
   - **Flat:** it moved less than that.
   - **New:** it was zero last week.
   - **Too few sessions:** either week has fewer than 5 qualifying sessions or a zero denominator.

   This is the same before/after shape grading will use in v0.0.4.

7. **The schema version becomes 2.** Tool calls gain `signals`, and sessions gain `rulesVersion`. Readers still accept version 1 records, read as having no tags and rules version 0, and the next ingest re-tags them if their transcript is still on disk.

## Consequences

- **Easier:** every rate is comparable across sessions of different lengths. Adding a structured signal needs no re-ingest, and adding a harness needs only its own text patterns.
- **Harder:** a new or fixed text rule can't reach sessions older than the harness keeps transcripts (about five weeks for Claude Code). Thresholds (±20%, 5 sessions) are judgement calls until there's data to tune them.
- **Signs this was wrong:** a signal whose rate swings week to week with no change in how I work (too noisy for grading), or many sessions left out after rule changes.
