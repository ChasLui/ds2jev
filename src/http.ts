// Shared Web-standard request handling, reused by every deployment shell
// (node server, Cloudflare Worker, Vercel handler). Path routing is the shell's job.

import { adapt } from "./adapter.ts";
import type { AdaptOptions } from "./adapter.ts";
import { errorMessage, statusOf } from "./guards.ts";

export type HandlerOptions = Pick<AdaptOptions, "apiKey" | "baseUrl" | "model" | "fetch"> & {
  accessKeys?: readonly string[] | undefined;
};

// `u` flag is required by pedantic rule require-unicode-regexp (verified: without it oxlint
// exits 1); scheme matching stays case-insensitive per RFC 7235.
const BEARER = /^bearer\s+(.+)$/iu;
const UTF8 = new TextEncoder();

// Splits DS2JEV_API_KEYS ("k1,k2") into trimmed non-empty keys; unset/blank -> [].
export function parseAccessKeys(raw?: string): readonly string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

// Compares without early exit; iteration count depends only on the secret's length, never on
// the input's, so a wrong key leaks neither content nor the configured key's length.
function constantTimeEquals(secret: string, input: string): boolean {
  const left = UTF8.encode(secret);
  const right = UTF8.encode(input);
  let diff = left.length ^ right.length;
  for (let i = 0; i < left.length; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }
  return diff === 0;
}

function isAuthorized(request: Request, accessKeys: readonly string[]): boolean {
  const header = request.headers.get("authorization");
  if (header === null) return false;
  const token = BEARER.exec(header.trim())?.[1];
  if (token === undefined) return false;
  return accessKeys.some((key) => constantTimeEquals(key, token));
}

export async function handleRequest(request: Request, options: HandlerOptions): Promise<Response> {
  if (!isAuthorized(request, options.accessKeys ?? [])) {
    return Response.json({ error: { message: "unauthorized" } }, { status: 401 });
  }

  if (request.method !== "POST") {
    return Response.json({ error: { message: "method not allowed" } }, { status: 405 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch (err) {
    return Response.json(
      { error: { message: `invalid request json: ${errorMessage(err)}` } },
      { status: 400 },
    );
  }

  try {
    const response = await adapt(body, options);
    return Response.json(response, { status: 200 });
  } catch (err) {
    const raw = statusOf(err);
    const status = raw === 400 || raw === 500 || raw === 502 ? raw : 500;
    return Response.json({ error: { message: errorMessage(err) } }, { status });
  }
}
