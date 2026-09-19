// Pure conversion logic: JEV request -> DeepSeek messages -> JEV response.
// No I/O here so it can be unit-tested offline.

const SUPPORTED_TYPES = new Set(["boolean", "noul", "choice", "score"]);

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

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

export function validateRequest(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw badRequest("request must be an object");
  }
  const { questions } = request;
  if (questions === null || typeof questions !== "object" || Array.isArray(questions)) {
    throw badRequest("questions is required");
  }
  const ids = Object.keys(questions);
  if (ids.length === 0) {
    throw badRequest("questions is required");
  }
  for (const id of ids) {
    const q = questions[id];
    if (q === null || typeof q !== "object" || Array.isArray(q)) {
      throw badRequest(`question ${id}: must be an object`);
    }
    if (!SUPPORTED_TYPES.has(q.type)) {
      throw badRequest(`unsupported question type: ${q.type}`);
    }
    if (q.type === "score") {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2) {
        throw badRequest(`question ${id}: score criteria must be an array of length >= 2`);
      }
    }
    if (q.type === "choice") {
      if (q.criteria === null || typeof q.criteria !== "object" || Array.isArray(q.criteria)) {
        throw badRequest(`question ${id}: choice criteria must be an object`);
      }
      if (Object.keys(q.criteria).length === 0) {
        throw badRequest(`question ${id}: choice criteria must not be empty`);
      }
    }
  }
  return request;
}

function serializeEntry(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function renderInstructions(instructions) {
  if (typeof instructions === "string") return instructions;
  return JSON.stringify(instructions);
}

function renderQuestion(id, q) {
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
    if (q.criteria.false !== undefined) lines.push(`false: ${renderInstructions(q.criteria.false)}`);
  }
  return lines.join("\n");
}

export function buildMessages(request) {
  const blocks = Object.entries(request.questions).map(([id, q]) => renderQuestion(id, q));
  const user = `State:\n${serializeEntry(request.state)}\n\nQuestions:\n${blocks.join("\n\n")}`;
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: user },
  ];
}

// --- response conversion -----------------------------------------------------

function extractJson(text) {
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
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // try next candidate
    }
  }
  return null;
}

function normalizeDistribution(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return null;
  return values.map((v) => v / total);
}

function readProbability(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return value;
}

function convertBoolean(q, answer, id) {
  const raw = answer.noul !== undefined ? answer.noul : answer.probability;
  const p = readProbability(raw);
  if (p === null) throw new Error(`${id}: boolean answer must be a probability in [0,1]`);
  return q.type === "noul" ? { type: "noul", noul: p } : { type: "boolean", probability: p };
}

function convertChoice(q, answer, id) {
  const keys = Object.keys(q.criteria);
  if (typeof answer.choice !== "string" || !keys.includes(answer.choice)) {
    throw new Error(`${id}: choice ${JSON.stringify(answer.choice)} is not one of the criteria keys`);
  }
  if (answer.probabilities === null || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) {
    throw new Error(`${id}: choice probabilities must be an object`);
  }
  const raw = keys.map((key) => readProbability(answer.probabilities[key]) ?? 0);
  const normalized = normalizeDistribution(raw);
  if (normalized === null) throw new Error(`${id}: choice probabilities sum to zero`);
  const probabilities = {};
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

function convertScore(q, answer, id) {
  const n = q.criteria.length;
  if (answer.probabilities === null || typeof answer.probabilities !== "object" || Array.isArray(answer.probabilities)) {
    throw new Error(`${id}: score probabilities must be an object`);
  }
  const raw = [];
  for (let i = 0; i < n; i++) {
    const value = answer.probabilities[i] !== undefined ? answer.probabilities[i] : answer.probabilities[String(i)];
    raw.push(readProbability(value) ?? 0);
  }
  const normalized = normalizeDistribution(raw);
  if (normalized === null) throw new Error(`${id}: score probabilities sum to zero`);
  let expected = 0;
  const probabilities = {};
  normalized.forEach((p, i) => {
    expected += i * p;
    probabilities[String(i)] = p;
  });
  const legend = {};
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

export function toJevResponse(rawText, request, usage) {
  const parsed = extractJson(rawText);
  if (parsed === null) throw new Error("could not extract a json object from model output");
  const answers = parsed.answers;
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    throw new Error("model output is missing the answers object");
  }
  const out = {};
  for (const [id, q] of Object.entries(request.questions)) {
    const answer = answers[id];
    if (answer === null || typeof answer !== "object" || Array.isArray(answer)) {
      throw new Error(`${id}: missing answer from model output`);
    }
    if (q.type === "boolean" || q.type === "noul") out[id] = convertBoolean(q, answer, id);
    else if (q.type === "choice") out[id] = convertChoice(q, answer, id);
    else out[id] = convertScore(q, answer, id);
  }
  return {
    model: parsed.model,
    answers: out,
    usage: {
      input_tokens: usage?.input_tokens ?? usage?.prompt_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? usage?.completion_tokens ?? 0,
    },
  };
}