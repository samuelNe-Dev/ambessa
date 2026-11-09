# 0002. MCP server names in the archive

Status: accepted
Date: 2026-11-09

## Context

[0001](0001-normalized-session-format.md) keeps each tool's raw name next to its category. MCP tools are named `mcp__<server>__<tool>`, and the server part can say more than "which tool". `mcp__acme-internal__deploy` names an employer. `mcp__claude_ai_Supabase__apply_migration` shows which services someone uses. Running ingest over real transcripts showed a third kind: connectors registered under a UUID, which identifies an account's connector.

## Options

- **Keep readable names locally.** Detectors can say "Supabase migrations fail often". The cost is that the local archive holds service and possibly employer names.
- **Hash every server name.** Nothing readable is stored, but reports can't name the server causing friction without a separate lookup that would itself hold the names.
- **Allowlist well-known servers, hash the rest.** A middle ground, but the list needs constant upkeep and still has to guess what counts as public.

## Decision

- Server names that are UUIDs are replaced by a short hash (`mcp__id-<8 hex>__<tool>`). An id says nothing useful about friction, and it identifies an account.
- Readable server names stay in the **local** archive. The archive never leaves the machine (0001, point 5).
- Anything that leaves the machine, such as the published weekly numbers, groups MCP tools **by category only**, never by server or tool name.

## Consequences

- Friction can be traced to a specific MCP server locally, which is where it gets fixed.
- Every future export has to enforce the category-only rule. The export feature must have a test for it.
- The hash is a pseudonym, not encryption: someone who knows the account's connector id could recompute it. That's acceptable because the archive is local.
