#!/usr/bin/env node
// CLI shell: reads a JEV request (file or stdin), writes the JEV response to stdout.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { adapt } from "./adapter.mjs";

function usage() {
  return "usage: ds2jev [--pretty] [--thinking <low|high|max>] [file]  (reads stdin when file is omitted)";
}

function parseArgs(argv) {
  const opts = { pretty: false, thinking: undefined, file: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pretty") opts.pretty = true;
    else if (arg === "--thinking") {
      opts.thinking = argv[++i];
      if (!opts.thinking) throw new Error("--thinking requires a level");
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      opts.file = arg;
    }
  }
  return opts;
}

async function readInput(file) {
  if (file) return readFile(file, "utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (!process.env.DEEPSEEK_API_KEY) {
    try {
      process.loadEnvFile(join(homedir(), ".env.local"));
    } catch {
      // no local env file; adapt() will report the missing key
    }
  }

  const raw = await readInput(opts.file);
  let request;
  try {
    request = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid request json: ${err.message}`);
  }

  const response = await adapt(request, { thinking: opts.thinking });
  process.stdout.write(`${JSON.stringify(response, null, opts.pretty ? 2 : 0)}\n`);
}

main().catch((err) => {
  process.stderr.write(`ds2jev: ${err.message}\n`);
  process.exit(1);
});