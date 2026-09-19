import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "../src/http.ts";
import type { JevRequest } from "../src/format.ts";
import { isRecord } from "../src/guards.ts";

const requestBody: JevRequest = {
  state: "x",
  questions: { q: { type: "noul", instructions: "yes?" } },
};

const okPayload = {
  model: "deepseek-flash",
  choices: [{ message: { content: '{"answers":{"q":{"noul":0.7}}}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const fetchStub: typeof fetch = async () =>
  new Response(JSON.stringify(okPayload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function post(body: string): Request {
  return new Request("http://x/v1/systemone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

async function jsonError(res: Response): Promise<string> {
  const payload: unknown = await res.json();
  if (!isRecord(payload)) throw new Error("expected an object payload");
  const error = payload.error;
  if (!isRecord(error) || typeof error.message !== "string")
    throw new Error("expected error.message");
  return error.message;
}

test("non-POST method returns 405", async () => {
  const res = await handleRequest(new Request("http://x/v1/systemone"), {
    apiKey: "k",
    fetch: fetchStub,
  });
  assert.equal(res.status, 405);
  assert.equal(await jsonError(res), "method not allowed");
});

test("invalid json body returns 400", async () => {
  const res = await handleRequest(post("{not json"), { apiKey: "k", fetch: fetchStub });
  assert.equal(res.status, 400);
  assert.match(await jsonError(res), /^invalid request json: /);
});

test("request validation failure returns 400", async () => {
  const res = await handleRequest(post(JSON.stringify({ state: "x", questions: {} })), {
    apiKey: "k",
    fetch: fetchStub,
  });
  assert.equal(res.status, 400);
  assert.equal(await jsonError(res), "questions is required");
});

test("valid request returns 200 with the full answer set", async () => {
  const res = await handleRequest(post(JSON.stringify(requestBody)), {
    apiKey: "k",
    fetch: fetchStub,
  });
  assert.equal(res.status, 200);
  const payload: unknown = await res.json();
  if (!isRecord(payload)) throw new Error("expected an object payload");
  assert.deepEqual(payload.answers, { q: { type: "noul", noul: 0.7 } });
  const usage = payload.usage;
  if (!isRecord(usage)) throw new Error("expected a usage object");
  assert.equal(usage.input_tokens, 10);
});

test("missing api key returns 500", async () => {
  const res = await handleRequest(post(JSON.stringify(requestBody)), {
    apiKey: undefined,
    fetch: fetchStub,
  });
  assert.equal(res.status, 500);
  assert.match(await jsonError(res), /DEEPSEEK_API_KEY/);
});

test("three unusable upstream outputs return 502", async () => {
  const bad: typeof fetch = async () =>
    new Response(
      JSON.stringify({ ...okPayload, choices: [{ message: { content: "still not json" } }] }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      },
    );
  const res = await handleRequest(post(JSON.stringify(requestBody)), { apiKey: "k", fetch: bad });
  assert.equal(res.status, 502);
  assert.match(await jsonError(res), /json/);
});
