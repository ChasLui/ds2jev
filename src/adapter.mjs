// Orchestration: DeepSeek chat/completions call + retry, with injectable fetch for tests.

import { validateRequest, buildMessages, toJevResponse } from "./format.mjs";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 3;

const THINKING_LEVELS = new Set(["low", "high", "max"]);

function fail(message, status) {
  const err = new Error(message);
  if (status) err.status = status;
  return err;
}

function extractionError(message) {
  return fail(message, 502);
}

function buildBody(model, messages, thinking) {
  const body = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 2000,
    response_format: { type: "json_object" },
  };
  if (thinking && THINKING_LEVELS.has(thinking)) {
    body.reasoning_effort = thinking;
  } else {
    body.thinking = { type: "disabled" };
  }
  return body;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function adapt(request, options = {}) {
  const apiKey = options.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw fail("DEEPSEEK_API_KEY is required (set it in the environment or use options.apiKey)", 500);
  }

  const baseUrl = options.baseUrl ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL;
  const model = options.model ?? process.env.DEEPSEEK_MODEL ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  validateRequest(request);
  const messages = buildMessages(request);
  const body = buildBody(model, messages, options.thinking);

  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)].filter(Boolean));
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      lastError = fail(`upstream request failed: ${err.message}`, 502);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * attempt);
        continue;
      }
      throw lastError;
    }

    if (res.status === 429 || res.status >= 500) {
      lastError = fail(`upstream returned ${res.status}`, 502);
      if (attempt < MAX_ATTEMPTS) {
        await sleep(1000 * attempt);
        continue;
      }
      throw lastError;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw fail(`upstream returned ${res.status}: ${text.slice(0, 300)}`, 502);
    }

    const payload = await res.json().catch(() => null);
    const content = payload?.choices?.[0]?.message?.content;
    try {
      const response = toJevResponse(content, request, payload?.usage);
      response.model = payload?.model ?? model;
      return response;
    } catch (err) {
      lastError = extractionError(err.message);
    }
  }
  throw lastError;
}