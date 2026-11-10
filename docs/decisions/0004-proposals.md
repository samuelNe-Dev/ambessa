# 0004. Proposals with recorded baselines

Status: accepted
Date: 2026-11-10

## Context

v0.0.2 measures friction. v0.0.3 starts the loop: turn a bad signal into one concrete change to the agent setup, and record the "before" number that the change will be graded against in v0.0.4. A fix with no recorded baseline can only ever be judged by feel.

The constraints carry over from earlier records:

- The CLI never calls a model, so judgement lives in skills any harness can load.
- Ambessa never edits harness configuration or instruction files.
- The archive stores no text or paths ([0001](0001-normalized-session-format.md)).
- Signals are rates with their own units, compared over windows ([0003](0003-friction-signals.md)).

Many fixes belong in one project's `AGENTS.md` or `CLAUDE.md`. But the archive doesn't know which project a session belongs to, and the factory runs every job in its own worktree folder.

## Options

- **What a proposal is.** One change aimed at one signal, or a bundle. A bundle can't tell you which part helped.
- **Who decides the fix.** Built-in fix templates per signal are deterministic but generic. Leaving it all to the user is manual. Or a skill drafts the fix while the CLI keeps the numbers.
- **Who applies it.** Ambessa writing into instruction files would be more automated, but a tool that edits an agent's instructions needs far more trust. The alternative is that the user or their agent applies it and tells Ambessa when.
- **Baseline window.** The last 14 days, or the last N qualifying sessions. N sessions can reach back months for a quiet project.
- **Project identity.** A hash of the working folder makes every worktree its own project. Resolving the folder to its git repository puts worktrees together.
- **Storage.** Markdown with a header is friendlier to edit by hand, but it lets the baseline be changed by accident. The other option is JSON that Ambessa owns, holding the change as markdown.

## Decision

1. **A proposal is one setup change aimed at one signal.** It is an instruction, a skill, a hook or a permission. Its **scope** is global (the user's global instructions) or one project. Only one open proposal per signal and scope is allowed at a time, so two fixes are never graded against each other.

2. **A skill drafts the change; the CLI records the numbers.**
   - `ambessa propose` lists candidates, ranked in two groups:
     - First, signals trending worse or newly appearing, most changed first.
     - Then the rest with any hits, most hits first. A count of how often something happened is comparable across units; the rates themselves are not.
   - `ambessa evidence <signal>` lists the transcript locations behind recent hits (file and line, printed locally, never stored), so the agent can read what actually happened.
   - The `ambessa-propose` skill walks an agent through it: pick a candidate, read the evidence, draft one change, and ask the user to approve.
   - `ambessa propose --signal <id> [--project <dir>] --change <file>` records the approved proposal.

3. **The baseline is the signal's rate over the 14 days before the proposal, within its scope.** It's recorded with its hits, exposure, qualifying sessions, window and rules version. If fewer than 5 qualifying sessions exist, `propose` refuses and says why.

4. **The user or their agent applies the change.** Ambessa never edits instruction files or harness configuration. `ambessa proposals applied <id>` stamps the exact time the "after" window starts. Proposals move from `proposed` to `applied` or `rejected`. Grading, and reverting ineffective changes, come in v0.0.4.

5. **Projects are identified by their git repository, and the mapping is remembered.**
   - At ingest, each session's working folder is resolved to its repository's common git directory, so a worktree resolves to its main repository. The id is a hash of that directory.
   - The folder-to-project mapping is remembered in `state.json`, so the id stays stable after a worktree is deleted.
   - A folder that isn't a git repository, or no longer exists, falls back to a hash of the folder itself.
   - The adapter passes the working folder to ingest out of band. The archive stores only the hashed `projectId`.
   - This makes the session schema version 3. Changing the schema version also triggers a re-ingest of every transcript still on disk.

6. **Ambessa owns the proposal files.** They live in `~/.ambessa/proposals/<id>.json`, with ids like `p-0001`. Each holds the signal, scope, baseline, state, timestamps, and the change as markdown. `ambessa proposals` lists them and `ambessa proposals show <id>` prints one.

## Consequences

- **Easier:** every change to the agent setup carries the number it promised to move. A project's fixes are measured on that project's sessions, worktrees included.
- **Harder:** applying stays manual, so a proposal that's applied but never stamped can't be graded. The skill has to remind the user. Sessions ingested before v0.0.3 whose transcripts are gone have no project, so they only count toward global proposals.
- **Signs this was wrong:** `propose` refusing often for lack of sessions (the 14-day window is too short for real use), or proposals left `proposed` because the skill's drafts aren't useful.
