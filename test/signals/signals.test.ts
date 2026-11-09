import { describe, expect, it } from "vitest";
import { compareWeeks, measure, renderSignals, SIGNALS } from "../../src/signals/signals.js";
import { apiError, call, compaction, interruption, session, tool, turn } from "../helpers/sessions.js";

const RULES = 1;
const window = { from: new Date("2026-11-01T00:00:00Z"), to: new Date("2026-11-08T00:00:00Z") };
const at = (day: number) => `2026-11-${String(day).padStart(2, "0")}T12:00:00.000Z`;

describe("measure", () => {
  it("counts tool friction per 100 calls of the right kind", () => {
    const { measurements } = measure(
      [
        session("a", { startedAt: at(2) }, [
          turn(),
          tool("Bash", "shell", "error", "nonzero_exit"),
          tool("Bash", "shell", "ok"),
          tool("Read", "read", "ok"),
          tool("Edit", "write", "error", "permission_denied"),
        ]),
      ],
      window,
      RULES,
    );
    expect(measurements["tool-errors"]).toEqual({ hits: 2, exposure: 4, sessions: 1, rate: 50 });
    expect(measurements["nonzero-exit"]).toEqual({ hits: 1, exposure: 2, sessions: 1, rate: 50 });
    expect(measurements.blocked).toEqual({ hits: 1, exposure: 4, sessions: 1, rate: 25 });
  });

  it("counts a run of the same tool failing in a row once, per session", () => {
    const failing = () => tool("Bash", "shell", "error", "nonzero_exit");
    const { measurements } = measure(
      [
        session("a", { startedAt: at(2) }, [failing(), failing(), failing(), tool("Bash", "shell"), failing(), tool("Read", "read", "error"), failing(), failing()]),
        // A subagent's run is its own; it doesn't join the parent's last failure.
        session("child", { parentId: "a", depth: 1 }, [failing(), tool("Read", "read")]),
      ],
      window,
      RULES,
    );
    expect(measurements["retry-loops"]).toMatchObject({ hits: 2, exposure: 10 });
  });

  it("measures conversation, cost and context per human turn, with subagents rolled in", () => {
    const { measurements } = measure(
      [
        session("a", { startedAt: at(3) }, [
          turn(0),
          turn(1),
          turn(2, "automated"),
          interruption(),
          tool("Bash", "shell", "error", "rejected_by_user"),
          compaction(),
          apiError(),
          call({ inputUncached: 100, cacheRead: 900, output: 50 }),
        ]),
        session("child", { parentId: "a", depth: 1 }, [turn(0, "automated"), apiError(true), call({ inputUncached: 10, output: 40 })]),
      ],
      window,
      RULES,
    );
    expect(measurements.interruptions).toEqual({ hits: 1, exposure: 2, sessions: 1, rate: 0.5 });
    expect(measurements["rejected-calls"]).toMatchObject({ hits: 1, rate: 0.5 });
    expect(measurements.compactions).toMatchObject({ hits: 1, rate: 0.5 });
    expect(measurements["api-errors"]).toMatchObject({ hits: 2, rate: 1 });
    expect(measurements.tokens).toMatchObject({ hits: 1100, exposure: 2, rate: 550 });
  });

  it("leaves sessions without human turns out of per-human-turn signals and says how many", () => {
    const result = measure(
      [
        session("human", { startedAt: at(2) }, [turn(), interruption(), tool("Bash", "shell")]),
        session("scheduled", { startedAt: at(3) }, [turn(0, "automated"), interruption(), interruption(), tool("Bash", "shell", "error")]),
      ],
      window,
      RULES,
    );
    expect(result.measurements.interruptions).toEqual({ hits: 1, exposure: 1, sessions: 1, rate: 1 });
    expect(result.measurements["tool-errors"]).toMatchObject({ hits: 1, exposure: 2, sessions: 2 });
    expect(result.withoutHumanTurns).toBe(1);
  });

  it("counts text-tagged signals only in sessions tagged by the current rules", () => {
    const result = measure(
      [
        session("current", { startedAt: at(2) }, [
          tool("Write", "write", "error", "other", ["read-before-write"]),
          tool("Edit", "write", "error", "other", ["stale-file"]),
          tool("Write", "write"),
          tool("Write", "write"),
          tool("Read", "read", "error", "other", ["file-not-found"]),
        ]),
        session("older", { startedAt: at(3), rulesVersion: 0 }, [tool("Write", "write", "error"), tool("Read", "read")]),
      ],
      window,
      RULES,
    );
    expect(result.measurements["read-before-write"]).toEqual({ hits: 1, exposure: 4, sessions: 1, rate: 25 });
    expect(result.measurements["stale-file"]).toMatchObject({ hits: 1, exposure: 4 });
    expect(result.measurements["file-not-found"]).toEqual({ hits: 1, exposure: 1, sessions: 1, rate: 100 });
    expect(result.olderRules).toBe(1);
    // Structured signals still use every session.
    expect(result.measurements["tool-errors"]).toMatchObject({ exposure: 7 });
  });

  it("only counts root sessions that started inside the window", () => {
    const result = measure(
      [
        session("before", { startedAt: "2026-10-31T23:59:59.000Z" }, [tool("Bash", "shell")]),
        session("inside", { startedAt: "2026-11-01T00:00:00.000Z" }, [tool("Bash", "shell")]),
        session("at-end", { startedAt: "2026-11-08T00:00:00.000Z" }, [tool("Bash", "shell")]),
        session("no-start", { startedAt: null }, [tool("Bash", "shell")]),
      ],
      window,
      RULES,
    );
    expect(result.sessions).toBe(1);
    expect(result.measurements["tool-errors"]).toMatchObject({ exposure: 1 });
  });

  it("reports no rate when nothing could have gone wrong", () => {
    const { measurements } = measure([session("a", { startedAt: at(2) }, [turn()])], window, RULES);
    expect(measurements["tool-errors"]).toEqual({ hits: 0, exposure: 0, sessions: 0, rate: null });
  });

  it("covers every signal in the decision record", () => {
    expect(SIGNALS.map((signal) => signal.id)).toEqual([
      "tool-errors",
      "nonzero-exit",
      "retry-loops",
      "blocked",
      "interruptions",
      "rejected-calls",
      "tokens",
      "compactions",
      "api-errors",
      "read-before-write",
      "stale-file",
      "file-not-found",
    ]);
  });
});

describe("compareWeeks", () => {
  const now = new Date("2026-11-15T00:00:00Z");
  /** n sessions on a day, each with `errors` failed calls out of 10. */
  const week = (day: number, n: number, errors: number) =>
    Array.from({ length: n }, (_, index) =>
      session(`d${day}-${index}`, { startedAt: at(day) }, [
        turn(),
        ...Array.from({ length: 10 }, (_, call) => tool("Bash", "shell", call < errors ? "error" : "ok", call < errors ? "nonzero_exit" : null)),
      ]),
    );
  const trendOf = (sessions: ReturnType<typeof week>, id: string) => compareWeeks(sessions, now, RULES).rows.find((row) => row.signal.id === id)?.trend;

  it("compares the last 7 days with the 7 before", () => {
    const comparison = compareWeeks([...week(3, 5, 2), ...week(10, 5, 4)], now, RULES);
    const row = comparison.rows.find((candidate) => candidate.signal.id === "tool-errors");
    expect(row).toMatchObject({ last: { rate: 20 }, current: { rate: 40 }, trend: "up" });
    expect(comparison.current.sessions).toBe(5);
    expect(comparison.last.sessions).toBe(5);
  });

  it("calls a change of 20% or less flat", () => {
    expect(trendOf([...week(3, 5, 5), ...week(10, 5, 4)], "tool-errors")).toBe("down");
    expect(trendOf([...week(3, 5, 5), ...week(10, 5, 6)], "tool-errors")).toBe("flat");
  });

  it("calls a signal new when it was zero last week, and flat when it stays zero", () => {
    expect(trendOf([...week(3, 5, 0), ...week(10, 5, 1)], "tool-errors")).toBe("new");
    expect(trendOf([...week(3, 5, 0), ...week(10, 5, 0)], "tool-errors")).toBe("flat");
  });

  it("refuses a trend with fewer than 5 qualifying sessions in either week", () => {
    expect(trendOf([...week(3, 4, 1), ...week(10, 5, 4)], "tool-errors")).toBe("too few sessions");
  });
});

describe("renderSignals", () => {
  it("prints both weeks, grouped signals and what was left out", () => {
    const now = new Date("2026-11-15T00:00:00Z");
    const sessions = [
      ...Array.from({ length: 5 }, (_, index) => session(`l${index}`, { startedAt: at(3) }, [turn(), tool("Bash", "shell", "error", "nonzero_exit"), tool("Bash", "shell"), call({ inputUncached: 1000, output: 500 })])),
      ...Array.from({ length: 5 }, (_, index) => session(`c${index}`, { startedAt: at(10) }, [turn(), tool("Bash", "shell"), tool("Bash", "shell"), call({ inputUncached: 1000, output: 500 })])),
      session("auto", { startedAt: at(11) }, [turn(0, "automated")]),
      session("old", { startedAt: at(12), rulesVersion: 0 }, [turn()]),
    ];
    const output = renderSignals(compareWeeks(sessions, now, RULES));
    const lines = output.split("\n");

    expect(lines[0]).toBe("This week: 2026-11-08 → 2026-11-15, 7 sessions · last week: 2026-11-01 → 2026-11-08, 5 sessions");
    expect(output).toMatch(/Tool friction\n {2}tool-errors +per 100 tool calls +50 +0 +down \(better\)/);
    expect(output).toMatch(/ {2}tokens +per human turn +1\.5k +1\.5k +flat/);
    expect(output).toMatch(/ {2}interruptions +per human turn +0 +0 +flat/);
    expect(output).toMatch(/ {2}read-before-write +per 100 write calls +– +– +too few sessions/);
    expect(output).toContain("1 session with no human turns is left out of per-human-turn signals.");
    expect(output).toContain("1 session tagged by older rules is left out of text-tagged signals. Run `ambessa ingest` to re-tag what's still on disk.");
    expect(output).toContain("A trend needs 5 sessions in each week; up or down means a change of more than 20%.");
  });
});
