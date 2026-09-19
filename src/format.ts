// Pure conversion logic: JEV request -> DeepSeek messages -> JEV response.
// No I/O here so it can be unit-tested offline.

import { isRecord } from "./guards.ts";

export type QuestionType = "boolean" | "noul" | "choice" | "score";

export type BooleanCriteria = { true?: unknown; false?: unknown };

export type JevQuestion =
  | { type: "boolean"; instructions?: unknown; criteria?: BooleanCriteria | null }
  | { type: "noul"; instructions?: unknown; criteria?: BooleanCriteria | null }
  | { type: "choice"; instructions?: unknown; criteria: Record<string, unknown> }
  | { type: "score"; instructions?: unknown; criteria: unknown[] };

export type JevRequest = { state?: unknown; questions: Record<string, JevQuestion> };

export type JevAnswer =
  | { type: "noul"; noul: number }
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; confidence: number; probabilities: Record<string, number> }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend: Record<string, unknown>;
      probabilities: Record<string, number>;
    };

export type JevResponse = {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage: { input_tokens: number; output_tokens: number };
};

export type ChatMessage = { role: "system" | "user"; content: string };

export type HttpError = Error & { status?: number };

const SUPPORTED_TYPES: Record<string, true> = {
  boolean: true,
  noul: true,
  choice: true,
  score: true,
};

// Prompt verified against deepseek-flash on 2026-09-19; do not reword.
const SYSTEM_PROMPT = `You are a structured decision engine. You answer typed questions about a given state. You never produce explanations, prose, or markdown — only one json object.

Output json format:
{"answers": {"<question_id>": <answer>}}

Answer schemas by question type:
- boolean: {"noul": <probability from 0 to 1 that the answer is yes>}
- choice: {"choice": "<exactly one criteria key>", "probabilities": {"<key>": <probability>, ...}}
- score: {"score": <number>, "probabilities": {"<index>": <probability>, ...}}

Rules:
- Each probability distribution must sum to about 1.
- Every question id must have an answer.
- Use only the state; never invent facts.`;

function badRequest(message: string): HttpError {
  return Object.assign(new Error(message), { status: 400 });
}

export function validateRequest(request: unknown): JevRequest {
  if (!isRecord(request)) throw badRequest("request must be an object");
  const { questions } = request;
  if (!isRecord(questions)) throw badRequest("questions is required");
  const ids = Object.keys(questions);
  if (ids.length === 0) throw badRequest("questions is required");
  for (const id of ids) {
    const q: unknown = questions[id];
    if (!isRecord(q)) throw badRequest(`question ${id}: must be an object`);
    const type = q.type;
    if (typeof type !== "string" || SUPPORTED_TYPES[type] !== true) {
      throw badRequest(`unsupported question type: ${type}`);
    }
    if (type === "score") {
      const criteria = q.criteria;
      if (!Array.isArray(criteria) || criteria.length < 2) {
        throw badRequest(`question ${id}: score criteria must be an array of length >= 2`);
      }
    }
    if (type === "choice") {
      const criteria = q.criteria;
      if (!isRecord(criteria)) {
        throw badRequest(`question ${id}: choice criteria must be an object`);
      }
      if (Object.keys(criteria).length === 0) {
        throw badRequest(`question ${id}: choice criteria must not be empty`);
      }
    }
  }
  // Every field consumed downstream (questions[].type / .criteria) was checked above; the
  // remaining declared fields (state, instructions) are opaque to consumers by design.
  return request as JevRequest;
}

function serializeEntry(value: unknown): string {
  if (typeof value === "string") return value;
  return String(JSON.stringify(value));
}

function renderInstructions(instructions: unknown): string {
  if (typeof instructions === "string") return instructions;
  return String(JSON.stringify(instructions));
}

function renderQuestion(id: string, q: JevQuestion): string {
  const lines = [`id: ${id}`, `type: ${q.type}`, `Question: ${renderInstructions(q.instructions)}`];
  if (q.type === "choice") {
    lines.push("criteria:");
    for (const [key, desc] of Object.entries(q.criteria)) {
      lines.push(desc === null ? `- ${key}` : `- ${key}: ${desc}`);
    }
  } else if (q.type === "score") {
    lines.push("criteria:");
    q.criteria.forEach((desc, index) => {
      lines.push(`${index}: ${desc === null ? "" : desc}`.trimEnd());
    });
  } else if (q.criteria && typeof q.criteria === "object") {
    lines.push("criteria:");
    if (q.criteria.true !== undefined) lines.push(`true: ${renderInstructions(q.criteria.true)}`);
    if (q.criteria.false !== undefined)
      lines.push(`false: ${renderInstructions(q.criteria.false)}`);
  }
  return lines.join("\n");
}

export function buildMessages(request: JevRequest): ChatMessage[] {
  const blocks = Object.entries(request.questions).map(([id, q]) => renderQuestion(id, q));
  const user = `State:\n${serializeEntry(request.state)}\n\nQuestions:\n${blocks.join("\n\n")}`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

// --- response conversion -----------------------------------------------------

function extractJson(text: unknown): Record<string, unknown> | null {
  if (typeof text !== "string") return null;

  const attempts = [text];

  // Strip markdown fences if present.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) attempts.push(fenced[1].trim());

  // Balance-scan from the first "{" as a last resort.
  const start = text.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          attempts.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }

  for (const candidate of attempts) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function normalizeDistribution(values: number[]): number[] | null {
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return values.map((v) => v / total);
}

function readProbability(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function convertBoolean(q: JevQuestion, answer: Record<string, unknown>, id: string): JevAnswer {
  const raw = answer.noul !== undefined ? answer.noul : answer.probability;
  const p = readProbability(raw);
  if (p === null) throw new Error(`${id}: boolean answer must be a probability in [0,1]`);
  return q.type === "noul" ? { type: "noul", noul: p } : { type: "boolean", probability: p };
}

type ChoiceQuestion = Extract<JevQuestion, { type: "choice" }>;
type ScoreQuestion = Extract<JevQuestion, { type: "score" }>;

function convertChoice(q: ChoiceQuestion, answer: Record<string, unknown>, id: string): JevAnswer {
  const keys = Object.keys(q.criteria);
  if (typeof answer.choice !== "string" || !keys.includes(answer.choice)) {
    throw new Error(
      `${id}: choice ${JSON.stringify(answer.choice)} is not one of the criteria keys`,
    );
  }
  const source = answer.probabilities;
  if (!isRecord(source)) throw new Error(`${id}: choice probabilities must be an object`);
  const raw = keys.map((key) => readProbability(source[key]) ?? 0);
  const normalized = normalizeDistribution(raw);
  if (normalized === null) throw new Error(`${id}: choice probabilities sum to zero`);
  const probabilities: Record<string, number> = {};
  keys.forEach((key, i) => {
    probabilities[key] = normalized[i];
  });
  return {
    type: "choice",
    choice: answer.choice,
    confidence: Math.max(...normalized),
    probabilities,
  };
}

function convertScore(q: ScoreQuestion, answer: Record<string, unknown>, id: string): JevAnswer {
  const n = q.criteria.length;
  const source = answer.probabilities;
  if (!isRecord(source)) throw new Error(`${id}: score probabilities must be an object`);
  const raw: number[] = [];
  for (let i = 0; i < n; i++) {
    const value = source[i] !== undefined ? source[i] : source[String(i)];
    raw.push(readProbability(value) ?? 0);
  }
  const normalized = normalizeDistribution(raw);
  if (normalized === null) throw new Error(`${id}: score probabilities sum to zero`);
  let expected = 0;
  const probabilities: Record<string, number> = {};
  normalized.forEach((p, i) => {
    expected += i * p;
    probabilities[String(i)] = p;
  });
  const legend: Record<string, unknown> = {};
  q.criteria.forEach((desc, i) => {
    legend[String(i)] = desc;
  });
  return {
    type: "score",
    score: expected,
    confidence: Math.max(...normalized),
    legend,
    probabilities,
  };
}

export function toJevResponse(rawText: unknown, request: JevRequest, usage?: unknown): JevResponse {
  const parsed = extractJson(rawText);
  if (parsed === null) throw new Error("could not extract a json object from model output");
  const answers = parsed.answers;
  if (!isRecord(answers)) throw new Error("model output is missing the answers object");
  const out: Record<string, JevAnswer> = {};
  for (const [id, q] of Object.entries(request.questions)) {
    const answer = answers[id];
    if (!isRecord(answer)) throw new Error(`${id}: missing answer from model output`);
    if (q.type === "boolean" || q.type === "noul") out[id] = convertBoolean(q, answer, id);
    else if (q.type === "choice") out[id] = convertChoice(q, answer, id);
    else out[id] = convertScore(q, answer, id);
  }
  const usageRecord = isRecord(usage) ? usage : undefined;
  const inputRaw = usageRecord?.input_tokens ?? usageRecord?.prompt_tokens;
  const outputRaw = usageRecord?.output_tokens ?? usageRecord?.completion_tokens;
  const model = typeof parsed.model === "string" ? parsed.model : undefined;
  return {
    model,
    answers: out,
    usage: {
      input_tokens: typeof inputRaw === "number" && Number.isFinite(inputRaw) ? inputRaw : 0,
      output_tokens: typeof outputRaw === "number" && Number.isFinite(outputRaw) ? outputRaw : 0,
    },
  };
}
