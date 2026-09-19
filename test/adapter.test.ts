import test from "node:test";
import assert from "node:assert/strict";
import { adapt } from "../src/adapter.ts";
import type { JevRequest } from "../src/format.ts";
import { isRecord, statusOf } from "../src/guards.ts";

const request: JevRequest = {
  state: "x",
  questions: { q: { type: "noul", instructions: "yes?" } },
};

const okPayload = {
  model: "deepseek-flash",
  choices: [{ message: { content: '{"answers":{"q":{"noul":0.7}}}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function readBody(init: RequestInit | undefined): Record<string, unknown> {
  const sent = init?.body;
  if (typeof sent !== "string") throw new Error("expected a string request body");
  const parsed: unknown = JSON.parse(sent);
  if (!isRecord(parsed)) throw new Error("expected an object request body");
  return parsed;
}

test("sends json_object response_format and disabled thinking", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchStub: typeof fetch = async (_url, init) => {
    body = readBody(init);
    return jsonResponse(200, okPayload);
  };
  const res = await adapt(request, { apiKey: "k", fetch: fetchStub });
  assert.deepEqual(body?.response_format, { type: "json_object" });
  assert.deepEqual(body?.thinking, { type: "disabled" });
  assert.deepEqual(res.answers.q, { type: "noul", noul: 0.7 });
  assert.deepEqual(res.usage, { input_tokens: 10, output_tokens: 5 });
});

test("thinking level switches to reasoning_effort without thinking field", async () => {
  let body: Record<string, unknown> | undefined;
  const fetchStub: typeof fetch = async (_url, init) => {
    body = readBody(init);
    return jsonResponse(200, okPayload);
  };
  await adapt(request, { apiKey: "k", thinking: "high", fetch: fetchStub });
  assert.equal(body?.reasoning_effort, "high");
  assert.equal(body?.thinking, undefined);
});

test("retries after 429 then succeeds", async () => {
  let calls = 0;
  const fetchStub: typeof fetch = async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, { error: "rate limited" });
    return jsonResponse(200, okPayload);
  };
  const res = await adapt(request, { apiKey: "k", fetch: fetchStub });
  assert.equal(calls, 2);
  assert.deepEqual(res.answers.q, { type: "noul", noul: 0.7 });
});

test("retries after unusable output then succeeds", async () => {
  let calls = 0;
  const fetchStub: typeof fetch = async () => {
    calls++;
    if (calls === 1) {
      return jsonResponse(200, {
        ...okPayload,
        choices: [{ message: { content: "not json at all" } }],
      });
    }
    return jsonResponse(200, okPayload);
  };
  const res = await adapt(request, { apiKey: "k", fetch: fetchStub });
  assert.equal(calls, 2);
  assert.deepEqual(res.answers.q, { type: "noul", noul: 0.7 });
});

test("throws after three failed attempts", async () => {
  let calls = 0;
  const fetchStub: typeof fetch = async () => {
    calls++;
    return jsonResponse(200, {
      ...okPayload,
      choices: [{ message: { content: "still not json" } }],
    });
  };
  await assert.rejects(
    () => adapt(request, { apiKey: "k", fetch: fetchStub }),
    (err) => statusOf(err) === 502,
  );
  assert.equal(calls, 3);
});

test("hard upstream error fails fast without retry", async () => {
  let calls = 0;
  const fetchStub: typeof fetch = async () => {
    calls++;
    return jsonResponse(401, { error: "bad key" });
  };
  await assert.rejects(() => adapt(request, { apiKey: "k", fetch: fetchStub }), /401/);
  assert.equal(calls, 1);
});

test("missing api key throws with status 500", async () => {
  await assert.rejects(
    () => adapt(request, { apiKey: "" }),
    (err) => statusOf(err) === 500,
  );
});
