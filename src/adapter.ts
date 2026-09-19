// Orchestration: DeepSeek chat/completions call + retry, with injectable fetch for tests.

import { validateRequest, buildMessages, toJevResponse } from "./format.ts";
import type { JevResponse, JevRequest, HttpError } from "./format.ts";
import { isRecord, errorMessage } from "./guards.ts";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";
const DEFAULT_TIMEOUT_MS = 60000;
const MAX_ATTEMPTS = 3;

const THINKING_LEVELS: Record<string, true> = { low: true, high: true, max: true };

export type AdaptOptions = {
  apiKey?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  thinking?: string | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
};

type AttemptContext = {
  apiKey: string;
  baseUrl: string;
  model: string;
  body: Record<string, unknown>;
  validated: JevRequest;
  fetchImpl: typeof fetch;
  signal: AbortSignal | undefined;
  timeoutMs: number;
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
    body["reasoning_effort"] = thinking;
  } else {
    body["thinking"] = { type: "disabled" };
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
  const choices = payload["choices"];
  if (!Array.isArray(choices)) return undefined;
  const first: unknown = choices[0];
  if (!isRecord(first)) return undefined;
  const message = first["message"];
  if (!isRecord(message)) return undefined;
  return typeof message["content"] === "string" ? message["content"] : undefined;
}

function shouldRetry(status: number): boolean {
  return status === 429 || status >= 500;
}

function sendOnce(ctx: AttemptContext): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(ctx.timeoutMs);
  const signal =
    ctx.signal === undefined ? timeoutSignal : AbortSignal.any([ctx.signal, timeoutSignal]);
  return ctx.fetchImpl(`${ctx.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.apiKey}`,
    },
    body: JSON.stringify(ctx.body),
    signal,
  });
}

async function attempt(ctx: AttemptContext, attemptNumber: number): Promise<JevResponse> {
  let res: Response;
  try {
    res = await sendOnce(ctx);
  } catch (err) {
    if (attemptNumber >= MAX_ATTEMPTS) {
      throw fail(`upstream request failed: ${errorMessage(err)}`, 502);
    }
    await sleep(1000 * attemptNumber);
    return await attempt(ctx, attemptNumber + 1);
  }

  if (shouldRetry(res.status)) {
    if (attemptNumber >= MAX_ATTEMPTS) {
      throw fail(`upstream returned ${res.status}`, 502);
    }
    await sleep(1000 * attemptNumber);
    return await attempt(ctx, attemptNumber + 1);
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw fail(`upstream returned ${res.status}: ${text.slice(0, 300)}`, 502);
  }

  const payload: unknown = await res.json().catch(() => null);
  try {
    const response = toJevResponse(
      readChoiceContent(payload),
      ctx.validated,
      isRecord(payload) ? payload["usage"] : undefined,
    );
    const payloadModel =
      isRecord(payload) && typeof payload["model"] === "string" ? payload["model"] : undefined;
    response.model = payloadModel ?? ctx.model;
    return response;
  } catch (err) {
    if (attemptNumber >= MAX_ATTEMPTS) {
      throw fail(errorMessage(err), 502);
    }
    return await attempt(ctx, attemptNumber + 1);
  }
}

export async function adapt(request: unknown, options: AdaptOptions = {}): Promise<JevResponse> {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw fail(
      "DEEPSEEK_API_KEY is required (set it in the environment or use options.apiKey)",
      500,
    );
  }
  const model = options.model ?? DEFAULT_MODEL;
  const validated = validateRequest(request);
  const ctx: AttemptContext = {
    apiKey,
    baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
    model,
    body: buildBody(model, buildMessages(validated), options.thinking),
    validated,
    fetchImpl: options.fetch ?? fetch,
    signal: options.signal,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
  return await attempt(ctx, 1);
}
