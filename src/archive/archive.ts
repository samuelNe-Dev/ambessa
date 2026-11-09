import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SCHEMA_VERSION, type Harness, type NormalizedSession, type SessionEvent, type SessionRecord } from "../session/schema.js";

/**
 * Ambessa's own long-lived store of normalized sessions (decision record 0001, point 5).
 *
 * Layout:
 *   <root>/sessions/<harness>/<session id>.jsonl   first line: the session record; then one event per line
 *   <root>/state.json                              which transcripts were ingested, to skip unchanged ones
 *
 * Harnesses delete old transcripts; the archive keeps their normalized form so baselines survive.
 */

/** What ingest remembers about each transcript, keyed by its path. Local only, never exported. */
export interface SourceState {
  size: number;
  mtimeMs: number;
  harness: Harness;
  sessionId: string;
}

export interface ArchiveState {
  schemaVersion: typeof SCHEMA_VERSION;
  sources: Record<string, SourceState>;
}

export function archiveRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return env.AMBESSA_HOME ?? join(home, ".ambessa");
}

export async function loadState(root: string): Promise<ArchiveState> {
  try {
    const state = JSON.parse(await readFile(join(root, "state.json"), "utf8")) as ArchiveState;
    if (state.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported archive state version ${state.schemaVersion}`);
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, sources: {} };
    throw error;
  }
}

export async function saveState(root: string, state: ArchiveState): Promise<void> {
  await writeAtomically(join(root, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

export async function writeSession(root: string, { session, events }: NormalizedSession): Promise<void> {
  const lines = [session, ...events.map((event) => ({ schemaVersion: SCHEMA_VERSION, ...event }))];
  await writeAtomically(sessionPath(root, session.harness, session.id), lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
}

export async function readSession(root: string, harness: Harness, id: string): Promise<NormalizedSession> {
  let session: SessionRecord | null = null;
  const events: SessionEvent[] = [];
  const lines = createInterface({ input: createReadStream(sessionPath(root, harness, id)), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length === 0) continue;
    const record = JSON.parse(line) as { schemaVersion: number; kind: string };
    if (record.schemaVersion !== SCHEMA_VERSION) throw new Error(`Unsupported schema version ${record.schemaVersion} in session ${id}`);
    if (record.kind === "session") {
      session = record as SessionRecord;
    } else {
      const { schemaVersion: _version, ...event } = record;
      events.push(event as SessionEvent);
    }
  }
  if (session === null) throw new Error(`Archived session ${id} has no session record`);
  return { session, events };
}

/** Only the session record (the first line), without loading the events. */
export async function readSessionRecord(root: string, harness: Harness, id: string): Promise<SessionRecord> {
  const lines = createInterface({ input: createReadStream(sessionPath(root, harness, id)), crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      const record = JSON.parse(line) as SessionRecord;
      if (record.schemaVersion !== SCHEMA_VERSION || record.kind !== "session") break;
      return record;
    }
  } finally {
    lines.close();
  }
  throw new Error(`Archived session ${id} doesn't start with a supported session record`);
}

/** Ids of every archived session for a harness. */
export async function listSessionIds(root: string, harness: Harness): Promise<string[]> {
  try {
    const names = await readdir(join(root, "sessions", harness));
    return names.filter((name) => name.endsWith(".jsonl")).map((name) => name.slice(0, -".jsonl".length));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function sessionPath(root: string, harness: Harness, id: string): string {
  return join(root, "sessions", harness, `${id}.jsonl`);
}

/** Writes to a temporary file first, so a crash mid-write never leaves a half-written archive file. */
async function writeAtomically(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}
