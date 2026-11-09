import { readFileSync } from "node:fs";

/** Where the CLI writes. Injected so tests can capture output without touching the real terminal. */
export interface Output {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `Usage: ambessa <command>

Commands:
  help       Show this message
  version    Print the installed version

Ambessa is in early development. Roadmap: https://github.com/samuelNe-Dev/ambessa#roadmap`;

/** Runs one CLI invocation and returns the process exit code. */
export function run(args: readonly string[], output: Output): number {
  const [command] = args;

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      output.out(USAGE);
      return 0;
    case "version":
    case "--version":
    case "-v":
      output.out(version());
      return 0;
    default:
      output.err(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

function version(): string {
  // package.json sits one level above both src/ (tests) and dist/ (installed build).
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return manifest.version;
}
