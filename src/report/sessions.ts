import type { NormalizedSession, SessionEvent, Usage } from "../session/schema.js";

/** One root session with everything its subagents did rolled up into it. */
export interface SessionSummary {
  id: string;
  startedAt: string | null;
  /** The root session's own turns; a subagent's prompts come from its parent agent. */
  turns: number;
  humanTurns: number;
  toolCalls: number;
  toolErrors: number;
  unknownOutcomes: number;
  /** Uncached input plus cache reads and writes. `null` when no model call recorded any. */
  tokensIn: number | null;
  tokensOut: number | null;
  /** Some model calls didn't record tokens, so the totals are lower bounds. */
  tokensPartial: boolean;
  subagents: number;
}

export interface ArchiveSummary {
  /** Newest first. */
  roots: SessionSummary[];
  /** Every archived session, whether or not it appears under a root. */
  totals: {
    sessions: number;
    subagents: number;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    unknownOutcomes: number;
  };
  /** Sessions that no root reaches (orphaned subagents, a parent that isn't archived, damaged links). */
  unattached: { sessions: number; toolCalls: number };
  /** Entry types the adapter didn't recognize, across the archive. Growth means the adapter is drifting. */
  unknownEntryTypes: Record<string, number>;
}

export function summarize(sessions: readonly NormalizedSession[]): ArchiveSummary {
  const children = new Map<string, NormalizedSession[]>();
  for (const entry of sessions) {
    const { parentId } = entry.session;
    if (parentId !== null) children.set(parentId, [...(children.get(parentId) ?? []), entry]);
  }

  const placed = new Set<string>();
  const roots = sessions
    .filter(({ session }) => session.depth === 0)
    .map((root) => summarizeTree(root, children, placed))
    .sort(byNewest);

  const totals = { sessions: sessions.length, subagents: 0, turns: 0, toolCalls: 0, toolErrors: 0, unknownOutcomes: 0 };
  const unattached = { sessions: 0, toolCalls: 0 };
  const unknownEntryTypes: Record<string, number> = {};
  for (const { session, events } of sessions) {
    const counts = countEvents(events);
    if (session.depth > 0) totals.subagents += 1;
    else totals.turns += counts.turns;
    totals.toolCalls += counts.toolCalls;
    totals.toolErrors += counts.toolErrors;
    totals.unknownOutcomes += counts.unknownOutcomes;
    if (!placed.has(session.id)) {
      unattached.sessions += 1;
      unattached.toolCalls += counts.toolCalls;
    }
    for (const [type, count] of Object.entries(session.unknownEntryTypes)) {
      unknownEntryTypes[type] = (unknownEntryTypes[type] ?? 0) + count;
    }
  }

  const sortedTypes = Object.fromEntries(Object.entries(unknownEntryTypes).sort(([a], [b]) => a.localeCompare(b)));
  return { roots, totals, unattached, unknownEntryTypes: sortedTypes };
}

function summarizeTree(root: NormalizedSession, children: ReadonlyMap<string, NormalizedSession[]>, placed: Set<string>): SessionSummary {
  const summary: SessionSummary = {
    id: root.session.id,
    startedAt: root.session.startedAt,
    turns: 0,
    humanTurns: 0,
    toolCalls: 0,
    toolErrors: 0,
    unknownOutcomes: 0,
    tokensIn: null,
    tokensOut: null,
    tokensPartial: false,
    subagents: 0,
  };

  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (placed.has(current.session.id)) continue; // guards against a parent loop in damaged data
    placed.add(current.session.id);
    if (current !== root) summary.subagents += 1;

    const counts = countEvents(current.events);
    // A subagent's prompts come from its parent agent, not from the user, so only the root's turns count.
    if (current === root) {
      summary.turns = counts.turns;
      summary.humanTurns = counts.humanTurns;
    }
    summary.toolCalls += counts.toolCalls;
    summary.toolErrors += counts.toolErrors;
    summary.unknownOutcomes += counts.unknownOutcomes;
    summary.tokensIn = add(summary.tokensIn, counts.tokensIn);
    summary.tokensOut = add(summary.tokensOut, counts.tokensOut);
    summary.tokensPartial ||= counts.unrecordedCalls > 0;
    pending.push(...(children.get(current.session.id) ?? []));
  }
  // Partial only matters next to a number; with nothing recorded the total is simply unknown.
  summary.tokensPartial &&= summary.tokensIn !== null || summary.tokensOut !== null;
  return summary;
}

function countEvents(events: readonly SessionEvent[]) {
  const counts = {
    turns: 0,
    humanTurns: 0,
    toolCalls: 0,
    toolErrors: 0,
    unknownOutcomes: 0,
    tokensIn: null as number | null,
    tokensOut: null as number | null,
    unrecordedCalls: 0,
  };
  for (const event of events) {
    if (event.kind === "turn") {
      counts.turns += 1;
      if (event.origin === "human") counts.humanTurns += 1;
    } else if (event.kind === "tool_call") {
      counts.toolCalls += 1;
      if (event.outcome === "error") counts.toolErrors += 1;
      if (event.outcome === "unknown") counts.unknownOutcomes += 1;
    } else if (event.kind === "model_call") {
      const input = inputTokens(event.usage);
      if (input === null || event.usage.output === null) counts.unrecordedCalls += 1;
      counts.tokensIn = add(counts.tokensIn, input);
      counts.tokensOut = add(counts.tokensOut, event.usage.output);
    }
  }
  return counts;
}

function inputTokens({ inputUncached, cacheRead, cacheWrite }: Usage): number | null {
  return add(add(inputUncached, cacheRead), cacheWrite);
}

/** Adds counts where `null` means "not recorded": it never turns a known total into zero, or an unknown one into a number. */
function add(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Newest first; unknown or unreadable start times last; ties broken by id so the order never depends on disk order. */
function byNewest(a: SessionSummary, b: SessionSummary): number {
  const time = (summary: SessionSummary) => (summary.startedAt === null ? NaN : Date.parse(summary.startedAt));
  const [left, right] = [time(a), time(b)];
  if (Number.isNaN(left) !== Number.isNaN(right)) return Number.isNaN(left) ? 1 : -1;
  if (!Number.isNaN(left) && left !== right) return right - left;
  return a.id.localeCompare(b.id);
}

const UNITS = [
  [1e3, "k"],
  [1e6, "M"],
  [1e9, "B"],
] as const;

/** Short human-readable counts: 950, 1.0k, 12k, 1.2M, 45M. Rounds first, so 999,500 reads 1.0M, not 1000k. */
export function formatCount(value: number | null): string {
  if (value === null) return "–";
  const rounded = Math.round(value);
  if (rounded < 1000) return rounded.toString();
  let result = "";
  for (const [size, suffix] of UNITS) {
    const scaled = rounded / size;
    const shown = scaled < 9.95 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
    result = shown < 10 ? `${shown.toFixed(1)}${suffix}` : `${shown}${suffix}`;
    if (shown < 1000) break; // otherwise the next unit reads better: 1.0M, not 1000k
  }
  return result;
}

export function renderSessions(summary: ArchiveSummary, limit: number, unreadable: readonly string[] = []): string {
  const shown = summary.roots.slice(0, limit);
  const header = ["Started", "Turns", "Tools", "Errors", "Unknown", "Tokens in", "Out", "Subagents"];
  const lowerBound = (value: number | null, partial: boolean) => `${partial && value !== null ? "≥" : ""}${formatCount(value)}`;
  const rows = shown.map((root) => [
    formatTime(root.startedAt),
    String(root.turns),
    String(root.toolCalls),
    String(root.toolErrors),
    percent(root.unknownOutcomes, root.toolCalls),
    lowerBound(root.tokensIn, root.tokensPartial),
    lowerBound(root.tokensOut, root.tokensPartial),
    String(root.subagents),
  ]);

  const lines = rows.length > 0 ? table(header, rows) : ["No sessions in the archive yet. Run `ambessa ingest` first."];
  const { totals, unattached } = summary;
  lines.push(
    "",
    `${plural(totals.sessions - totals.subagents, "session")} (+${plural(totals.subagents, "subagent")}) · ${plural(totals.turns, "turn")} · ` +
      `${plural(totals.toolCalls, "tool call")}: ${percent(totals.toolErrors, totals.toolCalls)} errors, ` +
      `${percent(totals.unknownOutcomes, totals.toolCalls)} unknown outcome`,
  );
  if (summary.roots.length > shown.length) {
    lines.push(`Showing the ${shown.length} newest of ${summary.roots.length} sessions. Use --limit to see more.`);
  }
  if (shown.some((root) => root.tokensPartial)) {
    lines.push("≥ some model calls didn't record tokens, so the true total is higher.");
  }
  if (unattached.sessions > 0) {
    const one = unattached.sessions === 1;
    lines.push(
      `${plural(unattached.sessions, "subagent")} ${one ? "isn't" : "aren't"} linked to a listed session; ` +
        `${one ? "its" : "their"} ${plural(unattached.toolCalls, "tool call")} count in the totals only.`,
    );
  }
  if (unreadable.length > 0) {
    const listed = unreadable.slice(0, 3).join(", ") + (unreadable.length > 3 ? ", …" : "");
    lines.push(`${plural(unreadable.length, "archived session")} couldn't be read: ${listed}`);
  }
  const drift = Object.entries(summary.unknownEntryTypes).map(([type, count]) => `${type} ${count}`);
  if (drift.length > 0) lines.push(`Unrecognized entry types (the adapter may need an update): ${drift.join(", ")}`);
  return lines.join("\n");
}

/** First column left-aligned, numbers right-aligned, two spaces between columns. */
function table(header: string[], rows: string[][]): string[] {
  const widths = header.map((title, column) => Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0)));
  const line = (cells: string[]) =>
    cells.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join("  ");
  return [line(header), ...rows.map(line)];
}

/** Local time, minutes precision. */
function formatTime(iso: string | null): string {
  const date = iso === null ? null : new Date(iso);
  if (date === null || Number.isNaN(date.getTime())) return "unknown";
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

/** Never rounds a real count away: 1 in 300 is "<1%", not "0%". */
function percent(part: number, whole: number): string {
  if (whole === 0) return "–";
  const value = Math.round((part / whole) * 100);
  if (value === 0 && part > 0) return "<1%";
  if (value === 100 && part < whole) return ">99%";
  return `${value}%`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}
