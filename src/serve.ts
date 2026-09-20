// Node HTTP shell (Docker / Vercel-node build target): POST /v1/systemone -> handleRequest().

import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { handleRequest } from "./http.ts";
import { ensureNodeEnv, resolveNodeOptions } from "./node-env.ts";

const NOT_FOUND = { error: { message: "not found" } };

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/v1/systemone") {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify(NOT_FOUND));
    return;
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(key, v);
  }

  const method = req.method ?? "GET";
  const rawBody = method === "POST" ? await readBody(req) : undefined;
  const init: RequestInit = { method, headers };
  // Copy into an ArrayBuffer-backed view: BodyInit rejects Uint8Array<ArrayBufferLike> (SharedArrayBuffer).
  if (rawBody) init.body = new Uint8Array(rawBody);
  const request = new Request(url, init);

  const response = await handleRequest(request, resolveNodeOptions());
  res.writeHead(response.status, { "content-type": "application/json" });
  res.end(await response.text());
});

ensureNodeEnv();
const port = Number(process.env["PORT"] ?? 8787);
const host = process.env["HOST"] ?? "127.0.0.1";
server.listen(port, host, () => {
  process.stdout.write(`ds2jev listening on http://${host}:${port}\n`);
  if (!process.env["DS2JEV_API_KEYS"]) {
    process.stderr.write(
      "warning: DS2JEV_API_KEYS is not set - all HTTP requests will be rejected with 401\n",
    );
  }
});
