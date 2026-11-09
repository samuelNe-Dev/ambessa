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
  subagents: number;
}

export interface ArchiveSummary {
  /** Newest first. */
  roots: SessionSummary[];
  totals: {
    sessions: number;
    subagents: number;
    orphans: number;
    turns: number;
    toolCalls: number;
    toolErrors: number;
    unknownOutcomes: number;
  };
  /** Entry types the adapter didn't recognize, across the archive. Growth means the adapter is drifting. */
  unknownEntryTypes: Record<string, number>;
}

export function summarize(sessions: readonly NormalizedSession[]): ArchiveSummary {
  const children = new Map<string, NormalizedSession[]>();
  for (const entry of sessions) {
    const { parentId } = entry.session;
    if (parentId !== null) children.set(parentId, [...(children.get(parentId) ?? []), entry]);
  }

  const roots = sessions
    .filter(({ session }) => session.depth === 0)
    .map((root) => summarizeTree(root, children))
    .sort(byNewest);

  const totals = { sessions: sessions.length, subagents: 0, orphans: 0, turns: 0, toolCalls: 0, toolErrors: 0, unknownOutcomes: 0 };
  const unknownEntryTypes: Record<string, number> = {};
  for (const { session, events } of sessions) {
    if (session.depth > 0) totals.subagents += 1;
    if (session.orphan) totals.orphans += 1;
    const counts = countEvents(events);
    if (session.depth === 0) totals.turns += counts.turns;
    totals.toolCalls += counts.toolCalls;
    totals.toolErrors += counts.toolErrors;
    totals.unknownOutcomes += counts.unknownOutcomes;
    for (const [type, count] of Object.entries(session.unknownEntryTypes)) {
      unknownEntryTypes[type] = (unknownEntryTypes[type] ?? 0) + count;
    }
  }

  return { roots, totals, unknownEntryTypes: Object.fromEntries(Object.entries(unknownEntryTypes).sort(([a], [b]) => a.localeCompare(b))) };
}

function summarizeTree(root: NormalizedSession, children: ReadonlyMap<string, NormalizedSession[]>): SessionSummary {
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
    subagents: 0,
  };

  const seen = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current.session.id)) continue; // guards against a parent loop in damaged data
    seen.add(current.session.id);
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
    pending.push(...(children.get(current.session.id) ?? []));
  }
  return summary;
}

function countEvents(events: readonly SessionEvent[]) {
  const counts = { turns: 0, humanTurns: 0, toolCalls: 0, toolErrors: 0, unknownOutcomes: 0, tokensIn: null as number | null, tokensOut: null as number | null };
  for (const event of events) {
    if (event.kind === "turn") {
      counts.turns += 1;
      if (event.origin === "human") counts.humanTurns += 1;
    } else if (event.kind === "tool_call") {
      counts.toolCalls += 1;
      if (event.outcome === "error") counts.toolErrors += 1;
      if (event.outcome === "unknown") counts.unknownOutcomes += 1;
    } else if (event.kind === "model_call") {
      counts.tokensIn = add(counts.tokensIn, inputTokens(event.usage));
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

function byNewest(a: SessionSummary, b: SessionSummary): number {
  if (a.startedAt === null) return b.startedAt === null ? 0 : 1;
  if (b.startedAt === null) return -1;
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

/** Short human-readable counts: 950, 1.0k, 12k, 1.2M, 45M. */
export function formatCount(value: number | null): string {
  if (value === null) return "–";
  for (const [size, suffix] of [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ] as const) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled).toString()}${suffix}`;
    }
  }
  return Math.round(value).toString();
}

export function renderSessions(summary: ArchiveSummary, limit: number): string {
  const shown = summary.roots.slice(0, limit);
  const header = ["Started", "Turns", "Tools", "Errors", "Unknown", "Tokens in", "Out", "Subagents"];
  const rows = shown.map((root) => [
    formatTime(root.startedAt),
    String(root.turns),
    String(root.toolCalls),
    String(root.toolErrors),
    percent(root.unknownOutcomes, root.toolCalls),
    formatCount(root.tokensIn),
    formatCount(root.tokensOut),
    String(root.subagents),
  ]);

  const lines = rows.length > 0 ? table(header, rows) : ["No sessions in the archive yet. Run `ambessa ingest` first."];
  const { totals } = summary;
  const rootCount = totals.sessions - totals.subagents;
  lines.push(
    "",
    `${plural(rootCount, "session")} (+${plural(totals.subagents, "subagent")}) · ${plural(totals.turns, "turn")} · ` +
      `${plural(totals.toolCalls, "tool call")}: ${percent(totals.toolErrors, totals.toolCalls)} errors, ` +
      `${percent(totals.unknownOutcomes, totals.toolCalls)} unknown outcome`,
  );
  if (summary.roots.length > shown.length) {
    lines.push(`Showing the ${shown.length} newest of ${summary.roots.length} sessions. Use --limit to see more.`);
  }
  if (totals.orphans > 0) {
    lines.push(`${plural(totals.orphans, "subagent")} couldn't be linked to ${totals.orphans === 1 ? "its" : "their"} parent.`);
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

function formatTime(iso: string | null): string {
  if (iso === null) return "unknown";
  const date = new Date(iso);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`;
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}
