import { describe, expect, it } from "vitest";
import { validateRequest, buildMessages, toJevResponse } from "../src/format.ts";
import type { JevAnswer, JevQuestion, JevRequest } from "../src/format.ts";

const urgency: JevQuestion = { type: "boolean", instructions: "紧急？" };
const department: JevQuestion = {
  type: "choice",
  instructions: "哪个团队？",
  criteria: { billing: "支付", technical: "系统", sales: "定价" },
};
const frustration: JevQuestion = {
  type: "score",
  instructions: "沮丧程度",
  criteria: ["平静", "不满", "愤怒"],
};

const request: JevRequest = {
  state: "客户投诉：重复扣款。",
  questions: { is_urgent: urgency, department, frustration },
};

function mustChoice(answer: JevAnswer | undefined): Extract<JevAnswer, { type: "choice" }> {
  if (answer === undefined || answer.type !== "choice") throw new Error("expected a choice answer");
  return answer;
}

function mustScore(answer: JevAnswer | undefined): Extract<JevAnswer, { type: "score" }> {
  if (answer === undefined || answer.type !== "score") throw new Error("expected a score answer");
  return answer;
}

describe("validateRequest", () => {
  it("rejects empty questions", () => {
    expect(() => validateRequest({ state: "x", questions: {} })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rejects score with single criterion", () => {
    const bad = { state: "x", questions: { q: { type: "score", criteria: ["only one"] } } };
    expect(() => validateRequest(bad)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rejects unknown type", () => {
    const bad = { state: "x", questions: { q: { type: "noul2" } } };
    expect(() => validateRequest(bad)).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("ignores extra request fields", () => {
    expect(() =>
      validateRequest({ model: "jev-latest", state: "x", questions: { q: { type: "noul" } } }),
    ).not.toThrow();
  });
});

describe("toJevResponse conversion", () => {
  it("noul output echoes input word", () => {
    const req: JevRequest = { state: "x", questions: { q: { type: "noul" } } };
    const res = toJevResponse(JSON.stringify({ answers: { q: { noul: 0.8 } } }), req, {});
    expect(res.answers["q"]).toEqual({ type: "noul", noul: 0.8 });
  });

  it("boolean output echoes input word", () => {
    const req: JevRequest = { state: "x", questions: { q: { type: "boolean" } } };
    const res = toJevResponse(JSON.stringify({ answers: { q: { probability: 0.8 } } }), req, {});
    expect(res.answers["q"]).toEqual({ type: "boolean", probability: 0.8 });
  });

  it("extracts json wrapped in markdown fences", () => {
    const raw = '```json\n{"answers":{"q":{"noul":0.5}}}\n```';
    const req: JevRequest = { state: "x", questions: { q: { type: "noul" } } };
    const res = toJevResponse(raw, req, {});
    expect(res.answers["q"]).toEqual({ type: "noul", noul: 0.5 });
  });

  it("normalizes choice probabilities", () => {
    const single: JevRequest = { state: "x", questions: { department } };
    const raw = JSON.stringify({
      answers: {
        department: {
          choice: "billing",
          probabilities: { billing: 0.9, technical: 0.05, sales: 0.05 },
        },
      },
    });
    const answer = mustChoice(toJevResponse(raw, single, {}).answers["department"]);
    expect(answer.choice).toBe("billing");
    const sum = Object.values(answer.probabilities).reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - 1)).toBeLessThan(1e-9);
    expect(answer.confidence).toBe(answer.probabilities["billing"]);
  });

  it("score is the probability-weighted expectation", () => {
    const single: JevRequest = { state: "x", questions: { frustration } };
    const raw = JSON.stringify({
      answers: { frustration: { score: 2, probabilities: { 0: 0, 1: 0.02, 2: 0.98 } } },
    });
    const answer = mustScore(toJevResponse(raw, single, {}).answers["frustration"]);
    expect(answer.score).toBeCloseTo(1.98, 10);
    expect(answer.legend["2"]).toBe("愤怒");
  });
});

describe("toJevResponse errors", () => {
  it("choice key outside criteria throws", () => {
    const single: JevRequest = { state: "x", questions: { department } };
    const raw = JSON.stringify({ answers: { department: { choice: "nope", probabilities: {} } } });
    expect(() => toJevResponse(raw, single, {})).toThrow(/department/u);
  });

  it("missing answer throws, naming the first missing id", () => {
    const raw = JSON.stringify({ answers: { is_urgent: { noul: 1 } } });
    expect(() => toJevResponse(raw, request, {})).toThrow(/department/u);
  });
});

describe("buildMessages", () => {
  it("serializes state and questions", () => {
    const [system, user] = buildMessages(request);
    expect(system.role).toBe("system");
    expect(system.content).toContain("json");
    expect(user.content).toContain("State:");
    expect(user.content).toContain("id: department");
    expect(user.content).toContain("- billing: 支付");
    expect(user.content).toContain("2: 愤怒");
  });
});

describe("buildMessages rendering branches", () => {
  it("renders boolean criteria and non-string state/instructions", () => {
    const req: JevRequest = {
      state: { amount: 42 },
      questions: {
        urgent: {
          type: "boolean",
          instructions: { text: "紧急？" },
          criteria: { true: "马上", false: "不急" },
        },
      },
    };
    const [, user] = buildMessages(req);
    expect(user.content).toContain('{"amount":42}');
    expect(user.content).toContain('{"text":"紧急？"}');
    expect(user.content).toContain("true: 马上");
    expect(user.content).toContain("false: 不急");
  });

  it("renders null criteria entries for choice and score", () => {
    const req: JevRequest = {
      state: "x",
      questions: {
        dept: { type: "choice", instructions: "哪个？", criteria: { billing: null, ops: "运维" } },
        level: { type: "score", instructions: "程度", criteria: ["低", null] },
      },
    };
    const [, user] = buildMessages(req);
    expect(user.content).toContain("- billing");
    expect(user.content).toContain("- ops: 运维");
    expect(user.content).toContain("0: 低");
    expect(user.content).toContain("1:");
  });
});

describe("validateRequest choice criteria", () => {
  it("rejects non-object and empty criteria", () => {
    expect(() =>
      validateRequest({ state: "x", questions: { q: { type: "choice", criteria: "nope" } } }),
    ).toThrow(expect.objectContaining({ status: 400 }));
    expect(() =>
      validateRequest({ state: "x", questions: { q: { type: "choice", criteria: {} } } }),
    ).toThrow(expect.objectContaining({ status: 400 }));
  });

  it("rejects non-object question entries", () => {
    expect(() => validateRequest({ state: "x", questions: { q: 7 } })).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });
});

describe("extractJson fallbacks", () => {
  it("balance-scans json out of surrounding prose", () => {
    const raw = 'Here you go: {"answers":{"q":{"noul":0.4}}} hope that helps';
    const req: JevRequest = { state: "x", questions: { q: { type: "noul" } } };
    expect(toJevResponse(raw, req, {}).answers["q"]).toEqual({ type: "noul", noul: 0.4 });
  });

  it("returns zero usage for non-record or non-numeric usage", () => {
    const req: JevRequest = { state: "x", questions: { q: { type: "noul" } } };
    const raw = JSON.stringify({ answers: { q: { noul: 0.4 } } });
    expect(toJevResponse(raw, req).usage).toEqual({ input_tokens: 0, output_tokens: 0 });
    expect(toJevResponse(raw, req, { input_tokens: "10" }).usage).toEqual({
      input_tokens: 0,
      output_tokens: 0,
    });
  });

  it("throws when the model output has no json object", () => {
    const req: JevRequest = { state: "x", questions: { q: { type: "noul" } } };
    expect(() => toJevResponse("no json here", req, {})).toThrow(/could not extract/u);
  });

  it("throws when noul probability is out of range", () => {
    const req: JevRequest = { state: "x", questions: { q: { type: "noul" } } };
    const raw = JSON.stringify({ answers: { q: { noul: 1.5 } } });
    expect(() => toJevResponse(raw, req, {})).toThrow(/probability/u);
  });

  it("throws when score probabilities sum to zero", () => {
    const req: JevRequest = {
      state: "x",
      questions: { s: { type: "score", criteria: ["a", "b"] } },
    };
    const raw = JSON.stringify({ answers: { s: { probabilities: { 0: 0, 1: 0 } } } });
    expect(() => toJevResponse(raw, req, {})).toThrow(/sum to zero/u);
  });

  it("reads string-index probabilities and skips invalid numbers", () => {
    const req: JevRequest = {
      state: "x",
      questions: { s: { type: "score", criteria: ["a", "b"] } },
    };
    const raw = JSON.stringify({ answers: { s: { probabilities: { "0": 0.25, "1": "bad" } } } });
    const answer = mustScore(toJevResponse(raw, req, {}).answers["s"]);
    expect(answer.probabilities).toEqual({ "0": 1, "1": 0 });
  });
});
