import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeClaudeCode } from "../../src/adapters/claude-code.js";
import { hashId } from "../../src/session/ids.js";
import type { ModelCallEvent, NormalizedSession, SessionEvent, ToolCallEvent } from "../../src/session/schema.js";

function fixture(name: string): string[] {
  const text = readFileSync(new URL(`../fixtures/claude-code/${name}`, import.meta.url), "utf8");
  return text.split("\n").filter((line) => line.length > 0);
}

function load(name: string, meta?: unknown): Promise<NormalizedSession> {
  return normalizeClaudeCode({ file: name, lines: fixture(name), meta });
}

const ofKind = <K extends SessionEvent["kind"]>(events: SessionEvent[], kind: K) =>
  events.filter((event): event is Extract<SessionEvent, { kind: K }> => event.kind === kind);

describe("Claude Code adapter: a basic session", () => {
  it("describes the session without storing raw ids", async () => {
    const { session } = await load("basic.jsonl");
    expect(session).toEqual({
      schemaVersion: 1,
      kind: "session",
      id: hashId("claude-code", "session", "sess-basic"),
      harness: "claude-code",
      harnessVersion: "2.1.301",
      parentId: null,
      depth: 0,
      orphan: false,
      spawnedByCallId: null,
      startedAt: "2026-11-01T10:00:00.000Z",
      endedAt: "2026-11-01T11:00:01.000Z",
      source: { file: "basic.jsonl" },
      unknownEntryTypes: { "some-future-type": 2 },
      unparseableLines: 1,
    });
  });

  it("emits events in transcript order", async () => {
    const { events } = await load("basic.jsonl");
    expect(events.map((event) => `${event.kind}@${event.line}`)).toEqual([
      "turn@2",
      "model_call@4",
      "tool_call@5",
      "model_call@7",
      "turn@13",
      "model_call@14",
    ]);
  });

  it("tells human prompts from automated ones", async () => {
    const turns = ofKind((await load("basic.jsonl")).events, "turn");
    expect(turns.map(({ index, origin }) => ({ index, origin }))).toEqual([
      { index: 0, origin: "human" },
      { index: 1, origin: "automated" },
    ]);
  });

  it("counts a split message once, using its final usage", async () => {
    const calls = ofKind((await load("basic.jsonl")).events, "model_call");
    expect(calls[0]).toMatchObject<Partial<ModelCallEvent>>({
      turn: 0,
      model: "claude-opus-5-5",
      usage: { inputUncached: 10, cacheRead: 1000, cacheWrite: 200, output: 40, reasoning: 12 },
    });
  });

  it("records missing token counts as null, never zero", async () => {
    const calls = ofKind((await load("basic.jsonl")).events, "model_call");
    expect(calls[1]?.usage.reasoning).toBeNull();
    expect(calls[2]).toMatchObject({
      turn: 1,
      model: "claude-sonnet-5-5",
      usage: { inputUncached: 3, cacheRead: null, cacheWrite: null, output: 4, reasoning: null },
    });
  });

  it("records a successful tool call with its category", async () => {
    const [call] = ofKind((await load("basic.jsonl")).events, "tool_call");
    expect(call).toEqual<ToolCallEvent>({
      kind: "tool_call",
      callId: hashId("claude-code", "call", "toolu_1"),
      turn: 0,
      tool: "Bash",
      category: "shell",
      outcome: "ok",
      errorKind: null,
      at: "2026-11-01T10:00:03.000Z",
      line: 5,
    });
  });
});

describe("Claude Code adapter: errors and interruptions", () => {
  it("classifies every way a tool call can end", async () => {
    const calls = ofKind((await load("errors.jsonl")).events, "tool_call");
    expect(calls.map(({ tool, category, outcome, errorKind }) => [tool, category, outcome, errorKind])).toEqual([
      ["Bash", "shell", "error", "nonzero_exit"],
      ["Write", "write", "error", "other"],
      ["Bash", "shell", "error", "rejected_by_user"],
      ["Edit", "write", "error", "permission_denied"],
      ["Bash", "shell", "error", "hook_blocked"],
      ["Read", "read", "unknown", null],
      ["Bash", "shell", "error", "interrupted"],
      ["mcp__github__create_issue", "mcp", "unknown", null],
    ]);
  });

  it("counts one model call for a message split across tool calls", async () => {
    const calls = ofKind((await load("errors.jsonl")).events, "model_call");
    expect(calls).toHaveLength(1);
  });

  it("records interruptions, API errors and compaction without starting new turns", async () => {
    const { events } = await load("errors.jsonl");
    expect(ofKind(events, "turn")).toHaveLength(1);
    expect(ofKind(events, "interruption")).toMatchObject([{ turn: 0, line: 17 }]);
    expect(ofKind(events, "api_error")).toMatchObject([
      { errorKind: "api_error", final: false, line: 18 },
      { errorKind: "rate_limited", final: true, line: 19 },
    ]);
    expect(ofKind(events, "compaction")).toMatchObject([{ turn: 0, line: 20 }]);
  });
});

describe("Claude Code adapter: subagents", () => {
  it("makes a subagent its own session linked to its parent", async () => {
    const { session, events } = await load("subagent.jsonl", { toolUseId: "toolu_spawn", spawnDepth: 1 });
    expect(session).toMatchObject({
      id: hashId("claude-code", "session", "sess-parent", "agent-abc"),
      parentId: hashId("claude-code", "session", "sess-parent"),
      depth: 1,
      spawnedByCallId: hashId("claude-code", "call", "toolu_spawn"),
    });
    expect(ofKind(events, "turn")).toMatchObject([{ origin: "automated" }]);
    expect(ofKind(events, "model_call").map((call) => call.usage.output)).toEqual([20, 60]);
  });

  it("leaves a nested subagent's parent unresolved for the archive to link", async () => {
    const { session } = await load("subagent.jsonl", { toolUseId: "toolu_spawn", spawnDepth: 2 });
    expect(session).toMatchObject({ parentId: null, depth: 2 });
  });

  it("still works without the subagent's meta file", async () => {
    const { session } = await load("subagent.jsonl");
    expect(session).toMatchObject({ depth: 1, spawnedByCallId: null });
  });
});

describe("Claude Code adapter: privacy", () => {
  it.each(["basic.jsonl", "errors.jsonl", "subagent.jsonl"])("keeps no private content from %s", async (name) => {
    const output = JSON.stringify(await load(name));
    for (const secret of ["SECRET", "/Users/alice", "secret-project", "secret-branch", "sess-", "toolu_", "agent-abc", "msg_"]) {
      expect(output).not.toContain(secret);
    }
  });
});

describe("Claude Code adapter: input", () => {
  it("reads lines from an async stream", async () => {
    async function* stream() {
      yield* fixture("basic.jsonl");
    }
    const { events } = await normalizeClaudeCode({ file: "basic.jsonl", lines: stream() });
    expect(events).toHaveLength(6);
  });

  it("falls back to the file name when no entry carries a session id", async () => {
    const { session } = await normalizeClaudeCode({ file: "/tmp/abc123.jsonl", lines: ["{broken"] });
    expect(session.id).toBe(hashId("claude-code", "session", "abc123"));
    expect(session.unparseableLines).toBe(1);
  });
});
