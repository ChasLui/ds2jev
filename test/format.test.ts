import test from "node:test";
import assert from "node:assert/strict";
import { validateRequest, buildMessages, toJevResponse } from "../src/format.ts";
import type { JevRequest } from "../src/format.ts";
import { errorMessage, statusOf } from "../src/guards.ts";

const request: JevRequest = {
  state: "客户投诉：重复扣款。",
  questions: {
    is_urgent: { type: "boolean", instructions: "紧急？" },
    department: {
      type: "choice",
      instructions: "哪个团队？",
      criteria: { billing: "支付", technical: "系统", sales: "定价" },
    },
    frustration: {
      type: "score",
      instructions: "沮丧程度",
      criteria: ["平静", "不满", "愤怒"],
    },
  },
};

test("validateRequest rejects empty questions", () => {
  assert.throws(
    () => validateRequest({ state: "x", questions: {} }),
    (err) => statusOf(err) === 400,
  );
});

test("validateRequest rejects score with single criterion", () => {
  const bad = { state: "x", questions: { q: { type: "score", criteria: ["only one"] } } };
  assert.throws(
    () => validateRequest(bad),
    (err) => statusOf(err) === 400,
  );
});

test("validateRequest rejects unknown type", () => {
  const bad = { state: "x", questions: { q: { type: "noul2" } } };
  assert.throws(
    () => validateRequest(bad),
    (err) => statusOf(err) === 400,
  );
});

test("validateRequest ignores extra request fields", () => {
  validateRequest({ model: "jev-latest", state: "x", questions: { q: { type: "noul" } } });
});

test("noul output echoes input word", () => {
  const req: JevRequest = { state: "x", questions: { q: { type: "noul" } } };
  const res = toJevResponse(JSON.stringify({ answers: { q: { noul: 0.8 } } }), req, {});
  assert.deepEqual(res.answers.q, { type: "noul", noul: 0.8 });
});

test("boolean output echoes input word", () => {
  const req: JevRequest = { state: "x", questions: { q: { type: "boolean" } } };
  const res = toJevResponse(JSON.stringify({ answers: { q: { probability: 0.8 } } }), req, {});
  assert.deepEqual(res.answers.q, { type: "boolean", probability: 0.8 });
});

test("extracts json wrapped in markdown fences", () => {
  const raw = '```json\n{"answers":{"q":{"noul":0.5}}}\n```';
  const req: JevRequest = { state: "x", questions: { q: { type: "noul" } } };
  const res = toJevResponse(raw, req, {});
  assert.deepEqual(res.answers.q, { type: "noul", noul: 0.5 });
});

test("normalizes choice probabilities", () => {
  const single: JevRequest = {
    state: "x",
    questions: { department: request.questions.department },
  };
  const raw = JSON.stringify({
    answers: {
      department: {
        choice: "billing",
        probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 },
      },
    },
  });
  const res = toJevResponse(raw, single, {});
  const answer = res.answers.department;
  if (answer === undefined || answer.type !== "choice") throw new Error("expected a choice answer");
  assert.equal(answer.choice, "billing");
  const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  assert.equal(answer.confidence, answer.probabilities.billing);
});

test("score is the probability-weighted expectation", () => {
  const single: JevRequest = {
    state: "x",
    questions: { frustration: request.questions.frustration },
  };
  const raw = JSON.stringify({
    answers: { frustration: { score: 2, probabilities: { 0: 0, 1: 0.02, 2: 0.98 } } },
  });
  const res = toJevResponse(raw, single, {});
  const answer = res.answers.frustration;
  if (answer === undefined || answer.type !== "score") throw new Error("expected a score answer");
  assert.ok(Math.abs(answer.score - 1.98) < 1e-9);
  assert.equal(answer.legend["2"], "愤怒");
});

test("choice key outside criteria throws", () => {
  const single: JevRequest = {
    state: "x",
    questions: { department: request.questions.department },
  };
  const raw = JSON.stringify({ answers: { department: { choice: "nope", probabilities: {} } } });
  assert.throws(() => toJevResponse(raw, single, {}), /department/);
});

test("missing answer throws", () => {
  const raw = JSON.stringify({ answers: { is_urgent: { noul: 1 } } });
  assert.throws(
    () => {
      toJevResponse(raw, request, {});
    },
    (err) => {
      // first missing id encountered must be named
      return /department/.test(errorMessage(err));
    },
  );
});

test("buildMessages serializes state and questions", () => {
  const [system, user] = buildMessages(request);
  assert.equal(system.role, "system");
  assert.ok(system.content.includes("json"));
  assert.ok(user.content.includes("State:"));
  assert.ok(user.content.includes("id: department"));
  assert.ok(user.content.includes("- billing: 支付"));
  assert.ok(user.content.includes("2: 愤怒"));
});
