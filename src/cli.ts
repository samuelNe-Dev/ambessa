import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { archiveRoot, loadState, readAllSessions } from "./archive/archive.js";
import { resolveProjectId } from "./archive/projects.js";
import { defaultClaudeCodeSource, ingestClaudeCode } from "./archive/ingest.js";
import { CLAUDE_CODE_RULES_VERSION } from "./adapters/claude-code.js";
import { renderSessions, summarize } from "./report/sessions.js";
import { compareWeeks, renderSignals } from "./signals/signals.js";

/** Everything the CLI touches outside itself. Injected so tests never use the real terminal, home or environment. */
export interface Context {
  out(line: string): void;
  err(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  now(): Date;
}

const USAGE = `Usage: ambessa <command> [options]

Commands:
  ingest     Read new and changed Claude Code sessions into the local archive
               --source <dir>   Transcript folder (default: ~/.claude/projects)
  sessions   List archived sessions, newest first, with subagents rolled up
               --limit <n>      How many to show (default: 20)
  signals    Friction signals for the last 7 days against the 7 before
               --project <dir>  Only sessions from this project (worktrees included)
  help       Show this message
  version    Print the installed version

The archive lives in ~/.ambessa (set AMBESSA_HOME to move it). It holds no message text,
code, file paths or account ids.

Ambessa is in early development. Roadmap: https://github.com/samuelNe-Dev/ambessa#roadmap`;

/** Runs one CLI invocation and returns the process exit code. */
export async function run(args: readonly string[], context: Context): Promise<number> {
  try {
    return await dispatch(args, context);
  } catch (error) {
    context.err(`ambessa: ${(error as Error).message}`);
    return 1;
  }
}

async function dispatch(args: readonly string[], context: Context): Promise<number> {
  const [command, ...rest] = args;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      context.out(USAGE);
      return 0;
    case "version":
    case "--version":
    case "-v":
      context.out(version());
      return 0;
    case "ingest":
      return ingest(rest, context);
    case "sessions":
      return sessions(rest, context);
    case "signals":
      return signals(rest, context);
    default:
      context.err(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

async function ingest(args: readonly string[], context: Context): Promise<number> {
  let explicitSource: string | undefined;
  try {
    const { values } = parseArgs({ args: [...args], options: { source: { type: "string" } }, strict: true });
    explicitSource = values.source;
  } catch (error) {
    context.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const source = explicitSource ?? defaultClaudeCodeSource(context.env, context.home);
  const root = archiveRoot(context.env, context.home);
  const result = await ingestClaudeCode(root, source);
  if (!result.sourceFound) {
    // A folder the user named must exist; the default one simply means Claude Code hasn't run here.
    if (explicitSource !== undefined) {
      context.err(`Source folder not found: ${source}`);
      return 1;
    }
    context.out(`No Claude Code sessions found in ${source}.`);
    return 0;
  }

  const failed = result.failures.length;
  context.out(
    `Claude Code: ${result.added} new, ${result.updated} updated, ${result.unchanged} unchanged` +
      (failed > 0 ? `, ${failed} failed` : "") +
      ".",
  );
  if (result.linked + result.orphaned > 0) {
    context.out(`Nested subagents: ${result.linked} linked to their parent, ${result.orphaned} without one yet.`);
  }
  context.out(`Archive: ${root}`);
  if (failed > 0) {
    const shown = result.failures.slice(0, 5).map(({ file, reason }) => `  ${file}: ${reason}`);
    const more = failed > shown.length ? [`  …and ${failed - shown.length} more`] : [];
    context.err([`${failed} transcript(s) couldn't be ingested and will be retried next run:`, ...shown, ...more].join("\n"));
    return 1;
  }
  return 0;
}

async function sessions(args: readonly string[], context: Context): Promise<number> {
  let limit = 20;
  try {
    const { values } = parseArgs({ args: [...args], options: { limit: { type: "string" } }, strict: true });
    if (values.limit !== undefined) {
      limit = Number(values.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive whole number");
    }
  } catch (error) {
    context.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const { sessions, unreadable } = await readAllSessions(archiveRoot(context.env, context.home), "claude-code");
  context.out(renderSessions(summarize(sessions), limit, unreadable));
  return 0;
}

async function signals(args: readonly string[], context: Context): Promise<number> {
  let project: string | undefined;
  try {
    ({ project } = parseArgs({ args: [...args], options: { project: { type: "string" } }, strict: true }).values);
  } catch (error) {
    context.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const root = archiveRoot(context.env, context.home);
  const { sessions: archived, unreadable } = await readAllSessions(root, "claude-code");
  // Resolve the folder the same way ingest did; the remembered mapping wins, so deleted worktrees still match.
  const projectId = project === undefined ? null : await resolveProjectId(resolve(project), (await loadState(root)).projects);
  const scoped = projectId === null ? archived : archived.filter(({ session }) => session.projectId === projectId);
  context.out(renderSignals(compareWeeks(scoped, context.now(), CLAUDE_CODE_RULES_VERSION)));
  if (unreadable.length > 0) context.out(`${unreadable.length} archived session(s) couldn't be read and are left out.`);
  return 0;
}

function version(): string {
  // package.json sits one level above both src/ (tests) and dist/ (installed build).
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return manifest.version;
}
