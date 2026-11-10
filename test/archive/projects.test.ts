import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectId } from "../../src/archive/projects.js";
import { hashId } from "../../src/session/ids.js";

let workspace: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" }).trim();
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "ambessa-projects-"));
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

describe("resolveProjectId", () => {
  it("gives a repository and its worktrees the same project", async () => {
    const repo = join(workspace, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    writeFileSync(join(repo, "README.md"), "hi\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "init");
    mkdirSync(join(repo, "src"));
    const worktree = join(workspace, "worktree");
    git(repo, "worktree", "add", "-q", worktree);

    const known: Record<string, string> = {};
    const fromRoot = await resolveProjectId(repo, known);
    expect(await resolveProjectId(join(repo, "src"), known)).toBe(fromRoot);
    expect(await resolveProjectId(worktree, known)).toBe(fromRoot);
  });

  it("falls back to the folder itself when it isn't a git repository or doesn't exist", async () => {
    const plain = join(workspace, "plain");
    mkdirSync(plain);
    const known: Record<string, string> = {};
    expect(await resolveProjectId(plain, known)).toBe(hashId("project", plain));
    expect(await resolveProjectId(join(workspace, "gone"), known)).toBe(hashId("project", join(workspace, "gone")));
  });

  it("remembers a folder's project, so it stays the same after the folder is deleted", async () => {
    const repo = join(workspace, "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    const known: Record<string, string> = {};
    const before = await resolveProjectId(repo, known);
    expect(known[repo]).toBe(before);

    rmSync(repo, { recursive: true, force: true });
    expect(await resolveProjectId(repo, known)).toBe(before);
  });

  it("never stores or returns the path itself", async () => {
    const id = await resolveProjectId(join(workspace, "secret-project"), {});
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});
