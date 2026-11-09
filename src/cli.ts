import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { archiveRoot } from "./archive/archive.js";
import { defaultClaudeCodeSource, ingestClaudeCode } from "./archive/ingest.js";

/** Everything the CLI touches outside itself. Injected so tests never use the real terminal, home or environment. */
export interface Context {
  out(line: string): void;
  err(line: string): void;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

const USAGE = `Usage: ambessa <command> [options]

Commands:
  ingest     Read new and changed Claude Code sessions into the local archive
               --source <dir>   Transcript folder (default: ~/.claude/projects)
  help       Show this message
  version    Print the installed version

The archive lives in ~/.ambessa (set AMBESSA_HOME to move it). It holds no message text,
code, file paths or account ids.

Ambessa is in early development. Roadmap: https://github.com/samuelNe-Dev/ambessa#roadmap`;

/** Runs one CLI invocation and returns the process exit code. */
export async function run(args: readonly string[], context: Context): Promise<number> {
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
    default:
      context.err(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

async function ingest(args: readonly string[], context: Context): Promise<number> {
  let source: string;
  try {
    const { values } = parseArgs({ args: [...args], options: { source: { type: "string" } }, strict: true });
    source = values.source ?? defaultClaudeCodeSource(context.env, context.home);
  } catch (error) {
    context.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }

  const root = archiveRoot(context.env, context.home);
  const result = await ingestClaudeCode(root, source);
  const total = result.added + result.updated + result.unchanged + result.failed;
  if (total === 0) {
    context.out(`No Claude Code sessions found in ${source}.`);
    return 0;
  }

  context.out(
    `Claude Code: ${result.added} new, ${result.updated} updated, ${result.unchanged} unchanged` +
      (result.failed > 0 ? `, ${result.failed} failed` : "") +
      ".",
  );
  if (result.linked + result.orphaned > 0) {
    context.out(`Nested subagents: ${result.linked} linked to their parent, ${result.orphaned} without one.`);
  }
  context.out(`Archive: ${root}`);
  if (result.failed > 0) {
    context.err(`${result.failed} transcript(s) couldn't be read. They'll be retried on the next run.`);
    return 1;
  }
  return 0;
}

function version(): string {
  // package.json sits one level above both src/ (tests) and dist/ (installed build).
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return manifest.version;
}
