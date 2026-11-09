import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

export async function invoke(args: string[], env: Record<string, string> = {}, home = "/nonexistent-home") {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(args, { out: (line) => out.push(line), err: (line) => err.push(line), env, home });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("ambessa CLI", () => {
  it("prints usage and succeeds when called without a command", async () => {
    const result = await invoke([]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: ambessa <command>");
  });

  it("prints the version from package.json", async () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const result = await invoke(["--version"]);
    expect(result.code).toBe(0);
    expect(result.out).toBe(version);
  });

  it("rejects an unknown command with exit code 2 and shows usage on stderr", async () => {
    const result = await invoke(["frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("Unknown command: frobnicate");
    expect(result.err).toContain("Usage: ambessa <command>");
  });

  it("rejects an unknown option with exit code 2", async () => {
    const result = await invoke(["ingest", "--frobnicate"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Usage: ambessa <command>");
  });
});
