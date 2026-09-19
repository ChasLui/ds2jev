import { afterEach, describe, expect, it, vi } from "vitest";
import { adapt } from "../src/adapter.ts";
import type { JevRequest } from "../src/format.ts";
import { isRecord } from "../src/guards.ts";

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

describe("adapt request shape", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends json_object response_format and disabled thinking", async () => {
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockResolvedValue(jsonResponse(200, okPayload));
    const res = await adapt(request, { apiKey: "k", fetch: fetchStub });
    expect(readBody(fetchStub.mock.calls[0]?.[1])).toMatchObject({
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
    });
    expect(res.answers["q"]).toEqual({ type: "noul", noul: 0.7 });
    expect(res.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("thinking level switches to reasoning_effort without thinking field", async () => {
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockResolvedValue(jsonResponse(200, okPayload));
    await adapt(request, { apiKey: "k", thinking: "high", fetch: fetchStub });
    const body = readBody(fetchStub.mock.calls[0]?.[1]);
    expect(body).toMatchObject({ reasoning_effort: "high" });
    expect(body).not.toHaveProperty("thinking");
  });
});

describe("adapt retry policy", () => {
  it("retries after 429 then succeeds", async () => {
    vi.useFakeTimers();
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub
      .mockResolvedValueOnce(jsonResponse(429, { error: "rate limited" }))
      .mockResolvedValueOnce(jsonResponse(200, okPayload));
    const pending = adapt(request, { apiKey: "k", fetch: fetchStub });
    await vi.runAllTimersAsync();
    const res = await pending;
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(res.answers["q"]).toEqual({ type: "noul", noul: 0.7 });
  });

  it("retries after unusable output then succeeds", async () => {
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub
      .mockResolvedValueOnce(
        jsonResponse(200, {
          ...okPayload,
          choices: [{ message: { content: "not json at all" } }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200, okPayload));
    const res = await adapt(request, { apiKey: "k", fetch: fetchStub });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    expect(res.answers["q"]).toEqual({ type: "noul", noul: 0.7 });
  });
});

describe("adapt failures", () => {
  it("throws after three failed attempts", async () => {
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockResolvedValue(
      jsonResponse(200, {
        ...okPayload,
        choices: [{ message: { content: "still not json" } }],
      }),
    );
    await expect(adapt(request, { apiKey: "k", fetch: fetchStub })).rejects.toThrow(
      expect.objectContaining({ status: 502 }),
    );
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("hard upstream error fails fast without retry", async () => {
    const fetchStub = vi.fn<typeof fetch>();
    fetchStub.mockResolvedValue(jsonResponse(401, { error: "bad key" }));
    await expect(adapt(request, { apiKey: "k", fetch: fetchStub })).rejects.toThrow(/401/u);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("missing api key throws with status 500", async () => {
    await expect(adapt(request, { apiKey: "" })).rejects.toThrow(
      expect.objectContaining({ status: 500 }),
    );
  });
});
