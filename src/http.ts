// Shared Web-standard request handling, reused by every deployment shell
// (node server, Cloudflare Worker, Vercel handler). Path routing is the shell's job.

import { adapt } from "./adapter.ts";
import type { AdaptOptions } from "./adapter.ts";
import { errorMessage, statusOf } from "./guards.ts";

export type HandlerOptions = Pick<AdaptOptions, "apiKey" | "baseUrl" | "model" | "fetch">;

export async function handleRequest(request: Request, options: HandlerOptions): Promise<Response> {
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
