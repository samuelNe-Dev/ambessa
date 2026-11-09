import { formatCount } from "../report/sessions.js";
import type { NormalizedSession, SessionEvent, TextSignal, ToolCallEvent } from "../session/schema.js";

/**
 * Friction signals (decision record 0003). Each signal is a rate with its own natural unit, so a
 * long session doesn't look worse just for being long. Lower is always better.
 */

export type SignalId =
  | "tool-errors"
  | "nonzero-exit"
  | "retry-loops"
  | "blocked"
  | "interruptions"
  | "rejected-calls"
  | "tokens"
  | "compactions"
  | "api-errors"
  | TextSignal;

type Unit = "tool" | "shell" | "write" | "read" | "human-turn";

export interface SignalDefinition {
  id: SignalId;
  group: "Tool friction" | "Conversation" | "Cost and context" | "Text-tagged";
  unit: Unit;
}

export const SIGNALS: readonly SignalDefinition[] = [
  { id: "tool-errors", group: "Tool friction", unit: "tool" },
  { id: "nonzero-exit", group: "Tool friction", unit: "shell" },
  { id: "retry-loops", group: "Tool friction", unit: "tool" },
  { id: "blocked", group: "Tool friction", unit: "tool" },
  { id: "interruptions", group: "Conversation", unit: "human-turn" },
  { id: "rejected-calls", group: "Conversation", unit: "human-turn" },
  { id: "tokens", group: "Cost and context", unit: "human-turn" },
  { id: "compactions", group: "Cost and context", unit: "human-turn" },
  { id: "api-errors", group: "Cost and context", unit: "human-turn" },
  { id: "read-before-write", group: "Text-tagged", unit: "write" },
  { id: "stale-file", group: "Text-tagged", unit: "write" },
  { id: "file-not-found", group: "Text-tagged", unit: "read" },
];

const TEXT_SIGNALS = new Set<SignalId>(["read-before-write", "stale-file", "file-not-found"]);

/**
 * The agent's own tool failures. Rejections, interruptions and permission or hook blocks are
 * decisions by the user or their policy; each has its own signal, so no event counts twice.
 */
const AGENT_FAILURES = new Set(["nonzero_exit", "other"]);
const isAgentFailure = (call: ToolCallEvent) => call.outcome === "error" && call.errorKind !== null && AGENT_FAILURES.has(call.errorKind);

/** A trend needs this many qualifying sessions in each week. */
export const MIN_SESSIONS = 5;
/** A change beyond this (relative) is a trend. */
export const TREND_THRESHOLD = 0.2;

export interface Measurement {
  hits: number;
  /** The denominator: calls of the signal's kind, or human turns. */
  exposure: number;
  /** Root sessions that had any exposure. */
  sessions: number;
  /** Per 100 calls, or per human turn. `null` when nothing could have gone wrong. */
  rate: number | null;
}

export interface WindowMeasurement {
  from: Date;
  to: Date;
  /** Root sessions that started in the window. */
  sessions: number;
  measurements: Record<SignalId, Measurement>;
  /** Left out of per-human-turn signals: no human turns (scheduled or fully automated runs). */
  withoutHumanTurns: number;
  /** Left out of text-tagged signals: tagged by older rules. */
  olderRules: number;
}

/** Counts every signal over root sessions that started in [from, to), with their subagents rolled in. */
export function measure(sessions: readonly NormalizedSession[], window: { from: Date; to: Date }, rulesVersion: number): WindowMeasurement {
  const totals = Object.fromEntries(SIGNALS.map(({ id }) => [id, { hits: 0, exposure: 0, sessions: 0 }])) as Record<SignalId, Omit<Measurement, "rate">>;
  let rootCount = 0;
  let withoutHumanTurns = 0;
  let olderRules = 0;

  for (const tree of trees(sessions)) {
    const startedAt = tree[0]!.session.startedAt;
    const started = startedAt === null ? NaN : Date.parse(startedAt);
    if (Number.isNaN(started) || started < window.from.getTime() || started >= window.to.getTime()) continue;
    rootCount += 1;

    const counts = countTree(tree);
    const textComparable = tree.every(({ session }) => session.rulesVersion === rulesVersion);
    if (counts.exposure["human-turn"] === 0) withoutHumanTurns += 1;
    if (!textComparable) olderRules += 1;

    for (const { id, unit } of SIGNALS) {
      if (TEXT_SIGNALS.has(id) && !textComparable) continue;
      const exposure = counts.exposure[unit];
      if (exposure === 0) continue;
      const total = totals[id];
      total.hits += counts.hits[id];
      total.exposure += exposure;
      total.sessions += 1;
    }
  }

  const measurements = Object.fromEntries(
    SIGNALS.map(({ id, unit }) => {
      const { hits, exposure, sessions: count } = totals[id];
      const rate = exposure === 0 ? null : (hits / exposure) * (unit === "human-turn" ? 1 : 100);
      return [id, { hits, exposure, sessions: count, rate }];
    }),
  ) as Record<SignalId, Measurement>;

  return { from: window.from, to: window.to, sessions: rootCount, measurements, withoutHumanTurns, olderRules };
}

/** Root sessions, each followed by every subagent below it. */
function trees(sessions: readonly NormalizedSession[]): NormalizedSession[][] {
  const children = new Map<string, NormalizedSession[]>();
  for (const entry of sessions) {
    const { parentId } = entry.session;
    if (parentId !== null) children.set(parentId, [...(children.get(parentId) ?? []), entry]);
  }
  return sessions
    .filter(({ session }) => session.depth === 0)
    .map((root) => {
      const tree: NormalizedSession[] = [];
      const seen = new Set<string>();
      const pending = [root];
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (seen.has(current.session.id)) continue; // guards against a parent loop in damaged data
        seen.add(current.session.id);
        tree.push(current);
        pending.push(...(children.get(current.session.id) ?? []));
      }
      return tree;
    });
}

function countTree(tree: readonly NormalizedSession[]) {
  const exposure: Record<Unit, number> = { tool: 0, shell: 0, write: 0, read: 0, "human-turn": 0 };
  const hits = Object.fromEntries(SIGNALS.map(({ id }) => [id, 0])) as Record<SignalId, number>;

  tree.forEach(({ events }, index) => {
    const isRoot = index === 0;
    const toolCalls: ToolCallEvent[] = [];
    for (const event of events) {
      countEvent(event, isRoot, exposure, hits);
      if (event.kind === "tool_call") toolCalls.push(event);
    }
    hits["retry-loops"] += retryLoops(toolCalls);
  });
  return { exposure, hits };
}

function countEvent(event: SessionEvent, isRoot: boolean, exposure: Record<Unit, number>, hits: Record<SignalId, number>): void {
  switch (event.kind) {
    case "turn":
      // A subagent's prompts come from its parent agent, not from the user.
      if (isRoot && event.origin === "human") exposure["human-turn"] += 1;
      break;
    case "tool_call":
      exposure.tool += 1;
      if (event.category === "shell") exposure.shell += 1;
      if (event.category === "write") exposure.write += 1;
      if (event.category === "read") exposure.read += 1;
      if (isAgentFailure(event)) hits["tool-errors"] += 1;
      if (event.errorKind === "nonzero_exit" && event.category === "shell") hits["nonzero-exit"] += 1;
      if (event.errorKind === "permission_denied" || event.errorKind === "hook_blocked") hits.blocked += 1;
      if (event.errorKind === "rejected_by_user") hits["rejected-calls"] += 1;
      // Stopping a running tool is an interruption too; the adapter doesn't also emit a separate one.
      if (event.errorKind === "interrupted") hits.interruptions += 1;
      for (const signal of event.signals) hits[signal] += 1;
      break;
    case "interruption":
      hits.interruptions += 1;
      break;
    case "compaction":
      hits.compactions += 1;
      break;
    case "api_error":
      hits["api-errors"] += 1;
      break;
    case "model_call": {
      // An unrecorded count adds nothing here, so a session with unrecorded calls reads low.
      // None appear in real Claude Code data so far; `ambessa sessions` marks such totals with ≥.
      const { inputUncached, cacheRead, cacheWrite, output } = event.usage;
      hits.tokens += (inputUncached ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (output ?? 0);
      break;
    }
  }
}

/**
 * Runs of the same tool failing two or more times in a row within one turn, each run counted once.
 * Only the agent's own failures count: a rejection, a block or a new prompt breaks the run.
 */
function retryLoops(calls: readonly ToolCallEvent[]): number {
  let loops = 0;
  let inLoop = false;
  for (let index = 1; index < calls.length; index += 1) {
    const [previous, current] = [calls[index - 1]!, calls[index]!];
    const repeatedFailure =
      isAgentFailure(previous) && isAgentFailure(current) && previous.tool === current.tool && previous.turn === current.turn;
    if (repeatedFailure && !inLoop) loops += 1;
    inLoop = repeatedFailure;
  }
  return loops;
}

export type Trend = "up" | "down" | "flat" | "new" | "too few sessions";

export interface SignalComparison {
  signal: SignalDefinition;
  last: Measurement;
  current: Measurement;
  trend: Trend;
}

export interface WeekComparison {
  current: WindowMeasurement;
  last: WindowMeasurement;
  rows: SignalComparison[];
}

const DAY = 24 * 60 * 60 * 1000;

/** The last 7 days against the 7 days before them: the before/after shape grading will use. */
export function compareWeeks(sessions: readonly NormalizedSession[], now: Date, rulesVersion: number): WeekComparison {
  const weekAgo = new Date(now.getTime() - 7 * DAY);
  const current = measure(sessions, { from: weekAgo, to: now }, rulesVersion);
  const last = measure(sessions, { from: new Date(now.getTime() - 14 * DAY), to: weekAgo }, rulesVersion);
  const rows = SIGNALS.map((signal) => {
    const [before, after] = [last.measurements[signal.id], current.measurements[signal.id]];
    return { signal, last: before, current: after, trend: trend(before, after) };
  });
  return { current, last, rows };
}

function trend(before: Measurement, after: Measurement): Trend {
  if (before.sessions < MIN_SESSIONS || after.sessions < MIN_SESSIONS || before.rate === null || after.rate === null) {
    return "too few sessions";
  }
  if (before.rate === 0) return after.rate === 0 ? "flat" : "new";
  const change = (after.rate - before.rate) / before.rate;
  if (change > TREND_THRESHOLD) return "up";
  if (change < -TREND_THRESHOLD) return "down";
  return "flat";
}

const UNIT_LABELS: Record<Unit, string> = {
  tool: "per 100 tool calls",
  shell: "per 100 shell calls",
  write: "per 100 write calls",
  read: "per 100 read calls",
  "human-turn": "per human turn",
};

export function renderSignals({ current, last, rows }: WeekComparison): string {
  const lines = [
    `This week: ${day(current.from)} → ${day(current.to)}, ${plural(current.sessions, "session")} · ` +
      `last week: ${day(last.from)} → ${day(last.to)}, ${plural(last.sessions, "session")}`,
    "",
  ];

  const table: string[][] = [["Signal", "", "Last week", "This week", "Trend"]];
  const groupRows = new Set<number>();
  let group = "";
  for (const { signal, last: before, current: after, trend: direction } of rows) {
    if (signal.group !== group) {
      group = signal.group;
      groupRows.add(table.length);
      table.push([group, "", "", "", ""]);
    }
    table.push([`  ${signal.id}`, UNIT_LABELS[signal.unit], formatRate(signal, before.rate), formatRate(signal, after.rate), describe(direction)]);
  }
  const widths = table[0]!.map((_, column) => Math.max(...table.map((row) => row[column]!.length)));
  table.forEach((row, index) => {
    if (groupRows.has(index)) {
      lines.push(row[0]!);
      return;
    }
    const cells = row.map((cell, column) => (column === 2 || column === 3 ? cell.padStart(widths[column]!) : cell.padEnd(widths[column]!)));
    lines.push(cells.join("  ").trimEnd());
  });

  lines.push("");
  const withoutHumanTurns = current.withoutHumanTurns + last.withoutHumanTurns;
  if (withoutHumanTurns > 0) {
    lines.push(`${plural(withoutHumanTurns, "session")} with no human turns ${withoutHumanTurns === 1 ? "is" : "are"} left out of per-human-turn signals.`);
  }
  const olderRules = current.olderRules + last.olderRules;
  if (olderRules > 0) {
    lines.push(
      `${plural(olderRules, "session")} tagged by older rules ${olderRules === 1 ? "is" : "are"} left out of text-tagged signals. ` +
        "`ambessa ingest` re-tags them while their transcript is still on disk.",
    );
  }
  lines.push(`A trend needs ${MIN_SESSIONS} sessions in each week; up or down means a change of more than ${TREND_THRESHOLD * 100}%.`);
  return lines.join("\n");
}

function describe(direction: Trend): string {
  // Every signal counts friction or cost, so lower is always better.
  if (direction === "up") return "up (worse)";
  if (direction === "down") return "down (better)";
  return direction;
}

function formatRate(signal: SignalDefinition, rate: number | null): string {
  if (rate === null) return "–";
  if (signal.id === "tokens") return formatCount(rate);
  if (Number.isInteger(rate)) return String(rate);
  // A real but tiny rate must not read as zero.
  if (rate < 0.005) return "<0.01";
  return rate < 1 ? rate.toFixed(2) : rate.toFixed(1);
}

function day(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}
