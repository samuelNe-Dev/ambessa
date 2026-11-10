import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { hashId } from "../session/ids.js";

const run = promisify(execFile);

/**
 * Which project a working folder belongs to (decision record 0004, point 5), as a hash.
 *
 * A folder inside a git repository, or inside one of its worktrees, resolves to the repository's
 * common git directory, so the factory's many worktrees count as one project. A folder that isn't
 * a repository, or no longer exists, stands for itself. `known` remembers each folder's answer, so
 * a project keeps its id after a worktree is deleted.
 */
export async function resolveProjectId(folder: string, known: Record<string, string>): Promise<string> {
  const remembered = known[folder];
  if (remembered !== undefined) return remembered;
  const repository = await gitCommonDirectory(folder);
  const id = hashId("project", repository ?? folder);
  known[folder] = id;
  return id;
}

async function gitCommonDirectory(folder: string): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", folder, "rev-parse", "--path-format=absolute", "--git-common-dir"], { timeout: 5000 });
    const directory = stdout.trim();
    return directory.length > 0 ? directory : null;
  } catch {
    return null; // not a repository, the folder is gone, or git isn't installed
  }
}
