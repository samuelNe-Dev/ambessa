# Decision records

Each module and each important choice gets a short record, written before the code. A record says what was decided and why, so the reasoning outlives the conversation that produced it.

Name files `NNNN-short-title.md` (e.g. `0001-normalized-session-format.md`). Records are never rewritten after they're accepted. A changed decision gets a new record that supersedes the old one.

## Template

```markdown
# NNNN. Title

Status: proposed | accepted | superseded by NNNN
Date: YYYY-MM-DD

## Context
What problem forces a decision? What constraints apply?

## Options
The serious alternatives, each with its main upside and downside.

## Decision
What we chose, stated plainly.

## Consequences
What gets easier, what gets harder, and what we'll watch to know if it was wrong.
```
