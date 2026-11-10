import { describe, expect, it } from "vitest";
import { formatCount, renderSessions, summarize } from "../../src/report/sessions.js";
import type { NormalizedSession, SessionEvent, SessionRecord, Usage } from "../../src/session/schema.js";

function session(id: string, overrides: Partial<SessionRecord> = {}, events: SessionEvent[] = []): NormalizedSession {
  return {
    session: {
      schemaVersion: 3,
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
      projectId: null,
      ...overrides,
    },
    events,
  };
}

const turn = (index: number, origin: "human" | "automated" = "human"): SessionEvent => ({ kind: "turn", index, origin, at: null, line: 1 });
const tool = (outcome: "ok" | "error" | "unknown"): SessionEvent => ({
  kind: "tool_call",
  callId: "c",
  turn: 0,
  tool: "Bash",
  category: "shell",
  outcome,
  errorKind: outcome === "error" ? "nonzero_exit" : null,
  signals: [],
  at: null,
  line: 1,
});
const usage = (values: Partial<Usage>): Usage => ({ inputUncached: null, cacheRead: null, cacheWrite: null, output: null, reasoning: null, ...values });
const call = (values: Partial<Usage>): SessionEvent => ({ kind: "model_call", turn: 0, model: "m", usage: usage(values), at: null, line: 1 });

describe("summarize", () => {
  it("rolls subagents, and their subagents, up into the root session", () => {
    const summary = summarize([
      session("root", {}, [turn(0), turn(1, "automated"), tool("ok"), tool("error"), call({ inputUncached: 10, cacheRead: 100, cacheWrite: 5, output: 20 })]),
      session("child", { parentId: "root", depth: 1 }, [turn(0, "automated"), tool("unknown"), call({ inputUncached: 1, output: 2 })]),
      session("grandchild", { parentId: "child", depth: 2 }, [tool("ok"), call({ output: 3 })]),
    ]);

    expect(summary.roots).toEqual([
      {
        id: "root",
        startedAt: "2026-11-01T10:00:00.000Z",
        turns: 2,
        humanTurns: 1,
        toolCalls: 4,
        toolErrors: 1,
        unknownOutcomes: 1,
        tokensIn: 116,
        tokensOut: 25,
        // the grandchild recorded output but not input
        tokensPartial: true,
        subagents: 2,
      },
    ]);
  });

  it("lists root sessions newest first, sessions without a start time last", () => {
    const summary = summarize([
      session("old", { startedAt: "2026-10-01T00:00:00.000Z" }),
      session("none", { startedAt: null }),
      session("new", { startedAt: "2026-11-05T00:00:00.000Z" }),
    ]);
    expect(summary.roots.map((root) => root.id)).toEqual(["new", "old", "none"]);
  });

  it("keeps tokens unknown when no model call recorded them, instead of reporting zero", () => {
    const [root] = summarize([session("root", {}, [call({})])]).roots;
    expect(root).toMatchObject({ tokensIn: null, tokensOut: null });
  });

  it("totals the whole archive, including orphans and unknown entry types", () => {
    const summary = summarize([
      session("a", { unknownEntryTypes: { "frame-link": 2 } }, [turn(0), tool("ok"), tool("unknown")]),
      session("b", { unknownEntryTypes: { "frame-link": 1, "dev-mods": 4 } }, [tool("error")]),
      session("lost", { depth: 2, orphan: true }, [tool("ok")]),
    ]);
    expect(summary.totals).toEqual({ sessions: 3, subagents: 1, turns: 1, toolCalls: 4, toolErrors: 1, unknownOutcomes: 1 });
    expect(summary.unattached).toEqual({ sessions: 1, toolCalls: 1 });
    expect(summary.unknownEntryTypes).toEqual({ "dev-mods": 4, "frame-link": 3 });
    expect(summary.roots.map((root) => root.id)).toEqual(["a", "b"]);
  });

  it("survives a parent loop without counting forever, and reports the sessions it couldn't place", () => {
    const summary = summarize([session("a", { parentId: "b", depth: 1 }, [tool("ok")]), session("b", { parentId: "a", depth: 1 })]);
    expect(summary.roots).toEqual([]);
    expect(summary.totals.sessions).toBe(2);
    expect(summary.unattached).toEqual({ sessions: 2, toolCalls: 1 });
  });

  it("marks a token total as partial when some model calls didn't record tokens", () => {
    const [root] = summarize([
      session("root", {}, [call({ inputUncached: 5, output: 10 })]),
      session("child", { parentId: "root", depth: 1 }, [call({})]),
    ]).roots;
    expect(root).toMatchObject({ tokensIn: 5, tokensOut: 10, tokensPartial: true });
  });

  it("orders sessions with the same or an unreadable start time predictably", () => {
    const summary = summarize([
      session("b", { startedAt: "2026-11-01T00:00:00.000Z" }),
      session("bad", { startedAt: "not a date" }),
      session("a", { startedAt: "2026-11-01T00:00:00.000Z" }),
    ]);
    expect(summary.roots.map((root) => root.id)).toEqual(["a", "b", "bad"]);
  });
});

describe("renderSessions: honest numbers", () => {
  it("shows a small but real error rate as <1%, not 0%", () => {
    const calls = [tool("error"), ...Array.from({ length: 299 }, () => tool("ok"))];
    const output = renderSessions(summarize([session("root", {}, calls)]), 20);
    expect(output).toContain("300 tool calls: <1% errors, 0% unknown outcome");
  });

  it("flags partial token totals and explains the mark", () => {
    const output = renderSessions(
      summarize([session("root", {}, [call({ inputUncached: 2_000_000, output: 5_000 }), call({})])]),
      20,
    );
    expect(output).toContain("≥2.0M");
    expect(output).toContain("≥5.0k");
    expect(output).toContain("≥ some model calls didn't record tokens, so the true total is higher.");
  });

  it("lists archived sessions it couldn't read instead of failing", () => {
    const output = renderSessions(summarize([session("root")]), 20, ["abc123", "def456"]);
    expect(output).toContain("2 archived sessions couldn't be read: abc123, def456");
  });

  it("prints an unknown time instead of NaN", () => {
    const output = renderSessions(summarize([session("root", { startedAt: "garbage" })]), 20);
    expect(output.split("\n")[1]).toMatch(/^unknown /);
  });
});

describe("formatCount", () => {
  it.each([
    [null, "–"],
    [0, "0"],
    [950, "950"],
    [1_000, "1.0k"],
    [12_345, "12k"],
    [310_000, "310k"],
    [1_234_567, "1.2M"],
    [45_200_000, "45M"],
    [2_300_000_000, "2.3B"],
    [9_949, "9.9k"],
    [9_950, "10k"],
    [9_999, "10k"],
    [999_499, "999k"],
    [999_500, "1.0M"],
    [999_999_999, "1.0B"],
    [1e9, "1.0B"],
  ])("formats %s as %s", (value, expected) => {
    expect(formatCount(value)).toBe(expected);
  });
});

describe("renderSessions", () => {
  it("prints an aligned table and a summary", () => {
    const summary = summarize([
      session("root", { startedAt: "2026-11-09T15:40:00.000Z" }, [turn(0), tool("ok"), tool("error"), tool("unknown"), tool("ok"), call({ inputUncached: 1_000_000, cacheRead: 2_000_000, output: 12_000 })]),
      session("child", { parentId: "root", depth: 1 }, []),
    ]);
    expect(renderSessions(summary, 20)).toBe(
      [
        "Started           Turns  Tools  Errors  Unknown  Tokens in  Out  Subagents",
        "2026-11-09 15:40      1      4       1      25%       3.0M  12k          1",
        "",
        "1 session (+1 subagent) · 1 turn · 4 tool calls: 25% errors, 25% unknown outcome",
      ].join("\n"),
    );
  });

  it("says how many sessions it left out and points out adapter drift", () => {
    const summary = summarize([
      session("a", { startedAt: "2026-11-02T00:00:00.000Z", unknownEntryTypes: { "frame-link": 15 } }),
      session("b", { startedAt: "2026-11-01T00:00:00.000Z" }),
      session("lost", { depth: 2, orphan: true }),
    ]);
    const lines = renderSessions(summary, 1).split("\n");
    expect(lines).toContain("Showing the 1 newest of 2 sessions. Use --limit to see more.");
    expect(lines).toContain("1 subagent isn't linked to a listed session; its 0 tool calls count in the totals only.");
    expect(lines).toContain("Unrecognized entry types (the adapter may need an update): frame-link 15");
  });
});
