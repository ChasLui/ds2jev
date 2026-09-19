import { describe, expect, it } from "vitest";
import { errorMessage, isRecord, statusOf } from "../src/guards.ts";

describe("isRecord", () => {
  it("accepts plain objects and rejects everything else", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("x")).toBe(false);
    expect(isRecord(1)).toBe(false);
  });
});

describe("errorMessage", () => {
  it("extracts Error messages and stringifies other throws", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    const missing: unknown = undefined;
    expect(errorMessage(missing)).toBe("undefined");
  });
});

describe("statusOf", () => {
  it("reads numeric status off error-like objects only", () => {
    expect(statusOf(Object.assign(new Error("x"), { status: 502 }))).toBe(502);
    expect(statusOf({ status: 400 })).toBe(400);
    expect(statusOf({ status: "400" })).toBeUndefined();
    expect(statusOf("nope")).toBeUndefined();
    expect(statusOf(null)).toBeUndefined();
  });
});
