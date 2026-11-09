/**
 * The normalized session format (decision record 0001).
 *
 * Every adapter turns a harness transcript into these records; every detector reads only these.
 * Nothing here may hold message text, tool input or output, project file paths or account ids:
 * adapters redact while reading, so private content never reaches the archive.
 */

/** 2 added tool-call signal tags and the session's rules version (decision record 0003). Version 1 records stay readable. */
export const SCHEMA_VERSION = 2;

export type Harness = "claude-code" | "codex";

/** One harness session (one transcript). A subagent is its own session linked to its parent. */
export interface SessionRecord {
  schemaVersion: typeof SCHEMA_VERSION;
  kind: "session";
  /** Hashed, stable across re-runs. */
  id: string;
  harness: Harness;
  /** Newest harness version seen in the transcript. */
  harnessVersion: string | null;
  /** Hashed id of the session that spawned this one; null for a root session. */
  parentId: string | null;
  /** 0 for a root session, 1 for a subagent of a root, and so on. */
  depth: number;
  /** A subagent whose parent can't be resolved. */
  orphan: boolean;
  /** Hashed id of the tool call that spawned this subagent, used to resolve the parent. */
  spawnedByCallId: string | null;
  startedAt: string | null;
  endedAt: string | null;
  /** Pointer back to the original transcript for local drill-down. Never exported. */
  source: { file: string };
  /** Entry types the adapter didn't recognize, with counts. Growth here means the adapter is drifting. */
  unknownEntryTypes: Record<string, number>;
  /** Lines that weren't valid JSON. */
  unparseableLines: number;
  /** Version of the adapter's text rules that tagged this session's events; 0 for records written before tagging existed. */
  rulesVersion: number;
}

export type TurnOrigin = "human" | "automated";

/** Runs from one prompt to the final answer. */
export interface TurnEvent {
  kind: "turn";
  index: number;
  origin: TurnOrigin;
  at: string | null;
  line: number;
}

/** Token counts for one model call. `null` means the harness didn't record it, never zero. */
export interface Usage {
  inputUncached: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Includes reasoning. */
  output: number | null;
  /** The part of `output` spent on reasoning. */
  reasoning: number | null;
}

export interface ModelCallEvent {
  kind: "model_call";
  turn: number | null;
  model: string | null;
  usage: Usage;
  at: string | null;
  line: number;
}

export type ToolCategory = "shell" | "read" | "write" | "search" | "web" | "agent" | "mcp" | "plan" | "other";

export type ToolOutcome = "ok" | "error" | "unknown";

export type ErrorKind =
  | "nonzero_exit"
  | "rejected_by_user"
  | "permission_denied"
  | "hook_blocked"
  | "interrupted"
  | "api_error"
  | "rate_limited"
  | "other";

/** Signals that only a tool's error text reveals. Tagged at ingest; the text itself is never stored. */
export type TextSignal = "read-before-write" | "stale-file" | "file-not-found";

export interface ToolCallEvent {
  kind: "tool_call";
  /** Hashed tool-call id; links a subagent to the call that spawned it. */
  callId: string;
  turn: number | null;
  /** The harness's own tool name. MCP tools keep only the `mcp__<server>__<tool>` shape, never arguments. */
  tool: string;
  category: ToolCategory;
  outcome: ToolOutcome;
  /** Set only when outcome is "error". */
  errorKind: ErrorKind | null;
  signals: TextSignal[];
  at: string | null;
  line: number;
}

/** The user stopped the agent mid-turn. */
export interface InterruptionEvent {
  kind: "interruption";
  turn: number | null;
  at: string | null;
  line: number;
}

/** A failed model request. `final` is false when the harness retried. */
export interface ApiErrorEvent {
  kind: "api_error";
  turn: number | null;
  errorKind: "api_error" | "rate_limited";
  final: boolean;
  at: string | null;
  line: number;
}

/** The harness compacted the context window. */
export interface CompactionEvent {
  kind: "compaction";
  turn: number | null;
  at: string | null;
  line: number;
}

export type SessionEvent =
  | TurnEvent
  | ModelCallEvent
  | ToolCallEvent
  | InterruptionEvent
  | ApiErrorEvent
  | CompactionEvent;

export interface NormalizedSession {
  session: SessionRecord;
  /** In transcript order. */
  events: SessionEvent[];
}
