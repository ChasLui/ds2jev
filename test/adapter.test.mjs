import test from "node:test";
import assert from "node:assert/strict";
import { adapt } from "../src/adapter.mjs";

const request = {
  state: "x",
  questions: { q: { type: "noul", instructions: "yes?" } },
};

const okPayload = {
  model: "deepseek-flash",
  choices: [{ message: { content: '{"answers":{"q":{"noul":0.7}}}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

test("sends json_object response_format and disabled thinking", async () => {
  let body;
  const fetchStub = async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(200, okPayload);
  };
  const res = await adapt(request, { apiKey: "k", fetch: fetchStub });
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(res.answers.q.noul, 0.7);
  assert.deepEqual(res.usage, { input_tokens: 10, output_tokens: 5 });
});

test("thinking level switches to reasoning_effort without thinking field", async () => {
  let body;
  const fetchStub = async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse(200, okPayload);
  };
  await adapt(request, { apiKey: "k", thinking: "high", fetch: fetchStub });
  assert.equal(body.reasoning_effort, "high");
  assert.equal(body.thinking, undefined);
});

test("retries after 429 then succeeds", async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls++;
    if (calls === 1) return jsonResponse(429, { error: "rate limited" });
    return jsonResponse(200, okPayload);
  };
  const res = await adapt(request, { apiKey: "k", fetch: fetchStub });
  assert.equal(calls, 2);
  assert.equal(res.answers.q.noul, 0.7);
});

test("retries after unusable output then succeeds", async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls++;
    if (calls === 1) {
      return jsonResponse(200, { ...okPayload, choices: [{ message: { content: "not json at all" } }] });
    }
    return jsonResponse(200, okPayload);
  };
  const res = await adapt(request, { apiKey: "k", fetch: fetchStub });
  assert.equal(calls, 2);
  assert.equal(res.answers.q.noul, 0.7);
});

test("throws after three failed attempts", async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls++;
    return jsonResponse(200, { ...okPayload, choices: [{ message: { content: "still not json" } }] });
  };
  await assert.rejects(() => adapt(request, { apiKey: "k", fetch: fetchStub }), (err) => err.status === 502);
  assert.equal(calls, 3);
});

test("hard upstream error fails fast without retry", async () => {
  let calls = 0;
  const fetchStub = async () => {
    calls++;
    return jsonResponse(401, { error: "bad key" });
  };
  await assert.rejects(() => adapt(request, { apiKey: "k", fetch: fetchStub }), /401/);
  assert.equal(calls, 1);
});

test("missing api key throws with status 500", async () => {
  await assert.rejects(() => adapt(request, { apiKey: "" }), (err) => err.status === 500);
});