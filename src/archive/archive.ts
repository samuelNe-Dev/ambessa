import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SCHEMA_VERSION, type Harness, type NormalizedSession, type SessionEvent, type SessionRecord } from "../session/schema.js";

/**
 * Ambessa's own long-lived store of normalized sessions (decision record 0001, point 5).
 *
 * Layout:
 *   <root>/sessions/<harness>/<session id>.jsonl   first line: the session record; then one event per line
 *   <root>/state.json                              which transcripts were ingested, to skip unchanged ones
 *   <root>/ingest.lock                             present while an ingest runs; holds its process id
 *
 * Harnesses delete old transcripts; the archive keeps their normalized form so baselines survive.
 */

/** What ingest remembers about each transcript, keyed by its path. Local only, never exported. */
export interface SourceState {
  size: number;
  mtimeMs: number;
  /** A subagent's meta file can be written after its transcript, so it's part of the fingerprint. */
  metaMtimeMs: number | null;
  harness: Harness;
  sessionId: string;
}

export interface ArchiveState {
  schemaVersion: typeof SCHEMA_VERSION;
  sources: Record<string, SourceState>;
  /** Which session made each agent tool call, so nested subagents can be linked without rereading the archive. */
  spawners: Record<string, { sessionId: string; startedAt: string | null }>;
  /** Nested subagents still waiting for their parent. */
  unlinked: string[];
}

export function archiveRoot(env: Readonly<Record<string, string | undefined>>, home: string): string {
  return env.AMBESSA_HOME ?? join(home, ".ambessa");
}

export async function loadState(root: string): Promise<ArchiveState> {
  const path = join(root, "state.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, sources: {}, spawners: {}, unlinked: [] };
    throw error;
  }
  const rebuild = "Delete it to rebuild it on the next ingest; archived sessions are kept.";
  let state: ArchiveState;
  try {
    state = JSON.parse(text) as ArchiveState;
  } catch {
    throw new Error(`${path} is unreadable. ${rebuild}`);
  }
  if (state.schemaVersion !== SCHEMA_VERSION) throw new Error(`${path} has unsupported version ${state.schemaVersion}. ${rebuild}`);
  return state;
}

/**
 * Makes sure only one ingest writes to the archive at a time. A lock left by a process that no
 * longer runs (e.g. after a crash) is taken over. Returns the function that releases the lock.
 */
export async function acquireLock(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true });
  const path = join(root, "ingest.lock");
  const take = () => writeFile(path, String(process.pid), { flag: "wx" });
  try {
    await take();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number.parseInt(await readFile(path, "utf8").catch(() => ""), 10);
    if (Number.isInteger(holder) && isRunning(holder)) {
      throw new Error(`Another ingest is running (process ${holder}). If it isn't, delete ${path}.`);
    }
    await rm(path, { force: true });
    await take();
  }
  return () => rm(path, { force: true });
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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

export async function deleteSession(root: string, harness: Harness, id: string): Promise<void> {
  await rm(sessionPath(root, harness, id), { force: true });
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

/**
 * Every archived session for a harness, one file at a time. A damaged file doesn't stop the rest:
 * its id is returned in `unreadable` instead.
 */
export async function readAllSessions(root: string, harness: Harness): Promise<{ sessions: NormalizedSession[]; unreadable: string[] }> {
  const sessions: NormalizedSession[] = [];
  const unreadable: string[] = [];
  for (const id of await listSessionIds(root, harness)) {
    try {
      sessions.push(await readSession(root, harness, id));
    } catch {
      unreadable.push(id);
    }
  }
  return { sessions, unreadable };
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
