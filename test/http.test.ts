import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { handleRequest } from "../src/http.ts";
import type { JevRequest } from "../src/format.ts";
import { isRecord } from "../src/guards.ts";

const requestBody: JevRequest = {
  state: "x",
  questions: { q: { type: "noul", instructions: "yes?" } },
};

const okPayload = {
  model: "deepseek-flash",
  choices: [{ message: { content: '{"answers":{"q":{"noul":0.7}}}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

function okStub(): Mock<typeof fetch> {
  const stub = vi.fn<typeof fetch>();
  stub.mockResolvedValue(
    new Response(JSON.stringify(okPayload), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  return stub;
}

function post(body: string): Request {
  return new Request("http://x/v1/systemone", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function mustRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected an object ${what}`);
  return value;
}

async function jsonError(res: Response): Promise<string> {
  const payload = mustRecord(await res.json(), "payload");
  const error = mustRecord(payload["error"], "error");
  const message = error["message"];
  if (typeof message !== "string") throw new Error("expected error.message");
  return message;
}

describe("handleRequest routing and validation", () => {
  it("non-POST method returns 405", async () => {
    const res = await handleRequest(new Request("http://x/v1/systemone"), {
      apiKey: "k",
      fetch: okStub(),
    });
    expect(res.status).toBe(405);
    expect(await jsonError(res)).toBe("method not allowed");
  });

  it("invalid json body returns 400", async () => {
    const res = await handleRequest(post("{not json"), { apiKey: "k", fetch: okStub() });
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toMatch(/^invalid request json: /u);
  });

  it("request validation failure returns 400", async () => {
    const res = await handleRequest(post(JSON.stringify({ state: "x", questions: {} })), {
      apiKey: "k",
      fetch: okStub(),
    });
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toBe("questions is required");
  });
});

describe("handleRequest adaptation outcomes", () => {
  it("valid request returns 200 with the full answer set", async () => {
    const res = await handleRequest(post(JSON.stringify(requestBody)), {
      apiKey: "k",
      fetch: okStub(),
    });
    expect(res.status).toBe(200);
    const payload = mustRecord(await res.json(), "payload");
    expect(payload["answers"]).toEqual({ q: { type: "noul", noul: 0.7 } });
    const usage = mustRecord(payload["usage"], "usage");
    expect(usage["input_tokens"]).toBe(10);
  });

  it("missing api key returns 500", async () => {
    const res = await handleRequest(post(JSON.stringify(requestBody)), {
      apiKey: undefined,
      fetch: okStub(),
    });
    expect(res.status).toBe(500);
    expect(await jsonError(res)).toMatch(/DEEPSEEK_API_KEY/u);
  });

  it("three unusable upstream outputs return 502", async () => {
    const bad = vi.fn<typeof fetch>();
    bad.mockResolvedValue(
      new Response(
        JSON.stringify({ ...okPayload, choices: [{ message: { content: "still not json" } }] }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const res = await handleRequest(post(JSON.stringify(requestBody)), { apiKey: "k", fetch: bad });
    expect(res.status).toBe(502);
    expect(await jsonError(res)).toMatch(/json/u);
  });
});
