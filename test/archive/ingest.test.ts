import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listSessionIds, readSession, readSessionRecord } from "../../src/archive/archive.js";
import { ingestClaudeCode } from "../../src/archive/ingest.js";
import { hashId } from "../../src/session/ids.js";
import { invoke } from "../cli.test.js";

const fixture = (name: string) => new URL(`../fixtures/claude-code/${name}`, import.meta.url);

let workspace: string;
let source: string;
let root: string;

/** Lays out transcripts the way Claude Code does: <project>/<session>.jsonl and <project>/<session>/subagents/agent-<id>.jsonl. */
function place(fixtureName: string, relativePath: string): string {
  const path = join(source, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  copyFileSync(fixture(fixtureName), path);
  return path;
}

function write(relativePath: string, rows: object[]): string {
  const path = join(source, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ambessa-ingest-"));
  source = join(workspace, "projects");
  root = join(workspace, "archive");
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("ingest", () => {
  it("archives every transcript, including subagents, and skips folders without transcripts", async () => {
    place("basic.jsonl", "-Users-alice-proj/sess-basic.jsonl");
    place("subagent.jsonl", "-Users-alice-proj/sess-parent/subagents/agent-abc.jsonl");
    writeFileSync(join(source, "-Users-alice-proj/sess-parent/subagents/agent-abc.json"), JSON.stringify({ toolUseId: "toolu_spawn", spawnDepth: 1 }));
    place("basic.jsonl", "-Users-alice-proj/sess-parent/tool-results/not-a-transcript.jsonl");

    const result = await ingestClaudeCode(root, source);

    expect(result).toMatchObject({ added: 2, updated: 0, unchanged: 0, failed: 0 });
    const subagent = await readSessionRecord(root, "claude-code", hashId("claude-code", "session", "sess-parent", "agent-abc"));
    expect(subagent).toMatchObject({ depth: 1, spawnedByCallId: hashId("claude-code", "call", "toolu_spawn") });
  });

  it("round-trips a session through the archive unchanged", async () => {
    place("errors.jsonl", "p/sess-errors.jsonl");
    await ingestClaudeCode(root, source);
    const [id] = await listSessionIds(root, "claude-code");
    const archived = await readSession(root, "claude-code", id!);
    expect(archived.events.filter((event) => event.kind === "tool_call")).toHaveLength(9);
    expect(archived.session.source.file).toBe(join(source, "p/sess-errors.jsonl"));
  });

  it("tags every archived line with the schema version", async () => {
    place("basic.jsonl", "p/sess-basic.jsonl");
    await ingestClaudeCode(root, source);
    const [id] = await listSessionIds(root, "claude-code");
    const lines = readFileSync(join(root, "sessions/claude-code", `${id}.jsonl`), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).schemaVersion)).toEqual(lines.map(() => 1));
  });

  it("skips unchanged transcripts and re-reads ones that grew", async () => {
    const path = place("basic.jsonl", "p/sess-basic.jsonl");
    await ingestClaudeCode(root, source);
    expect(await ingestClaudeCode(root, source)).toMatchObject({ added: 0, updated: 0, unchanged: 1 });

    appendFileSync(path, JSON.stringify({ type: "user", sessionId: "sess-basic", timestamp: "2026-11-01T12:00:00.000Z", message: { role: "user", content: "again" } }) + "\n");
    expect(await ingestClaudeCode(root, source)).toMatchObject({ added: 0, updated: 1, unchanged: 0 });
    const archived = await readSession(root, "claude-code", hashId("claude-code", "session", "sess-basic"));
    expect(archived.events.filter((event) => event.kind === "turn")).toHaveLength(3);
  });

  it("keeps a session after its transcript is deleted", async () => {
    const path = place("basic.jsonl", "p/sess-basic.jsonl");
    await ingestClaudeCode(root, source);
    rmSync(path);
    await ingestClaudeCode(root, source);
    expect(await listSessionIds(root, "claude-code")).toEqual([hashId("claude-code", "session", "sess-basic")]);
  });

  it("returns nothing when the source folder doesn't exist", async () => {
    expect(await ingestClaudeCode(root, join(workspace, "missing"))).toEqual({ added: 0, updated: 0, unchanged: 0, failed: 0, linked: 0, orphaned: 0 });
  });

  it("stores no private content in archived sessions", async () => {
    place("basic.jsonl", "-Users-alice-secret-project/sess-basic.jsonl");
    place("errors.jsonl", "-Users-alice-secret-project/sess-errors.jsonl");
    place("subagent.jsonl", "-Users-alice-secret-project/sess-parent/subagents/agent-abc.jsonl");
    await ingestClaudeCode(root, source);

    const directory = join(root, "sessions/claude-code");
    for (const name of readdirSync(directory)) {
      // The transcript pointer is the one allowed local path; everything else must be clean.
      const records = readFileSync(join(directory, name), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      delete records[0].source;
      const text = JSON.stringify(records);
      for (const secret of ["SECRET", "alice", "secret-project", "secret-branch", "sess-", "toolu_", "agent-abc", "msg_"]) {
        expect(text).not.toContain(secret);
      }
    }
  });
});

describe("ingest: nested subagents", () => {
  const T = "2026-11-05T10:00:00.000Z";
  const prompt = (agentId: string) => ({ type: "user", sessionId: "root", agentId, timestamp: T, message: { role: "user", content: "task" } });
  const spawn = (agentId: string, toolUseId: string) => ({
    type: "assistant",
    sessionId: "root",
    agentId,
    timestamp: T,
    message: { id: `m-${agentId}`, model: "m", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: {} }] },
  });

  it("links a second-level subagent to the subagent that spawned it", async () => {
    write("p/root/subagents/agent-a.jsonl", [prompt("a"), spawn("a", "toolu_deep")]);
    write("p/root/subagents/agent-b.jsonl", [prompt("b")]);
    writeFileSync(join(source, "p/root/subagents/agent-b.json"), JSON.stringify({ toolUseId: "toolu_deep", spawnDepth: 2 }));

    expect(await ingestClaudeCode(root, source)).toMatchObject({ added: 2, linked: 1, orphaned: 0 });
    const child = await readSessionRecord(root, "claude-code", hashId("claude-code", "session", "root", "b"));
    expect(child).toMatchObject({ depth: 2, parentId: hashId("claude-code", "session", "root", "a"), orphan: false });
  });

  it("flags a second-level subagent as an orphan until its parent shows up", async () => {
    write("p/root/subagents/agent-b.jsonl", [prompt("b")]);
    writeFileSync(join(source, "p/root/subagents/agent-b.json"), JSON.stringify({ toolUseId: "toolu_deep", spawnDepth: 2 }));
    expect(await ingestClaudeCode(root, source)).toMatchObject({ linked: 0, orphaned: 1 });
    const id = hashId("claude-code", "session", "root", "b");
    expect(await readSessionRecord(root, "claude-code", id)).toMatchObject({ parentId: null, orphan: true });

    write("p/root/subagents/agent-a.jsonl", [prompt("a"), spawn("a", "toolu_deep")]);
    expect(await ingestClaudeCode(root, source)).toMatchObject({ added: 1, linked: 1, orphaned: 0 });
    expect(await readSessionRecord(root, "claude-code", id)).toMatchObject({ orphan: false });
  });
});

describe("ambessa ingest", () => {
  it("reports what it archived", async () => {
    place("basic.jsonl", "p/sess-basic.jsonl");
    const result = await invoke(["ingest", "--source", source], { AMBESSA_HOME: root });
    expect(result).toMatchObject({ code: 0, err: "" });
    expect(result.out).toBe(`Claude Code: 1 new, 0 updated, 0 unchanged.\nArchive: ${root}`);
  });

  it("finds transcripts in CLAUDE_CONFIG_DIR and archives under the home folder by default", async () => {
    place("basic.jsonl", "p/sess-basic.jsonl");
    const result = await invoke(["ingest"], { CLAUDE_CONFIG_DIR: workspace }, workspace);
    expect(result.code).toBe(0);
    expect(await listSessionIds(join(workspace, ".ambessa"), "claude-code")).toHaveLength(1);
  });

  it("says so when there's nothing to ingest", async () => {
    const result = await invoke(["ingest", "--source", join(workspace, "missing")], { AMBESSA_HOME: root });
    expect(result).toMatchObject({ code: 0, out: `No Claude Code sessions found in ${join(workspace, "missing")}.` });
  });
});
