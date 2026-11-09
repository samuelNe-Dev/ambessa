import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { normalizeClaudeCode } from "../adapters/claude-code.js";
import type { NormalizedSession } from "../session/schema.js";
import { listSessionIds, loadState, readSession, readSessionRecord, saveState, writeSession } from "./archive.js";

export interface IngestResult {
  added: number;
  updated: number;
  unchanged: number;
  failed: number;
  /** Nested subagents whose parent was linked during this run. */
  linked: number;
  /** Nested subagents whose parent couldn't be found in the archive. */
  orphaned: number;
}

/** Folders inside a Claude Code project directory that hold no transcripts. */
const SKIPPED_DIRECTORIES = new Set(["tool-results", "memory"]);

export function defaultClaudeCodeSource(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return join(env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), "projects");
}

/**
 * Normalizes every new or changed Claude Code transcript under `source` into the archive.
 * A transcript that hasn't changed size or modification time since the last run is skipped.
 * Archived sessions are kept when their transcript disappears.
 */
export async function ingestClaudeCode(root: string, source: string): Promise<IngestResult> {
  const state = await loadState(root);
  const result: IngestResult = { added: 0, updated: 0, unchanged: 0, failed: 0, linked: 0, orphaned: 0 };

  for (const file of await transcripts(source)) {
    try {
      const { size, mtimeMs } = await stat(file);
      const known = state.sources[file];
      if (known !== undefined && known.size === size && known.mtimeMs === mtimeMs) {
        result.unchanged += 1;
        continue;
      }
      // Read the meta file before opening the transcript: a line reader that is left waiting on
      // another await can finish and close before anyone iterates it, and then hangs forever.
      const meta = await readMeta(file);
      const normalized = await normalizeClaudeCode({ file, lines: readLines(file), meta });
      await writeSession(root, normalized);
      state.sources[file] = { size, mtimeMs, harness: "claude-code", sessionId: normalized.session.id };
      if (known === undefined) result.added += 1;
      else result.updated += 1;
    } catch {
      // One unreadable transcript must not stop the rest; it's retried on the next run.
      result.failed += 1;
    }
  }

  await saveState(root, state);
  Object.assign(result, await linkNestedSubagents(root));
  return result;
}

/**
 * The adapter can only name the parent of a first-level subagent. A deeper one records the tool
 * call that spawned it; here we find which archived session made that call.
 */
async function linkNestedSubagents(root: string): Promise<Pick<IngestResult, "linked" | "orphaned">> {
  const ids = await listSessionIds(root, "claude-code");
  const unresolved: NormalizedSession[] = [];
  for (const id of ids) {
    const session = await readSessionRecord(root, "claude-code", id);
    if (session.depth > 1 && session.parentId === null) unresolved.push(await readSession(root, "claude-code", id));
  }
  if (unresolved.length === 0) return { linked: 0, orphaned: 0 };

  const spawner = new Map<string, string>();
  for (const id of ids) {
    const { session, events } = await readSession(root, "claude-code", id);
    for (const event of events) {
      if (event.kind === "tool_call" && event.category === "agent") spawner.set(event.callId, session.id);
    }
  }

  let linked = 0;
  let orphaned = 0;
  for (const child of unresolved) {
    const parentId = child.session.spawnedByCallId === null ? undefined : spawner.get(child.session.spawnedByCallId);
    const orphan = parentId === undefined;
    if (orphan) orphaned += 1;
    else linked += 1;
    if (child.session.orphan === orphan && parentId === undefined) continue;
    await writeSession(root, { ...child, session: { ...child.session, parentId: parentId ?? null, orphan } });
  }
  return { linked, orphaned };
}

/** Every transcript under the source folder: `<project>/<session>.jsonl` and `<project>/<session>/subagents/agent-<id>.jsonl`. */
async function transcripts(source: string): Promise<string[]> {
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
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return found.sort();
}

function readLines(file: string): AsyncIterable<string> {
  return createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
}

/** A subagent's `agent-<id>.json` sits next to its transcript. */
async function readMeta(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file.replace(/\.jsonl$/, ".json"), "utf8"));
  } catch {
    return undefined;
  }
}
