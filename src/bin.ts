#!/usr/bin/env node
import { homedir } from "node:os";
import { run } from "./cli.js";

process.exitCode = await run(process.argv.slice(2), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  env: process.env,
  home: homedir(),
});
