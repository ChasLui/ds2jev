// Node-only environment plumbing: the single shared module allowed to touch process.env.

import { homedir } from "node:os";
import { join } from "node:path";
import type { HandlerOptions } from "./http.ts";

export function ensureNodeEnv(): void {
  if (!process.env.DEEPSEEK_API_KEY) {
    try {
      process.loadEnvFile(join(homedir(), ".env.local"));
    } catch {
      // no local env file; adapt() will report the missing key
    }
  }
}

export function resolveNodeOptions(): HandlerOptions {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseUrl: process.env.DEEPSEEK_BASE_URL,
    model: process.env.DEEPSEEK_MODEL,
  };
}
