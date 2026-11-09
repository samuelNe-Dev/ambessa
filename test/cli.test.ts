import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";

function invoke(...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(args, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("ambessa CLI", () => {
  it("prints usage and succeeds when called without a command", () => {
    const result = invoke();
    expect(result.code).toBe(0);
    expect(result.out).toContain("Usage: ambessa <command>");
  });

  it("prints the version from package.json", () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const result = invoke("--version");
    expect(result.code).toBe(0);
    expect(result.out).toBe(version);
  });

  it("rejects an unknown command with exit code 2 and shows usage on stderr", () => {
    const result = invoke("frobnicate");
    expect(result.code).toBe(2);
    expect(result.out).toBe("");
    expect(result.err).toContain("Unknown command: frobnicate");
    expect(result.err).toContain("Usage: ambessa <command>");
  });
});
