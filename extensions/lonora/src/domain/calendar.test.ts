import { afterEach, describe, expect, it } from "vitest";
import {
  describeCalendarEvents,
  eventMatchesRequest,
  parseForexFactoryRows,
  readGoldCalendar,
  resetCalendarCacheForTests,
  upcomingHighImpactKey,
} from "./calendar.js";

const NOW = Date.parse("2026-01-05T12:00:00Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("economic calendar", () => {
  afterEach(() => {
    resetCalendarCacheForTests();
    delete process.env.LONORA_CALENDAR;
    delete process.env.FMP_API_KEY;
  });

  it("keeps USD and gold-relevant titles inside the window", () => {
    const from = new Date(NOW - 60_000);
    const to = new Date(NOW + 3_600_000);
    const input = { currencies: ["XAU"], from, to };
    expect(
      eventMatchesRequest(
        {
          title: "Retail Sales",
          time: new Date(NOW + 60_000).toISOString(),
          impact: "low",
          currency: "USD",
        },
        input,
      ),
    ).toBe(true);
    expect(
      eventMatchesRequest(
        {
          title: "German CPI",
          time: new Date(NOW + 60_000).toISOString(),
          impact: "high",
          currency: "EUR",
        },
        input,
      ),
    ).toBe(true);
    expect(
      eventMatchesRequest(
        {
          title: "Bank Holiday",
          time: new Date(NOW + 60_000).toISOString(),
          impact: "low",
          currency: "EUR",
        },
        input,
      ),
    ).toBe(false);
    expect(
      eventMatchesRequest(
        {
          title: "CPI",
          time: new Date(NOW + 86_400_000).toISOString(),
          impact: "high",
          currency: "USD",
        },
        input,
      ),
    ).toBe(false);
  });

  it("drops invalid Forex Factory rows and rejects a non-array", () => {
    expect(
      parseForexFactoryRows([
        { title: "CPI", country: "USD", date: "2026-01-05T13:30:00Z", impact: "High" },
        { title: " ", country: "USD", date: "2026-01-05T13:30:00Z", impact: "High" },
        { title: "Broken", country: "USD", date: "not-a-date", impact: "High" },
      ]),
    ).toEqual([
      {
        title: "CPI",
        time: "2026-01-05T13:30:00.000Z",
        impact: "high",
        currency: "USD",
      },
    ]);
    expect(() => parseForexFactoryRows({ events: [] })).toThrow(/unexpected shape/);
  });

  it("names a real event and does not invent one for an empty feed", async () => {
    const fetchImpl = async () =>
      jsonResponse([
        { title: "CPI", country: "USD", date: "2026-01-05T13:30:00Z", impact: "High" },
        { title: "Bank Holiday", country: "EUR", date: "2026-01-05T13:30:00Z", impact: "Holiday" },
      ]);
    const read = await readGoldCalendar({ now: NOW, fetchImpl });
    expect(read.ok).toBe(true);
    expect(read.invented).toBe(false);
    expect(read.events.map((event) => event.title)).toEqual(["CPI"]);
    expect(describeCalendarEvents(read.events, "en")).toContain("CPI");
    expect(describeCalendarEvents([], "ar")).toBe(
      "لا أحداث عالية أو متوسطة ذات صلة بالذهب في هذه النافذة.",
    );
    expect(upcomingHighImpactKey(read.events, NOW)).toContain("cpi");
    expect(upcomingHighImpactKey(read.events, NOW - 3 * 60 * 60_000)).toBe("none");
  });

  it("stays unknown when every source fails and does not reuse a stale cache", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse([]);
      }
      return jsonResponse({ error: "nope" }, 500);
    };
    const first = await readGoldCalendar({ now: NOW, fetchImpl });
    expect(first).toMatchObject({ ok: true, events: [], invented: false });
    const cached = await readGoldCalendar({ now: NOW + 60_000, fetchImpl });
    expect(cached.ok).toBe(true);
    expect(calls).toBe(1);
    const failed = await readGoldCalendar({ now: NOW + 20 * 60_000, fetchImpl });
    expect(failed.ok).toBe(true);
    expect(failed.stale).toBe(true);
    expect(failed.events).toEqual([]);
    const expired = await readGoldCalendar({ now: NOW + 3 * 60 * 60_000, fetchImpl });
    expect(expired.ok).toBe(false);
    expect(expired.events).toEqual([]);
    expect(expired.invented).toBe(false);
    expect(expired.error).not.toMatch(/quiet/i);
  });

  it("does not fetch when the calendar is switched off", async () => {
    process.env.LONORA_CALENDAR = "off";
    const read = await readGoldCalendar({
      now: NOW,
      fetchImpl: async () => {
        throw new Error("should not fetch");
      },
    });
    expect(read).toMatchObject({
      ok: false,
      events: [],
      invented: false,
      error: "Economic calendar is not configured.",
    });
  });
});
