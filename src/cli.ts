#!/usr/bin/env node
// CLI shell: reads a JEV request (file or stdin), writes the JEV response to stdout.

import { readFile } from "node:fs/promises";
import { adapt } from "./adapter.ts";
import { errorMessage } from "./guards.ts";
import { ensureNodeEnv, resolveNodeOptions } from "./node-env.ts";

const USAGE =
  "usage: ds2jev [--pretty] [--thinking <low|high|max>] [file]  (reads stdin when file is omitted)";

type CliOptions = {
  pretty: boolean;
  thinking?: string | undefined;
  file?: string | undefined;
  help?: boolean | undefined;
};

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--pretty") opts.pretty = true;
    else if (arg === "--thinking") {
      const level = argv[++i];
      if (!level) throw new Error("--thinking requires a level");
      opts.thinking = level;
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

async function readInput(file?: string): Promise<string> {
  if (file) return readFile(file, "utf8");
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  ensureNodeEnv();

  const raw = await readInput(opts.file);
  let request: unknown;
  try {
    request = JSON.parse(raw);
  } catch (err) {
    throw new Error(`invalid request json: ${errorMessage(err)}`, { cause: err });
  }

  const response = await adapt(request, { thinking: opts.thinking, ...resolveNodeOptions() });
  process.stdout.write(`${JSON.stringify(response, null, opts.pretty ? 2 : 0)}\n`);
}

try {
  await main();
} catch (err) {
  process.stderr.write(`ds2jev: ${errorMessage(err)}\n`);
  process.exit(1);
}
