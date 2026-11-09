import { createReadStream, type Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { CLAUDE_CODE_RULES_VERSION, normalizeClaudeCode } from "../adapters/claude-code.js";
import type { NormalizedSession } from "../session/schema.js";
import {
  acquireLock,
  deleteSession,
  loadState,
  readSession,
  readSessionRecord,
  saveState,
  writeSession,
  type ArchiveState,
} from "./archive.js";

export interface IngestResult {
  /** False when the source folder doesn't exist. */
  sourceFound: boolean;
  added: number;
  updated: number;
  unchanged: number;
  failures: { file: string; reason: string }[];
  /** Nested subagents linked to their parent during this run. */
  linked: number;
  /** Nested subagents whose parent isn't in the archive (yet). */
  orphaned: number;
}

/** Folders inside a Claude Code project directory that hold no transcripts. */
const SKIPPED_DIRECTORIES = new Set(["tool-results", "memory"]);
/** Progress is saved this often, so an interrupted first run doesn't start over. */
const SAVE_EVERY = 50;

export function defaultClaudeCodeSource(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
}

/**
 * Normalizes every new or changed Claude Code transcript under `source` into the archive.
 * A transcript is skipped when neither it nor its subagent meta file changed size or modification
 * time since the last run. Archived sessions are kept when their transcript disappears.
 */
export async function ingestClaudeCode(root: string, source: string): Promise<IngestResult> {
  const release = await acquireLock(root);
  try {
    const state = await loadState(root);
    const result: IngestResult = { sourceFound: true, added: 0, updated: 0, unchanged: 0, failures: [], linked: 0, orphaned: 0 };
    const files = await transcripts(source);
    if (files === null) return { ...result, sourceFound: false };

    let processed = 0;
    for (const file of files) {
      try {
        const metaFile = metaPath(file);
        const [transcriptStats, metaStats] = await Promise.all([stat(file), statIfExists(metaFile)]);
        const known = state.sources[file];
        if (
          known !== undefined &&
          known.size === transcriptStats.size &&
          known.mtimeMs === transcriptStats.mtimeMs &&
          known.metaMtimeMs === (metaStats?.mtimeMs ?? null) &&
          known.rulesVersion === CLAUDE_CODE_RULES_VERSION
        ) {
          result.unchanged += 1;
          continue;
        }

        // Read the meta file before opening the transcript: a line reader that is left waiting on
        // another await can finish and close before anyone iterates it, and then hangs forever.
        const meta = metaStats === null ? undefined : JSON.parse(await readFile(metaFile, "utf8"));
        const normalized = await normalizeClaudeCode({ file, lines: readLines(file), meta });
        await writeSession(root, normalized);
        if (known !== undefined && known.sessionId !== normalized.session.id) await dropIfUnused(root, state, known.sessionId, file);
        remember(state, file, transcriptStats, metaStats, normalized);

        if (known === undefined) result.added += 1;
        else result.updated += 1;
        processed += 1;
        if (processed % SAVE_EVERY === 0) await saveState(root, state);
      } catch (error) {
        // One unreadable transcript must not stop the rest; it's retried on the next run.
        result.failures.push({ file, reason: (error as Error).message });
      }
    }

    Object.assign(result, await linkNestedSubagents(root, state));
    await saveState(root, state);
    return result;
  } finally {
    await release();
  }
}

/** Records what ingest needs next time: the file's fingerprint, the agent calls it made, and whether it waits for a parent. */
function remember(state: ArchiveState, file: string, transcript: Stats, meta: Stats | null, { session, events }: NormalizedSession): void {
  state.sources[file] = {
    size: transcript.size,
    mtimeMs: transcript.mtimeMs,
    metaMtimeMs: meta?.mtimeMs ?? null,
    harness: session.harness,
    sessionId: session.id,
    rulesVersion: session.rulesVersion,
  };

  for (const event of events) {
    if (event.kind !== "tool_call" || event.category !== "agent") continue;
    // A resumed session copies earlier history, tool calls included. The original session,
    // the one that started first, is the real spawner.
    const known = state.spawners[event.callId];
    if (known === undefined || known.sessionId === session.id || isEarlier(session.startedAt, known.startedAt)) {
      state.spawners[event.callId] = { sessionId: session.id, startedAt: session.startedAt };
    }
  }

  const waiting = new Set(state.unlinked);
  if (session.depth > 1 && session.parentId === null) waiting.add(session.id);
  else waiting.delete(session.id);
  state.unlinked = [...waiting];
}

/**
 * The adapter can only name the parent of a first-level subagent. A deeper one records the tool
 * call that spawned it; the archive remembers which session made each agent call.
 */
async function linkNestedSubagents(root: string, state: ArchiveState): Promise<Pick<IngestResult, "linked" | "orphaned">> {
  let linked = 0;
  let orphaned = 0;
  const stillWaiting: string[] = [];

  for (const id of state.unlinked) {
    const session = await readSessionRecord(root, "claude-code", id).catch(() => null);
    if (session === null) continue;
    const spawner = session.spawnedByCallId === null ? undefined : state.spawners[session.spawnedByCallId];
    const parentId = spawner === undefined || spawner.sessionId === id ? null : spawner.sessionId;

    if (parentId === null) {
      orphaned += 1;
      stillWaiting.push(id);
      if (session.orphan) continue;
    } else {
      linked += 1;
    }
    const full = await readSession(root, "claude-code", id);
    await writeSession(root, { ...full, session: { ...full.session, parentId, orphan: parentId === null } });
  }

  state.unlinked = stillWaiting;
  return { linked, orphaned };
}

/** Removes an archived session that no transcript produces any more, e.g. after a transcript's session id changed. */
async function dropIfUnused(root: string, state: ArchiveState, sessionId: string, changedFile: string): Promise<void> {
  const stillUsed = Object.entries(state.sources).some(([file, source]) => file !== changedFile && source.sessionId === sessionId);
  if (stillUsed) return;
  await deleteSession(root, "claude-code", sessionId);
  state.unlinked = state.unlinked.filter((id) => id !== sessionId);
}

/** Every transcript under the source folder, or null if the folder doesn't exist. */
async function transcripts(source: string): Promise<string[] | null> {
  const found: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !SKIPPED_DIRECTORIES.has(entry.name)) await walk(path);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
    }
  }
  try {
    await walk(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && found.length === 0) return null;
    throw error;
  }
  return found.sort();
}

/** A subagent's `agent-<id>.meta.json` sits next to its `agent-<id>.jsonl`. */
function metaPath(file: string): string {
  return file.replace(/\.jsonl$/, ".meta.json");
}

async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function readLines(file: string): AsyncIterable<string> {
  return createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
}

function isEarlier(a: string | null, b: string | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return Date.parse(a) < Date.parse(b);
}
