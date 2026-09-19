// Orchestration: DeepSeek chat/completions call + retry, with injectable fetch for tests.

import { validateRequest, buildMessages, toJevResponse } from "./format.ts";
import type { JevResponse, HttpError } from "./format.ts";
import { isRecord, errorMessage } from "./guards.ts";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 3;

const THINKING_LEVELS: Record<string, true> = { low: true, high: true, max: true };

export type AdaptOptions = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  thinking?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
};

function fail(message: string, status: number): HttpError {
  return Object.assign(new Error(message), { status });
}

function buildBody(model: string, messages: unknown, thinking?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: 0.2,
    max_tokens: 2000,
    response_format: { type: "json_object" },
  };
  if (thinking && THINKING_LEVELS[thinking] === true) {
    body.reasoning_effort = thinking;
  } else {
    body.thinking = { type: "disabled" };
  }
  return body;
}

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

// Reads choices[0].message.content from a raw chat/completions payload, if present.
function readChoiceContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const choices = payload.choices;
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (!isRecord(first)) return undefined;
  const message = first.message;
  if (!isRecord(message)) return undefined;
  return typeof message.content === "string" ? message.content : undefined;
}

export async function adapt(request: unknown, options: AdaptOptions = {}): Promise<JevResponse> {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw fail(
      "DEEPSEEK_API_KEY is required (set it in the environment or use options.apiKey)",
      500,
    );
  }

  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;

  const validated = validateRequest(request);
  const messages = buildMessages(validated);
  const body = buildBody(model, messages, options.thinking);

  let lastError: HttpError | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
    let res: Response;
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
      lastError = fail(`upstream request failed: ${errorMessage(err)}`, 502);
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

    const payload: unknown = await res.json().catch(() => null);
    try {
      const response = toJevResponse(
        readChoiceContent(payload),
        validated,
        isRecord(payload) ? payload.usage : undefined,
      );
      const payloadModel =
        isRecord(payload) && typeof payload.model === "string" ? payload.model : undefined;
      response.model = payloadModel ?? model;
      return response;
    } catch (err) {
      lastError = fail(errorMessage(err), 502);
    }
  }
  throw lastError;
}
