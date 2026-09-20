import { describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import { handleRequest, parseAccessKeys } from "../src/http.ts";
import type { JevRequest } from "../src/format.ts";
import { isRecord } from "../src/guards.ts";

const TEST_KEY = "test-key";

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

function post(body: string, authorization: string | null = `Bearer ${TEST_KEY}`): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authorization !== null) headers.set("authorization", authorization);
  return new Request("http://x/v1/systemone", { method: "POST", headers, body });
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
    const res = await handleRequest(
      new Request("http://x/v1/systemone", { headers: { authorization: `Bearer ${TEST_KEY}` } }),
      {
        apiKey: "k",
        accessKeys: [TEST_KEY],
        fetch: okStub(),
      },
    );
    expect(res.status).toBe(405);
    expect(await jsonError(res)).toBe("method not allowed");
  });

  it("invalid json body returns 400", async () => {
    const res = await handleRequest(post("{not json"), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
      fetch: okStub(),
    });
    expect(res.status).toBe(400);
    expect(await jsonError(res)).toMatch(/^invalid request json: /u);
  });

  it("request validation failure returns 400", async () => {
    const res = await handleRequest(post(JSON.stringify({ state: "x", questions: {} })), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
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
      accessKeys: [TEST_KEY],
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
      accessKeys: [TEST_KEY],
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
    const res = await handleRequest(post(JSON.stringify(requestBody)), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
      fetch: bad,
    });
    expect(res.status).toBe(502);
    expect(await jsonError(res)).toMatch(/json/u);
  });
});

describe("handleRequest authentication", () => {
  it("missing authorization header returns 401 without calling upstream", async () => {
    const stub = okStub();
    const res = await handleRequest(post(JSON.stringify(requestBody), null), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
      fetch: stub,
    });
    expect(res.status).toBe(401);
    expect(await jsonError(res)).toBe("unauthorized");
    expect(stub.mock.calls.length).toBe(0);
  });

  it("wrong key of equal length returns 401", async () => {
    const res = await handleRequest(post(JSON.stringify(requestBody), "Bearer wrongkey"), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
      fetch: okStub(),
    });
    expect(res.status).toBe(401);
    expect(await jsonError(res)).toBe("unauthorized");
  });

  it("omitted accessKeys fails closed", async () => {
    const res = await handleRequest(post(JSON.stringify(requestBody)), {
      apiKey: "k",
      fetch: okStub(),
    });
    expect(res.status).toBe(401);
  });

  it("empty accessKeys returns 401", async () => {
    const res = await handleRequest(post(JSON.stringify(requestBody)), {
      apiKey: "k",
      accessKeys: [],
      fetch: okStub(),
    });
    expect(res.status).toBe(401);
  });
});

describe("handleRequest authentication edge cases", () => {
  it("comma-merged authorization header (web Headers semantics) returns 401", async () => {
    // Cloudflare/Vercel runtimes merge repeated request headers into one comma-joined value;
    // the captured token then contains ", " and matches no configured key.
    const headers = new Headers({
      "content-type": "application/json",
      authorization: `Bearer ${TEST_KEY}`,
    });
    headers.append("authorization", "Bearer other-key");
    expect(headers.get("authorization")).toBe(`Bearer ${TEST_KEY}, Bearer other-key`);

    const res = await handleRequest(
      new Request("http://x/v1/systemone", {
        method: "POST",
        headers,
        body: JSON.stringify(requestBody),
      }),
      { apiKey: "k", accessKeys: [TEST_KEY], fetch: okStub() },
    );
    expect(res.status).toBe(401);
  });

  it("wrong key of different length returns 401", async () => {
    const res = await handleRequest(post(JSON.stringify(requestBody), "Bearer much-longer-key"), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
      fetch: okStub(),
    });
    expect(res.status).toBe(401);
  });
});

describe("handleRequest authentication scheme and ordering", () => {
  it("lowercase bearer scheme is accepted", async () => {
    const res = await handleRequest(post(JSON.stringify(requestBody), "bearer test-key"), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
      fetch: okStub(),
    });
    expect(res.status).toBe(200);
  });

  it("non-Bearer scheme returns 401", async () => {
    const res = await handleRequest(post(JSON.stringify(requestBody), "Basic xxx"), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
      fetch: okStub(),
    });
    expect(res.status).toBe(401);
  });

  it("auth precedes the method check", async () => {
    const res = await handleRequest(new Request("http://x/v1/systemone"), {
      apiKey: "k",
      accessKeys: [TEST_KEY],
      fetch: okStub(),
    });
    expect(res.status).toBe(401);
  });
});

describe("parseAccessKeys", () => {
  it("undefined yields no keys", () => {
    expect(parseAccessKeys()).toEqual([]);
  });

  it("blank string yields no keys", () => {
    expect(parseAccessKeys("")).toEqual([]);
  });

  it("splits on commas", () => {
    expect(parseAccessKeys("a,b")).toEqual(["a", "b"]);
  });

  it("trims surrounding whitespace", () => {
    expect(parseAccessKeys(" a , b ")).toEqual(["a", "b"]);
  });

  it("drops empty entries", () => {
    expect(parseAccessKeys("a,,b")).toEqual(["a", "b"]);
  });
});
