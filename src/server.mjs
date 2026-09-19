// HTTP shell: POST /v1/systemone -> adapt() -> JEV response.

import { createServer } from "node:http";
import { adapt } from "./adapter.mjs";

function parseArgs(argv) {
  const opts = { port: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") opts.port = Number(argv[++i]);
  }
  return opts;
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

const { port: argPort } = parseArgs(process.argv.slice(2));
const port = argPort ?? (process.env.DS2JEV_PORT ? Number(process.env.DS2JEV_PORT) : 8787);

const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/systemone") {
    send(res, 404, { error: { message: "not found" } });
    return;
  }

  let request;
  try {
    request = JSON.parse(await readBody(req));
  } catch (err) {
    send(res, 400, { error: { message: `invalid request json: ${err.message}` } });
    return;
  }

  try {
    const response = await adapt(request);
    send(res, 200, response);
  } catch (err) {
    const status = err.status === 400 ? 400 : err.status === 502 ? 502 : 500;
    send(res, status, { error: { message: err.message } });
  }
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`ds2jev listening on http://127.0.0.1:${port}\n`);
});