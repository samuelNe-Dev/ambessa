import type { ErrorKind, NormalizedSession, SessionEvent, SessionRecord, TextSignal, ToolCategory, ToolOutcome, Usage } from "../../src/session/schema.js";

/** Builds an archived session with sensible defaults, for tests that start after ingest. */
export function session(id: string, overrides: Partial<SessionRecord> = {}, events: SessionEvent[] = []): NormalizedSession {
  return {
    session: {
      schemaVersion: 2,
      kind: "session",
      id,
      harness: "claude-code",
      harnessVersion: "2.1.300",
      parentId: null,
      depth: 0,
      orphan: false,
      spawnedByCallId: null,
      startedAt: "2026-11-01T10:00:00.000Z",
      endedAt: "2026-11-01T11:00:00.000Z",
      source: { file: "x.jsonl" },
      unknownEntryTypes: {},
      unparseableLines: 0,
      rulesVersion: 1,
      ...overrides,
    },
    events,
  };
}

export const turn = (index = 0, origin: "human" | "automated" = "human"): SessionEvent => ({ kind: "turn", index, origin, at: null, line: 1 });

export function tool(
  name: string,
  category: ToolCategory,
  outcome: ToolOutcome = "ok",
  errorKind: ErrorKind | null = outcome === "error" ? "other" : null,
  signals: TextSignal[] = [],
): SessionEvent {
  return { kind: "tool_call", callId: "c", turn: 0, tool: name, category, outcome, errorKind, signals, at: null, line: 1 };
}

export const usage = (values: Partial<Usage>): Usage => ({ inputUncached: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, ...values });

export const call = (values: Partial<Usage>): SessionEvent => ({ kind: "model_call", turn: 0, model: "m", usage: usage(values), at: null, line: 1 });

export const interruption = (): SessionEvent => ({ kind: "interruption", turn: 0, at: null, line: 1 });
export const compaction = (): SessionEvent => ({ kind: "compaction", turn: 0, at: null, line: 1 });
export const apiError = (rateLimited = false): SessionEvent => ({
  kind: "api_error",
  turn: 0,
  errorKind: rateLimited ? "rate_limited" : "api_error",
  final: true,
  at: null,
  line: 1,
});
