import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { hashId } from "../session/ids.js";

const run = promisify(execFile);

/** Environment variables that would make git look at another repository than the folder it's given. */
const GIT_OVERRIDES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_NAMESPACE"];

export interface ResolveOptions {
  /** The git executable; replaceable so tests can simulate git failing. */
  git?: string;
}

/**
 * Which project a working folder belongs to (decision record 0004, point 5), as a hash.
 *
 * - A folder inside a git repository, or one of its worktrees, resolves to the repository's common
 *   git directory, so the factory's many worktrees count as one project.
 * - A folder that no longer exists resolves through its nearest existing parent, so a deleted
 *   worktree inside a repository still belongs to it.
 * - Anything else stands for itself (its canonical path, symlinks resolved).
 *
 * `known` remembers each folder's answer so a project keeps its id after the folder is deleted.
 * Only definite answers are remembered: if git itself failed (missing, too old, timed out), the next
 * run tries again.
 */
export async function resolveProjectId(folder: string, known: Record<string, string>, options: ResolveOptions = {}): Promise<string> {
  const remembered = known[folder];
  if (remembered !== undefined) return remembered;

  const { canonical, existing, exists } = await canonicalize(folder);
  const answer = await gitCommonDirectory(existing, options.git ?? "git");
  if (answer.kind === "repository") {
    const id = hashId("project", answer.directory);
    known[folder] = id;
    return id;
  }
  const id = hashId("project", canonical);
  if (answer.kind === "not-a-repository" && exists) known[folder] = id;
  return id;
}

/** The folder's real path; for a missing folder, its nearest existing parent's real path plus the rest. */
async function canonicalize(folder: string): Promise<{ canonical: string; existing: string; exists: boolean }> {
  const missing: string[] = [];
  let current = resolve(folder);
  for (;;) {
    try {
      const existing = await realpath(current);
      return { canonical: join(existing, ...missing.reverse()), existing, exists: missing.length === 0 };
    } catch {
      const parent = dirname(current);
      if (parent === current) return { canonical: resolve(folder), existing: current, exists: false };
      missing.push(basename(current));
      current = parent;
    }
  }
}

type GitAnswer = { kind: "repository"; directory: string } | { kind: "not-a-repository" } | { kind: "failed" };

async function gitCommonDirectory(folder: string, git: string): Promise<GitAnswer> {
  const env = { ...process.env };
  for (const name of GIT_OVERRIDES) delete env[name];
  try {
    const { stdout } = await run(git, ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000, env });
    const directory = stdout.trim();
    return directory.length > 0 ? { kind: "repository", directory } : { kind: "failed" };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "");
    return /not a git repository/i.test(stderr) ? { kind: "not-a-repository" } : { kind: "failed" };
  }
}
