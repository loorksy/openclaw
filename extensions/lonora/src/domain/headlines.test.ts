import { afterEach, describe, expect, it } from "vitest";
import {
  describeHeadlines,
  headlineSetKey,
  parseFmpHeadlines,
  readGoldHeadlines,
  resetHeadlineCacheForTests,
} from "./headlines.js";

const NOW = Date.parse("2026-01-05T12:00:00Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("gold headlines", () => {
  afterEach(() => {
    resetHeadlineCacheForTests();
    delete process.env.LONORA_HEADLINES;
    delete process.env.FMP_API_KEY;
    delete process.env.NEWS_API_KEY;
  });

  it("keeps a gold or macro headline and drops an unrelated forex row", () => {
    const rows = parseFmpHeadlines([
      {
        title: "Gold slips before CPI",
        publishedDate: "2026-01-05 11:00:00",
        site: "Reuters",
        symbol: "XAUUSD",
        url: "https://example.com/gold",
      },
      {
        title: "Euro retail sales",
        publishedDate: "2026-01-05 11:00:00",
        site: "Reuters",
        symbol: "EURUSD",
      },
      {
        title: "Fed holds rates",
        publishedDate: "2026-01-05 10:00:00",
        site: "Bloomberg",
        symbol: "EURUSD",
        url: "https://example.com/?apikey=secret",
      },
    ]);
    expect(rows.map((row) => row.title)).toEqual(["Gold slips before CPI", "Fed holds rates"]);
    expect(rows[0]?.url).toBe("https://example.com/gold");
    expect(rows[1]?.url).toBeUndefined();
  });

  it("rejects a payload that is not a list", () => {
    expect(() => parseFmpHeadlines({ "Error Message": "Invalid API KEY" })).toThrow(
      /unexpected shape/,
    );
  });

  it("stays unknown when no key is configured", async () => {
    const read = await readGoldHeadlines({
      now: NOW,
      fetchImpl: () => Promise.reject(new Error("should not fetch")),
    });
    expect(read).toMatchObject({ ok: false, headlines: [], invented: false });
    expect(read.error).not.toMatch(/%/);
  });

  it("treats a successful empty feed as a quiet window", async () => {
    process.env.FMP_API_KEY = "test-key";
    const read = await readGoldHeadlines({
      now: NOW,
      fetchImpl: () => Promise.resolve(jsonResponse([])),
    });
    expect(read.ok).toBe(true);
    expect(read.headlines).toEqual([]);
    expect(read.invented).toBe(false);
    expect(describeHeadlines(read.headlines, "en")).toBe(
      "No gold-relevant headlines are in this window.",
    );
    expect(headlineSetKey(read.headlines)).toBe("none");
  });

  it("does not turn a failed feed into an empty window", async () => {
    process.env.FMP_API_KEY = "secret-key";
    const read = await readGoldHeadlines({
      now: NOW,
      fetchImpl: () => Promise.resolve(jsonResponse({ "Error Message": "secret-key" }, 401)),
    });
    expect(read.ok).toBe(false);
    expect(read.headlines).toEqual([]);
    expect(read.invented).toBe(false);
    expect(read.error).not.toContain("secret-key");
    expect(describeHeadlines([], "en")).not.toBe(read.error);
  });

  it("does not read a rejection object as an empty window", async () => {
    process.env.FMP_API_KEY = "secret-key";
    const read = await readGoldHeadlines({
      now: NOW,
      fetchImpl: () => Promise.resolve(jsonResponse({ "Error Message": "secret-key" })),
    });
    expect(read.ok).toBe(false);
    expect(read.headlines).toEqual([]);
    expect(read.error).not.toContain("secret-key");
  });

  it("can be switched off without reading a key", async () => {
    process.env.FMP_API_KEY = "secret-key";
    process.env.LONORA_HEADLINES = "off";
    let called = false;
    const read = await readGoldHeadlines({
      now: NOW,
      fetchImpl: () => {
        called = true;
        return Promise.resolve(jsonResponse([]));
      },
    });
    expect(called).toBe(false);
    expect(read.ok).toBe(false);
    expect(read.invented).toBe(false);
  });
});
