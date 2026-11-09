import { basename } from "node:path";
import { hashId } from "../session/ids.js";
import {
  SCHEMA_VERSION,
  type ErrorKind,
  type ModelCallEvent,
  type NormalizedSession,
  type SessionEvent,
  type ToolCallEvent,
  type ToolCategory,
  type ToolOutcome,
  type TurnOrigin,
  type Usage,
} from "../session/schema.js";

/**
 * Claude Code adapter: one transcript (`~/.claude/projects/<dir>/<session>.jsonl`, or a subagent's
 * `<session>/subagents/agent-<id>.jsonl`) in, one normalized session out.
 *
 * Text is read only to classify (is this prompt automated? did this command exit non-zero?) and is
 * never copied into the output.
 */
export interface ClaudeCodeInput {
  /** Path of the transcript; becomes the local drill-down pointer. */
  file: string;
  lines: Iterable<string> | AsyncIterable<string>;
  /** Parsed contents of a subagent's `agent-<id>.json` meta file, when there is one. */
  meta?: unknown;
}

const HARNESS = "claude-code";

/** Entry types the adapter understands but doesn't need: bookkeeping, titles, account and cost snapshots. */
const IGNORED_TYPES = new Set([
  "agent-name",
  "ai-title",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "atis-latch",
  "bridge-session",
  "cost-state",
  "custom-title",
  "file-history-delta",
  "file-history-snapshot",
  "last-prompt",
  "mode",
  "permission-mode",
  "pr-link",
  "queue-operation",
  "relocated",
  "session-owner",
  "summary",
  "tools-used",
]);

const AUTOMATED_TURN_ORIGINS = new Set(["task_notification", "scheduled", "peer"]);
const PERMISSION_DENIALS = new Set(["permission-rule", "automode-blocked", "automode-unavailable"]);
const INTERRUPTION_PREFIX = "[Request interrupted by user";
/** User entries that aren't prompts: slash-command output and the user's own `!` shell commands. */
const NON_PROMPT_TAGS = ["<local-command-", "<bash-input", "<bash-stdout", "<bash-stderr"];
const SUBAGENT_FILE = /^agent-(.+)\.jsonl$/;
const ENTRY_TYPE = /^[a-z0-9_-]{1,40}$/i;
const MCP_TOOL_WITH_ID = /^mcp__([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})__(.+)$/i;

type Entry = Record<string, unknown>;

export async function normalizeClaudeCode(input: ClaudeCodeInput): Promise<NormalizedSession> {
  const events: SessionEvent[] = [];
  const modelCalls = new Map<string, ModelCallEvent>();
  const toolCalls = new Map<string, ToolCallEvent>();
  const unknownEntryTypes: Record<string, number> = {};
  let unparseableLines = 0;
  let sessionId: string | null = null;
  let harnessVersion: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let startedMs = Infinity;
  let endedMs = -Infinity;
  // A subagent is known by an agentId on its entries, by its file name, or by having a meta file.
  const meta = obj(input.meta);
  const fileAgentId = SUBAGENT_FILE.exec(basename(input.file))?.[1] ?? null;
  let agentId: string | null = null;
  const isSubagent = () => agentId !== null || fileAgentId !== null || meta !== null;
  let turn: number | null = null;
  let lineNumber = 0;

  for await (const line of input.lines) {
    lineNumber += 1;
    const entry = parseEntry(line);
    if (entry === null) {
      unparseableLines += 1;
      continue;
    }

    sessionId ??= str(entry.sessionId);
    agentId ??= str(entry.agentId);
    const version = str(entry.version);
    if (version !== null && (harnessVersion === null || compareVersions(version, harnessVersion) > 0)) {
      harnessVersion = version;
    }
    const at = str(entry.timestamp);
    const ms = at === null ? NaN : Date.parse(at);
    if (!Number.isNaN(ms)) {
      if (ms < startedMs) [startedMs, startedAt] = [ms, at];
      if (ms > endedMs) [endedMs, endedAt] = [ms, at];
    }

    const type = str(entry.type) ?? "(none)";
    switch (type) {
      case "user": {
        const message = obj(entry.message);
        if (entry.isMeta === true || entry.isCompactSummary === true || message === null) break;
        const results = blocks(message.content).filter((block) => block.type === "tool_result");
        if (results.length > 0) {
          for (const block of results) {
            const call = toolCalls.get(str(block.tool_use_id) ?? "");
            if (call === undefined) continue;
            const { outcome, errorKind } = classifyResult(block, entry);
            call.outcome = outcome;
            call.errorKind = errorKind;
          }
          break;
        }
        const text = messageText(message.content);
        if (text.startsWith(INTERRUPTION_PREFIX)) {
          events.push({ kind: "interruption", turn, at, line: lineNumber });
          break;
        }
        if (NON_PROMPT_TAGS.some((tag) => text.trimStart().startsWith(tag))) break;
        turn = turn === null ? 0 : turn + 1;
        const origin = promptOrigin(entry, text, isSubagent());
        events.push({ kind: "turn", index: turn, origin, at, line: lineNumber });
        break;
      }

      case "assistant": {
        const message = obj(entry.message);
        if (message === null) break;
        if (entry.isApiErrorMessage === true) {
          const errorKind = entry.error === "rate_limit" || entry.apiErrorStatus === 429 ? "rate_limited" : "api_error";
          events.push({ kind: "api_error", turn, errorKind, final: true, at, line: lineNumber });
          break;
        }
        const model = str(message.model);
        if (model === "<synthetic>") break;

        const messageId = str(message.id) ?? `line:${lineNumber}`;
        const usage = toUsage(obj(message.usage));
        const known = modelCalls.get(messageId);
        if (known === undefined) {
          const call: ModelCallEvent = { kind: "model_call", turn, model, usage, at, line: lineNumber };
          modelCalls.set(messageId, call);
          events.push(call);
        } else {
          // One API response is written as several partial entries; later ones have the final counts.
          // A copy that lacks a count must not erase one we already know.
          known.usage = mergeUsage(known.usage, usage);
        }

        for (const block of blocks(message.content)) {
          const id = str(block.id);
          if (block.type !== "tool_use" || id === null || toolCalls.has(id)) continue;
          const tool = redactToolName(str(block.name) ?? "(unnamed)");
          const call: ToolCallEvent = {
            kind: "tool_call",
            callId: hashId(HARNESS, "call", id),
            turn,
            tool,
            category: categorize(tool),
            outcome: "unknown",
            errorKind: null,
            at,
            line: lineNumber,
          };
          toolCalls.set(id, call);
          events.push(call);
        }
        break;
      }

      case "system": {
        if (entry.subtype === "api_error") {
          const status = obj(entry.error)?.status;
          const errorKind = status === 429 ? "rate_limited" : "api_error";
          events.push({ kind: "api_error", turn, errorKind, final: false, at, line: lineNumber });
        } else if (entry.subtype === "compact_boundary") {
          events.push({ kind: "compaction", turn, at, line: lineNumber });
        }
        break;
      }

      case "attachment":
        break;

      default:
        if (!IGNORED_TYPES.has(type)) {
          // Only harness-style names are kept as keys, so a malformed entry can't carry text into the output.
          const key = ENTRY_TYPE.test(type) ? type : "(other)";
          unknownEntryTypes[key] = (unknownEntryTypes[key] ?? 0) + 1;
        }
    }
  }

  const spawnDepth = num(meta?.spawnDepth);
  const spawnToolUseId = str(meta?.toolUseId);
  const spawnedByCallId = spawnToolUseId === null ? null : hashId(HARNESS, "call", spawnToolUseId);
  const subagentId = agentId ?? fileAgentId ?? str(meta?.agentId);
  const rootId = sessionId === null ? null : hashId(HARNESS, "session", sessionId);

  let id: string;
  let parentId: string | null = null;
  let depth = 0;
  let orphan = false;
  if (!isSubagent()) {
    id = rootId ?? hashId(HARNESS, "session", basename(input.file, ".jsonl"));
  } else {
    depth = spawnDepth ?? 1;
    // Subagent entries carry the root session's id, which is the parent only one level down.
    // A deeper parent is resolved later by the archive, through the call that spawned this one.
    if (depth === 1) parentId = rootId;
    orphan = depth === 1 ? rootId === null : spawnedByCallId === null;
    id = hashId(HARNESS, "session", sessionId ?? "(unknown)", subagentId ?? basename(input.file, ".jsonl"));
  }

  return {
    session: {
      schemaVersion: SCHEMA_VERSION,
      kind: "session",
      id,
      harness: HARNESS,
      harnessVersion,
      parentId,
      depth,
      orphan,
      spawnedByCallId,
      startedAt,
      endedAt,
      source: { file: input.file },
      unknownEntryTypes,
      unparseableLines,
    },
    events,
  };
}

function classifyResult(block: Entry, entry: Entry): { outcome: ToolOutcome; errorKind: ErrorKind | null } {
  const error = (errorKind: ErrorKind) => ({ outcome: "error" as const, errorKind });

  // An explicit "it worked" wins: denial and interruption fields sit on the whole entry,
  // not on one result, so they can't override this result's own flag.
  if (block.is_error === false) return { outcome: "ok", errorKind: null };

  const text = messageText(block.content);
  // Claude Code files hook blocks as permission-rule denials; only the text says a hook did it.
  if (block.is_error === true && /^PreToolUse\S* hook/.test(text)) return error("hook_blocked");

  // Structured signals next: they don't depend on wording.
  const denial = str(entry.toolDenialKind);
  if (denial === "interrupted") return error("interrupted");
  if (denial === "user-rejected") return error("rejected_by_user");
  if (denial !== null && PERMISSION_DENIALS.has(denial)) return error("permission_denied");
  const structured = obj(entry.toolUseResult);
  if (structured?.interrupted === true) return error("interrupted");

  if (block.is_error === true) return error(/^Exit code \d+/.test(text) ? "nonzero_exit" : "other");
  // Claude Code sets the flag explicitly only for some tools; the rest omit it when they succeed
  // and return a structured result instead.
  if (structured !== null) return { outcome: "ok", errorKind: null };
  // No flag and no structured result: guessing "ok" could hide errors, so say we don't know.
  return { outcome: "unknown", errorKind: null };
}

function promptOrigin(entry: Entry, text: string, isSubagent: boolean): TurnOrigin {
  if (isSubagent) return "automated"; // a subagent's prompts are written by its parent agent
  const origin = str(entry.turnOrigin);
  if (origin !== null && AUTOMATED_TURN_ORIGINS.has(origin)) return "automated";
  if (origin === "human") return "human";
  const trimmed = text.trimStart();
  // A slash command the user typed arrives wrapped as <command-name>/...</command-name>.
  if (trimmed.startsWith("<command-")) return "human";
  // Older versions have no turnOrigin. Harness-injected prompts arrive wrapped in a tag,
  // e.g. <task-notification> or <scheduled-task>.
  return trimmed.startsWith("<") ? "automated" : "human";
}

/**
 * MCP tools are named `mcp__<server>__<tool>`. Some servers are registered under an id (a UUID),
 * which identifies an account's connector, so the id is replaced with a short hash.
 */
function redactToolName(tool: string): string {
  const match = MCP_TOOL_WITH_ID.exec(tool);
  if (match === null) return tool;
  const [, server = "", name = ""] = match;
  return `mcp__id-${hashId("mcp-server", server).slice(0, 8)}__${name}`;
}

function categorize(tool: string): ToolCategory {
  if (tool.startsWith("mcp__")) return "mcp";
  switch (tool) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "shell";
    case "Read":
    case "NotebookRead":
      return "read";
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "write";
    case "Glob":
    case "Grep":
    case "LS":
    case "ToolSearch":
      return "search";
    case "WebSearch":
    case "WebFetch":
      return "web";
    case "Agent":
    case "Task":
    case "SendMessage":
      return "agent";
    case "TodoWrite":
    case "EnterPlanMode":
    case "ExitPlanMode":
      return "plan";
    default:
      return "other";
  }
}

function toUsage(usage: Entry | null): Usage {
  return {
    inputUncached: num(usage?.input_tokens),
    cacheRead: num(usage?.cache_read_input_tokens),
    cacheWrite: num(usage?.cache_creation_input_tokens),
    output: num(usage?.output_tokens),
    reasoning: num(obj(usage?.output_tokens_details)?.thinking_tokens),
  };
}

function mergeUsage(known: Usage, next: Usage): Usage {
  return {
    inputUncached: next.inputUncached ?? known.inputUncached,
    cacheRead: next.cacheRead ?? known.cacheRead,
    cacheWrite: next.cacheWrite ?? known.cacheWrite,
    output: next.output ?? known.output,
    reasoning: next.reasoning ?? known.reasoning,
  };
}

/** Plain text of a message or tool result, whether stored as a string or as content blocks. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  return blocks(content)
    .map((block) => str(block.text) ?? "")
    .join("\n");
}

function blocks(content: unknown): Entry[] {
  return Array.isArray(content) ? content.filter((item): item is Entry => obj(item) !== null) : [];
}

function parseEntry(line: string): Entry | null {
  try {
    return obj(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Compares dotted numeric versions. Non-numeric parts (e.g. "-beta") are ignored, which is enough to pick the newest. */
function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const difference = (left[i] ?? 0) - (right[i] ?? 0);
    if (difference !== 0 && !Number.isNaN(difference)) return difference;
  }
  return 0;
}

function obj(value: unknown): Entry | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Entry) : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
