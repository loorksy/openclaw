import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runSpecialist } from "./domain/agents.js";
import type { Candle } from "./domain/candles.js";
import { detectSwings, detectTrend } from "./domain/candles.js";
import { copy, describeNotice } from "./domain/copy.js";
import { readGoldCandles } from "./domain/market-data.js";
import { candlesVisibleAt, isGoldMarketOpenAt, readMarketClock } from "./domain/market.js";
import { decideMonitorAction, nextNotice, shouldNotify } from "./domain/monitor.js";
import { OwnerSelectionRequired, resolveOwnerCandidate } from "./domain/owner.js";
import { assertPermission, authorizeTrade, blockReasonForTool } from "./domain/permissions.js";
import { probeProvider } from "./domain/providers.js";
import { evaluateRecommendation, type RecommendationPlan } from "./domain/recommendations.js";
import {
  checkResponsibility,
  cronForResponsibility,
  responsibilityEventText,
} from "./domain/responsibilities.js";
import { dailyBudgetAllows, estimateCostUsd, rollupUsage, usageIdentity } from "./domain/usage.js";
import { planBotyMigration } from "./migrate-boty.js";
import { LONORA_TOOL_ALLOW } from "./policy.js";
import { LonoraService } from "./service.js";
import { LonoraStore } from "./store.js";

function impulseZones(now: number): Candle[] {
  const bars: Candle[] = [];
  for (let index = 0; index < 13; index += 1) {
    bars.push({
      time: now - (16 - index) * 3_600_000,
      open: 100,
      high: 101,
      low: 99,
      close: 100,
    });
  }
  bars.push(
    {
      time: now - 3 * 3_600_000,
      open: 100,
      high: 101,
      low: 98,
      close: 99,
    },
    {
      time: now - 2 * 3_600_000,
      open: 102,
      high: 113,
      low: 101,
      close: 112,
    },
    {
      time: now - 3_600_000,
      open: 112,
      high: 112,
      low: 89,
      close: 90,
    },
  );
  return bars;
}

function breakCandles(mode: "close" | "wick" | "short"): Candle[] {
  const count = mode === "short" ? 4 : 12;
  return Array.from({ length: count }, (_, index) => {
    const close = mode === "close" && index === 8 ? 111 : 100;
    const high =
      index === 4
        ? 110
        : mode === "wick" && index === 8
          ? 113
          : index === 8
            ? 111
            : index > 8
              ? 112
              : 101;
    return {
      time: 1_700_000_000_000 + index * 3_600_000,
      open: 100,
      high,
      low: 99,
      close,
    };
  });
}

function hourlyCloses(now: number, closes: number[]): Candle[] {
  return closes.map((close, index) => ({
    time: now - (closes.length - index) * 3_600_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
  }));
}

/** Rising hourly swings. Ninety-six bars fold into a bullish four-hour read. */
function hourlyZigzag(count: number, start = 1_700_000_000_000): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const phase = index % 8;
    const cycle = Math.floor(index / 8);
    const close = 100 + cycle * 6 + (phase < 4 ? phase * 2 : (8 - phase) * 1.5);
    return {
      time: start + index * 3_600_000,
      open: close,
      high: close + (phase === 3 ? 10 : 0.4),
      low: close - (phase === 7 ? 10 : 0.4),
      close,
    };
  });
}

/** The four-hour window stays up while the latest swings step down. */
function conflictingHours(): Candle[] {
  const rising = hourlyZigzag(96);
  const peak = rising.at(-1)?.close ?? 100;
  const pullback = Array.from({ length: 32 }, (_, index) => {
    const phase = index % 8;
    const cycle = Math.floor(index / 8);
    const close = peak - 4 - cycle * 3 - (phase < 4 ? phase : 8 - phase);
    return {
      time: (rising.at(-1)?.time ?? 1_700_000_000_000) + (index + 1) * 3_600_000,
      open: close,
      high: close + (phase === 3 ? 10 : 0.4),
      low: close - (phase === 7 ? 10 : 0.4),
      close,
    };
  });
  return [...rising, ...pullback];
}

function risingCandles(count: number, start = 2300): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const close = start + index;
    return {
      time: 1_700_000_000_000 + index * 60_000,
      open: close - 0.4,
      high: close + 0.2,
      low: close - 0.6,
      close,
    };
  });
}

function plan(overrides: Partial<RecommendationPlan> = {}): RecommendationPlan {
  return {
    id: "rec-1",
    symbol: "XAUUSD",
    direction: "buy",
    entryType: "limit_touch",
    entry: 2300,
    stopLoss: 2290,
    targets: [2320, 2330, 2340],
    status: "pending_entry",
    outcome: "pending",
    createdCandleTime: 1_000,
    createdAt: 1_000,
    ...overrides,
  };
}

function candle(time: number, low: number, high: number, close = (low + high) / 2) {
  return { time, open: close, high, low, close };
}

describe("plugin contract", () => {
  it("declares every Lonora model tool, including headlines", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { contracts: { tools: string[] } };
    const owned = LONORA_TOOL_ALLOW.filter((name) => name.startsWith("lonora_"));
    expect(owned.every((name) => manifest.contracts.tools.includes(name))).toBe(true);
    expect(manifest.contracts.tools).toContain("lonora_headlines");
    expect(manifest.contracts.tools).toContain("lonora_execute_trade");
  });
});

describe("gold clock", () => {
  it("stays closed on Saturday and does not invent candles", () => {
    const saturday = Date.parse("2026-01-03T15:00:00Z");
    expect(isGoldMarketOpenAt(saturday)).toBe(false);
    expect(readMarketClock(saturday).reason).toBe("saturday");
    const visible = candlesVisibleAt(
      [{ time: saturday - 3_600_000 }, { time: saturday + 60_000 }],
      saturday,
      60_000,
    );
    expect(visible.invented).toBe(false);
    expect(visible.candles).toEqual([{ time: saturday - 3_600_000 }]);
  });
});

describe("structure", () => {
  it("reads an uptrend from higher highs and higher lows", () => {
    const closes = [100, 110, 140, 120, 105, 115, 160, 130, 112, 125, 190, 150, 128, 140, 145];
    const candles = closes.map((close, index) => ({
      time: 1_700_000_000_000 + index * 3_600_000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    }));
    const swings = detectSwings(candles);
    expect(detectTrend(swings)).toBe("uptrend");
    const result = runSpecialist("structure-analyst", { candles });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Uptrend.");
    expect(result.summary.toLowerCase()).not.toMatch(/quiet|no pattern/);
    expect(result.data.pattern).toMatchObject({ inventedTarget: false });
    expect(result.summary).not.toBe("reviewed supplied evidence");
    const latest = result.data.latest as { brokenLevel?: number } | null;
    if (latest?.brokenLevel != null) {
      expect(result.summary).toContain(String(latest.brokenLevel));
    } else {
      expect(result.summary).toContain("No fresh close beyond a swing.");
    }
    const arabic = runSpecialist("structure-analyst", { candles, language: "ar" });
    expect(arabic.summary).toContain("اتجاه صاعد");
    expect(arabic.summary).not.toContain("Uptrend");
    expect(arabic.summary).not.toContain("Break of structure");
    const short = runSpecialist("structure-analyst", {
      candles: candles.slice(0, 4),
      language: "ar",
    });
    expect(short.ok).toBe(false);
    expect(short.summary).toBe("الشموع المغلقة لا تكفي لقراءة الهيكل.");
    expect(short.summary).not.toContain("لا إغلاق جديد");
  });

  it("keeps a short higher timeframe unread instead of calling it a disagreement", () => {
    const closes = [100, 110, 140, 120, 105, 115, 160, 130, 112, 125, 190, 150, 128, 140, 145];
    const candles = closes.map((close, index) => ({
      time: 1_700_000_000_000 + index * 3_600_000,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
    }));
    const unread = runSpecialist("multi-timeframe-analyst", { candles });
    expect(unread.ok).toBe(true);
    expect(unread.summary).toBe("The higher timeframe was not read.");
    expect(unread.data.aligned).toBeNull();
    expect(unread.summary).not.toMatch(/agree/i);
    const aligned = runSpecialist("multi-timeframe-analyst", { candles: hourlyZigzag(96) });
    expect(aligned.data.aligned).toBe(true);
    expect(aligned.summary).toContain("Uptrend.");
    expect(aligned.summary).toContain("The four-hour read is up.");
    expect(aligned.summary).toContain("The working timeframe agrees with that read.");
    const conflict = runSpecialist("multi-timeframe-analyst", {
      candles: conflictingHours(),
    });
    expect(conflict.data.aligned).toBe(false);
    expect(conflict.summary).toContain("does not agree");
    expect(conflict.summary).not.toContain("agrees with");
    const arabic = runSpecialist("multi-timeframe-analyst", {
      candles: hourlyZigzag(96),
      language: "ar",
    });
    expect(arabic.summary).toContain("اتجاه صاعد");
    expect(arabic.summary).toContain("قراءة أربع ساعات صاعدة");
    expect(arabic.summary).toContain("الإطار العامل يوافق هذه القراءة");
    expect(arabic.summary).not.toContain("لا يوافق");
    expect(arabic.summary).not.toContain("Uptrend");
  });

  it("grades the stored gold plan and ignores a caller-supplied entry", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const missing = service.delegate({
      agent: "risk-reviewer",
      entry: 100,
      stopLoss: 90,
      targets: [130],
    });
    expect(missing.ok).toBe(false);
    expect(missing.summary).toBe("No open gold plan has a stop and a first target.");
    expect(missing.summary).not.toMatch(/\dR/);
    service.saveRecommendation(plan());
    const graded = service.delegate({
      agent: "risk-reviewer",
      entry: 100,
      stopLoss: 90,
      targets: [130],
    });
    expect(graded.ok).toBe(true);
    expect(graded.summary).toContain("First target is 2.00R.");
    expect(graded.summary).toContain("The spread was not read");
    expect(graded.summary).not.toContain("100");
    expect(graded.data.spreadKnown).toBe(false);
    store.setLanguage("ar");
    const arabic = service.delegate({
      agent: "risk-reviewer",
      entry: 1,
      stopLoss: 2,
      targets: [3],
    });
    expect(arabic.summary).toContain("الهدف الأول 2.00R.");
    expect(arabic.summary).toContain("السبريد لم يُقرأ");
    expect(arabic.summary).not.toContain("First target");
    store.close();
  });

  it("names specialist purposes in the owner language", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    expect(service.agentsView().find((row) => row.agent === "structure-analyst")?.purpose).toBe(
      "Read swings, trend, and structure breaks from closed candles.",
    );
    store.setLanguage("ar");
    const purposes = service.agentsView().map((row) => row.purpose);
    expect(purposes).toContain("يقرأ التأرجح والاتجاه وكسور الهيكل من الشموع المغلقة.");
    expect(purposes.join(" ")).not.toContain("closed candles");
    const structure = service.agentsView().find((row) => row.agent === "structure-analyst");
    expect(structure?.name).toBe("الهيكل");
    expect(structure?.stateLabel).toBe("عند الطلب");
    expect(service.agentsView().find((row) => row.agent === "market-watcher")?.stateLabel).toBe(
      "يعمل",
    );
    store.close();
  });

  it("names a recommendation in the owner language", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    service.saveRecommendation(plan());
    const english = service.listRecommendations()[0];
    expect(english?.direction).toBe("buy");
    expect(english?.status).toBe("pending_entry");
    expect(english?.outcome).toBe("pending");
    expect(english?.directionLabel).toBe("Buy");
    expect(english?.statusLabel).toBe("Waiting for entry");
    expect(english?.outcomeLabel).toBe("Open");
    store.setLanguage("ar");
    const arabic = service.listRecommendations()[0];
    expect(arabic?.directionLabel).toBe("شراء");
    expect(arabic?.statusLabel).toBe("بانتظار الدخول");
    expect(arabic?.outcomeLabel).toBe("مفتوحة");
    expect(`${arabic?.directionLabel} ${arabic?.statusLabel}`).not.toContain("buy");
    service.saveRecommendation(plan({ id: "rec-loss", status: "sl_hit", outcome: "loss" }));
    const loss = service.listRecommendations().find((item) => item.id === "rec-loss");
    expect(loss?.statusLabel).toBe("بلغ الوقف");
    expect(loss?.outcomeLabel).toBe("خسارة");
    expect(loss?.outcome).toBe("loss");
    expect(loss?.outcomeLabel).not.toContain("ربح");
    const open = service.marketSnapshot().recommendations.find((item) => item.id === "rec-1");
    expect(open?.directionLabel).toBe("شراء");
    expect(open?.statusLabel).toBe("بانتظار الدخول");
    expect(
      service.marketSnapshot().recommendations.find((item) => item.id === "rec-loss"),
    ).toBeUndefined();
    store.close();
  });

  it("reports a buy-side sweep from the closed candles", () => {
    const candles = [
      ...Array.from({ length: 8 }, (_, index) => ({
        time: index + 1,
        open: 100,
        high: 100.4,
        low: 99.6,
        close: 100,
      })),
      { time: 9, open: 100, high: 101.5, low: 99.9, close: 100 },
      { time: 10, open: 100, high: 101.5, low: 99.85, close: 100 },
      { time: 11, open: 100, high: 102.2, low: 99.95, close: 100.4 },
    ];
    const result = runSpecialist("liquidity-analyst", { candles });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Buy-side sweep of 101.5");
    expect(result.summary).toContain("The close came back inside.");
    expect(result.summary).toContain("Resting sell-side 99.875");
    expect(result.data.buySide).toBe(101.5);
    expect(result.data.sellSide).toBe(99.875);
    const arabic = runSpecialist("liquidity-analyst", { candles, language: "ar" });
    expect(arabic.summary).toContain("مسح سيولة شرائية عند 101.5");
    expect(arabic.summary).not.toContain("Buy-side sweep");
  });

  it("names the nearest supply and demand zones without a trade", () => {
    const candles = impulseZones(Date.UTC(2026, 0, 14, 15, 0));
    const result = runSpecialist("supply-demand-analyst", { candles });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("Demand 98–100, grade ");
    expect(result.summary).toContain("Supply 102–113, grade ");
    expect(result.summary).not.toMatch(/\b(buy|sell)\b/i);
    expect(result.data.demand).toMatchObject({ low: 98, high: 100, invented: false });
    expect(result.data.supply).toMatchObject({ low: 102, high: 113, invented: false });
    const arabic = runSpecialist("supply-demand-analyst", { candles, language: "ar" });
    expect(arabic.summary).toContain("طلب 98–100");
    expect(arabic.summary).toContain("عرض 102–113");
    expect(arabic.summary).not.toContain("Demand");
  });

  it("fails closed when the sample is too short", () => {
    const result = runSpecialist("liquidity-analyst", { candles: risingCandles(2) });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("insufficient_candles");
  });

  it("reads the market calendar without turning a missing feed into a quiet week", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const now = Date.UTC(2026, 0, 14, 15, 0);
    expect(service.marketSnapshot(now).calendar).toEqual({ known: false, summary: null });
    const read = await service.readCalendar(now);
    expect(read.ok).toBe(false);
    expect(read.invented).toBe(false);
    expect(read.events).toEqual([]);
    expect(read.summary).toBe(copy("en", "calendar.unavailable"));
    expect(read.summary).not.toMatch(/quiet/i);
    expect(service.marketSnapshot(now).calendar).toEqual({
      known: false,
      summary: copy("en", "calendar.unavailable"),
    });
    store.setLanguage("ar");
    const arabic = await service.readCalendar(now);
    expect(arabic.summary).toBe(copy("ar", "calendar.unavailable"));
    expect(arabic.summary).toContain("التقويم الاقتصادي غير متاح");
    expect(arabic.summary).not.toContain("not available");
    store.close();
  });

  it("does not invent a calendar event when the feed is unknown", () => {
    const missing = runSpecialist("macro-news-analyst", { note: "CPI tomorrow" });
    expect(missing.ok).toBe(false);
    expect(missing.failure).toBe("no_macro_context");
    expect(missing.summary).not.toContain("CPI");
    expect(missing.summary).toContain(copy("en", "headlines.unavailable"));
    const known = runSpecialist("macro-news-analyst", {
      calendarKnown: true,
      events: [
        {
          title: "CPI",
          time: "2026-01-05T13:30:00.000Z",
          impact: "high",
          currency: "USD",
        },
      ],
    });
    expect(known.ok).toBe(true);
    expect(known.summary).toContain("CPI");
    expect(known.summary).toContain("USD");
    expect(known.summary).toContain(copy("en", "headlines.unavailable"));
    expect(known.summary).not.toContain(copy("en", "headlines.empty"));
    const tape = runSpecialist("macro-news-analyst", {
      calendarKnown: false,
      headlinesKnown: true,
      headlines: [
        {
          title: "Gold slips before CPI",
          source: "Reuters",
          publishedAt: "2026-01-05T11:00:00.000Z",
        },
      ],
    });
    expect(tape.ok).toBe(true);
    expect(tape.summary).toContain("Gold slips before CPI");
    expect(tape.summary).toContain(copy("en", "calendar.unavailable"));
    expect(tape.summary).not.toContain("CPI tomorrow");
  });
});

describe("recommendations", () => {
  it("ignores the creation candle and fills on a later touch", () => {
    const evaluation = evaluateRecommendation(plan(), [
      candle(1_000, 2298, 2302, 2301),
      candle(2_000, 2299, 2301, 2300),
    ]);
    expect(evaluation.triggered).toBe(true);
    expect(evaluation.status).toBe("triggered");
    expect(evaluation.outcome).toBe("pending");
  });

  it("fills a gold limit inside the 10 point band at the traded price", () => {
    const evaluation = evaluateRecommendation(plan(), [
      { time: 2_000, open: 2288, high: 2292, low: 2284, close: 2288 },
    ]);
    expect(evaluation.triggered).toBe(true);
    expect(evaluation.effectiveEntry).toBe(2292);
  });

  it("does not fill a gold limit that stays outside the band", () => {
    const evaluation = evaluateRecommendation(plan(), [
      { time: 2_000, open: 2270, high: 2280, low: 2260, close: 2275 },
    ]);
    expect(evaluation.triggered).toBe(false);
  });

  it("counts a near target and does not widen the stop", () => {
    const evaluation = evaluateRecommendation(
      plan({ entryType: "market", status: "triggered", triggeredAt: 1_000, effectiveEntry: 2300 }),
      [{ time: 2_000, open: 2302, high: 2312, low: 2298, close: 2310 }],
    );
    expect(evaluation.status).toBe("tp1_hit");
    expect(evaluation.outcome).toBe("pending");
  });

  it("resolves a same-candle stop and target as a loss", () => {
    const evaluation = evaluateRecommendation(
      plan({ entryType: "market", status: "triggered", triggeredAt: 1_000, effectiveEntry: 2300 }),
      [candle(2_000, 2288, 2322, 2295)],
    );
    expect(evaluation.ambiguous).toBe(true);
    expect(evaluation.outcome).toBe("loss");
  });

  it("banks a target hit before a later stop", () => {
    const evaluation = evaluateRecommendation(
      plan({ entryType: "market", status: "triggered", triggeredAt: 1_000 }),
      [candle(2_000, 2305, 2315, 2312), candle(3_000, 2280, 2310, 2285)],
    );
    expect(evaluation.outcome).toBe("win_tp1");
  });

  it("does not fill a close rule on a wick through the level", () => {
    const evaluation = evaluateRecommendation(
      plan({
        activationRule: { kind: "candle_close_above", level: 2300, timeframe: "1h" },
      }),
      [{ time: 2_000, open: 2296, high: 2305, low: 2288, close: 2298 }],
    );
    expect(evaluation.triggered).toBe(false);
    expect(evaluation.outcome).toBe("pending");
  });

  it("fills a close rule at the confirming close and grades the stop later", () => {
    const confirming = { time: 2_000, open: 2298, high: 2312, low: 2288, close: 2304 };
    const held = evaluateRecommendation(
      plan({
        activationRule: { kind: "candle_close_above", level: 2300, timeframe: "1h" },
      }),
      [confirming],
    );
    expect(held.triggered).toBe(true);
    expect(held.effectiveEntry).toBe(2304);
    expect(held.outcome).toBe("pending");
    const stopped = evaluateRecommendation(
      {
        ...plan({
          activationRule: { kind: "candle_close_above", level: 2300, timeframe: "1h" },
        }),
        status: held.status,
        triggeredAt: held.triggeredAt,
        effectiveEntry: held.effectiveEntry,
      },
      [confirming, { time: 3_000, open: 2304, high: 2306, low: 2280, close: 2284 }],
    );
    expect(stopped.outcome).toBe("loss");
  });

  it("waits for a return into the retest band after the confirming close", () => {
    const waiting = evaluateRecommendation(
      plan({
        direction: "sell",
        entryType: "retest_zone",
        entry: 4348,
        stopLoss: 4360,
        targets: [4200],
        retestZone: { from: 4344, to: 4349 },
        activationRule: { kind: "candle_close_below", level: 4348, timeframe: "15m" },
      }),
      [{ time: 2_000, open: 4340, high: 4342, low: 4332, close: 4335 }],
    );
    expect(waiting.triggered).toBe(false);
    expect(waiting.status).toBe("pending_entry");
    const filled = evaluateRecommendation(
      plan({
        direction: "sell",
        entryType: "retest_zone",
        entry: 4348,
        stopLoss: 4360,
        targets: [4200],
        retestZone: { from: 4344, to: 4349 },
        activationRule: { kind: "candle_close_below", level: 4348, timeframe: "15m" },
      }),
      [
        { time: 2_000, open: 4340, high: 4342, low: 4332, close: 4335 },
        { time: 3_000, open: 4338, high: 4346, low: 4336, close: 4341 },
      ],
    );
    expect(filled.triggered).toBe(true);
    expect(filled.triggeredAt).toBe(3_000);
    expect(filled.effectiveEntry).toBe(4344);
    expect(filled.outcome).toBe("pending");
  });

  it("does not touch-fill a plan whose activation rule cannot be read", () => {
    const evaluation = evaluateRecommendation(plan({ activationUnreadable: true }), [
      candle(2_000, 2290, 2310, 2305),
    ]);
    expect(evaluation.triggered).toBe(false);
  });

  it("does not reopen a terminal plan", () => {
    const evaluation = evaluateRecommendation(plan({ outcome: "loss", status: "sl_hit" }), [
      candle(4_000, 2400, 2410, 2405),
    ]);
    expect(evaluation.changed).toBe(false);
    expect(evaluation.outcome).toBe("loss");
  });
});

describe("monitor", () => {
  const base = {
    candleTime: 10,
    price: 2300,
    session: "london",
    marketOpen: true,
    atr: 2,
    structureEventKey: null,
    recommendationFingerprint: "rec-1:pending_entry",
  };

  it("does not request analysis when the market is unchanged", () => {
    const decision = decideMonitorAction(base, { ...base, candleTime: 11 });
    expect(decision.deepAnalysis).toBe(false);
    expect(decision.material).toBe(false);
  });

  it("requests specialist work on a structure change", () => {
    const decision = decideMonitorAction(base, { ...base, structureEventKey: "BOS:2304" });
    expect(decision.deepAnalysis).toBe(true);
    expect(decision.reasons).toContain("structure_change");
  });

  it("treats a new sweep as material specialist work", () => {
    const decision = decideMonitorAction(base, { ...base, sweepKey: "buy_side:11:101.5" });
    expect(decision.material).toBe(true);
    expect(decision.deepAnalysis).toBe(true);
    expect(decision.reasons).toContain("liquidity_sweep");
  });

  it("does not invent movement while closed", () => {
    const decision = decideMonitorAction(base, {
      ...base,
      marketOpen: false,
      price: 9999,
      session: "asia",
    });
    expect(decision.deepAnalysis).toBe(false);
    expect(decision.reasons).not.toContain("price_move");
    expect(decision.reasons).not.toContain("liquidity_sweep");
  });

  it("treats a real high-impact event as material without a price move", () => {
    const decision = decideMonitorAction(
      { ...base, marketOpen: false, macroEventKey: "none" },
      {
        ...base,
        marketOpen: false,
        price: 9999,
        macroEventKey: "USD:1:cpi",
      },
    );
    expect(decision.reasons).toContain("macro_event");
    expect(decision.reasons).not.toContain("price_move");
    expect(decision.deepAnalysis).toBe(true);
    expect(decision.notificationKeys).toEqual(["macro_event:USD:1:cpi"]);
  });

  it("suppresses a delivered notice until cooldown ends", () => {
    expect(
      shouldNotify(
        { key: "a", status: "delivered", attempts: 1, lastAttemptAt: 0, cooldownUntil: 100 },
        50,
      ),
    ).toBe(false);
    expect(
      shouldNotify(
        { key: "a", status: "failed", attempts: 1, lastAttemptAt: 0, cooldownUntil: 0 },
        120_000,
      ),
    ).toBe(true);
  });

  it("backs off a failed notice instead of retrying on the next tick", () => {
    const failed = nextNotice(null, "structure", 1_000, false);
    expect(failed.status).toBe("failed");
    expect(failed.cooldownUntil).toBeGreaterThan(1_000);
    expect(shouldNotify(failed, 1_000)).toBe(false);
    expect(shouldNotify(failed, failed.cooldownUntil)).toBe(true);
  });
});

describe("trade boundary", () => {
  it.each(["monitor", "schedule", "subagent"] as const)(
    "refuses %s even with a confirmation flag",
    (caller) => {
      expect(authorizeTrade({ caller, ownerConfirmed: true }).ok).toBe(false);
    },
  );

  it("refuses the model tool and an unconfirmed owner", () => {
    expect(authorizeTrade({ caller: "model", ownerConfirmed: true }).code).toBe(
      "autonomous_trade_blocked",
    );
    expect(authorizeTrade({ caller: "owner" }).code).toBe("owner_confirmation_required");
    expect(authorizeTrade({ caller: "owner", ownerConfirmed: true }).ok).toBe(true);
  });

  it("blocks coding tools and ignores a model confirmation flag", () => {
    expect(blockReasonForTool({ toolName: "exec" })).toMatch(/shell/);
    expect(
      blockReasonForTool({
        toolName: "lonora_execute_trade",
        sessionKey: "agent:main:cron:gold",
        ownerConfirmed: true,
      }),
    ).toMatch(/cannot place trades/);
    expect(blockReasonForTool({ toolName: "lonora_execute_trade", ownerConfirmed: true })).toMatch(
      /cannot place trades/,
    );
    expect(blockReasonForTool({ toolName: "lonora_notify", ownerConfirmed: true })).toMatch(
      /market monitor/,
    );
    expect(blockReasonForTool({ toolName: "sessions_spawn" })).toMatch(/shell/);
    expect(
      usageIdentity({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        modelProviderId: "openai",
        modelId: "gpt-5",
      }),
    ).toEqual({ provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(usageIdentity({ modelProviderId: "openai", modelId: "gpt-5" })).toEqual({
      provider: "openai",
      model: "gpt-5",
    });
    expect(() =>
      assertPermission({ permission: "NOTIFY", caller: "model", ownerConfirmed: false }),
    ).toThrow(/owner confirmation/);
  });
});

describe("owner and providers", () => {
  it("requires an explicit id when several candidates exist", () => {
    expect(() => resolveOwnerCandidate([{ id: "1" }, { id: "2" }])).toThrow(OwnerSelectionRequired);
    expect(resolveOwnerCandidate([{ id: "1" }, { id: "2" }], "2").id).toBe("2");
  });

  it("never returns a stored API key", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const secret = "sk-test-secret-value";
    const fetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ id: "claude-test" }] }), { status: 200 });
    const connected = await service.connectProvider({
      provider: "anthropic",
      apiKey: secret,
      fetchImpl: fetchImpl as typeof fetch,
    });
    expect(JSON.stringify(connected)).not.toContain(secret);
    const view = service.providerSettings();
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(view.find((row) => row.provider === "anthropic")?.defaultModel).toBe("claude-test");
    const rejected = await probeProvider({
      provider: "openai",
      apiKey: secret,
      fetchImpl: (async () => new Response(`bad key ${secret}`, { status: 401 })) as typeof fetch,
    });
    expect(rejected.connected).toBe(false);
    expect(rejected.error).toBe("The API key was rejected.");
    expect(rejected.error).not.toContain(secret);
    store.close();
  });

  it("rejects a second owner and a second telegram chat", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    service.store.insertOwner({
      id: "owner",
      label: "Owner",
      language: "ar",
      telegramChatId: null,
      source: "explicit",
    });
    expect(() =>
      service.store.insertOwner({
        id: "other",
        label: "Other",
        language: "en",
        telegramChatId: null,
        source: "explicit",
      }),
    ).toThrow(/second account/);
    expect(service.bindTelegram("100").ok).toBe(true);
    expect(service.bindTelegram("200")).toEqual({ ok: false, code: "telegram_already_bound" });
    expect(copy("ar", "trade.blocked")).toContain("لونورا");
    store.close();
  });
});

describe("responsibilities, memory, usage", () => {
  it("persists a responsibility across a reopened store", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lonora-"));
    const file = path.join(directory, "lonora.sqlite");
    const first = LonoraStore.open(file);
    const service = new LonoraService(first);
    const created = service.upsertResponsibility({
      title: "Watch XAUUSD until New York",
      instruction: "Tell me if structure changes.",
    });
    service.remember("lesson", "New York continuation worked this month", "XAUUSD");
    first.close();
    const second = new LonoraService(LonoraStore.open(file));
    expect(second.store.listResponsibilities().map((row) => row.id)).toContain(created.id);
    expect(second.setResponsibilityStatus(created.id, "paused").status).toBe("paused");
    expect(second.recall("New York")[0]?.kind).toBe("lesson");
    const brief = second.ownerBrief();
    expect(brief).toContain("New York continuation worked this month");
    expect(brief).not.toContain("Watch XAUUSD until New York");
    expect(brief).not.toMatch(/%/);
    expect(second.ownerBrief()).toBe(brief);
    second.store.setLanguage("ar");
    expect(second.ownerBrief()).toContain("ذاكرة الذهب");
    const empty = new LonoraService(LonoraStore.open(":memory:"));
    const emptyAt = Date.UTC(2026, 0, 14, 15, 0);
    expect(empty.ownerBrief(emptyAt)).toBe(
      `${empty.sessionSentence(emptyAt)} ${copy("en", "memory.empty")}`,
    );
    expect(empty.ownerBrief(emptyAt)).toContain("London and New York are open");
    expect(empty.ownerBrief(emptyAt)).not.toMatch(/%/);
    const blank = empty.delegate({ agent: "memory-curator", note: "   \n  " });
    expect(blank.ok).toBe(true);
    expect(blank.summary).toBe(copy("en", "memory.none"));
    expect(empty.recall("lesson", "lesson")).toEqual([]);
    expect(empty.ownerBrief(emptyAt)).toBe(
      `${empty.sessionSentence(emptyAt)} ${copy("en", "memory.empty")}`,
    );
    empty.saveRecommendation(plan({ id: "closed-plan", outcome: "loss", status: "sl_hit" }));
    expect(empty.ownerBrief(emptyAt)).toBe(
      `${empty.sessionSentence(emptyAt)} ${copy("en", "memory.empty")}`,
    );
    empty.saveRecommendation(
      plan({ id: "open-plan", entry: 2311, stopLoss: 2291, targets: [2400] }),
    );
    expect(empty.noteConversation([])).toBeNull();
    expect(
      empty.noteConversation([
        { role: "assistant", content: "The model thought about a secret stop." },
        { role: "user", content: [{ type: "text", text: "  What changed\nin gold?  " }] },
      ]),
    ).toBe("What changed in gold?");
    expect(empty.ownerBrief()).toContain("Last request: What changed in gold?");
    expect(empty.ownerBrief()).not.toContain("secret stop");
    expect(
      empty.noteConversation([{ role: "user", content: `Next ${"y".repeat(300)}` }])?.length,
    ).toBe(240);
    expect(empty.recall("What changed", "conversation")).toEqual([]);
    expect(empty.ownerBrief()).toContain("Open plans: buy 2311, stop 2291, target 2400");
    expect(empty.ownerBrief()).toContain("Plan grade: First target is 4.45R.");
    expect(empty.ownerBrief()).toContain("The spread was not read");
    expect(empty.ownerBrief()).not.toMatch(/%/);
    expect(empty.ownerBrief()).not.toContain("closed-plan");
    const note = `New York continuation   ${"x".repeat(400)}`;
    const stored = empty.delegate({ agent: "memory-curator", note });
    expect(stored.summary).toBe(copy("en", "memory.stored"));
    expect(stored.summary).not.toMatch(/candidate/i);
    const lessons = empty.recall("New York", "lesson");
    expect(lessons).toHaveLength(1);
    expect(lessons[0]?.content.length).toBeLessThanOrEqual(240);
    expect(lessons[0]?.content.startsWith("New York continuation x")).toBe(true);
    expect(empty.ownerBrief()).toContain(lessons[0]?.content ?? "missing");
    expect(empty.agentsView().find((agent) => agent.agent === "memory-curator")?.lastResult).toBe(
      copy("en", "memory.stored"),
    );
    empty.store.setLanguage("ar");
    expect(empty.delegate({ agent: "memory-curator", note: "الدرس العربي" }).summary).toBe(
      copy("ar", "memory.stored"),
    );
    expect(empty.ownerBrief()).toContain("الدرس العربي");
    expect(empty.ownerBrief()).toContain("خطط مفتوحة: شراء 2311, وقف 2291, هدف 2400");
    expect(empty.ownerBrief()).toContain("درجة الخطة: الهدف الأول 4.45R.");
    expect(empty.ownerBrief()).toContain("السبريد لم يُقرأ");
    expect(empty.ownerBrief()).toContain("آخر طلب: Next");
    empty.store.close();
    second.store.close();
  });

  it("maps a morning briefing onto a weekday New York cron", () => {
    expect(cronForResponsibility("Every morning prepare a gold briefing")).toEqual({
      expr: "0 8 * * 1-5",
      tz: "America/New_York",
    });
    expect(cronForResponsibility("كل صباح حضّر إحاطة")).toEqual({
      expr: "0 8 * * 1-5",
      tz: "America/New_York",
    });
    expect(cronForResponsibility("Watch structure")).toBeNull();
  });

  it("matches a calendar instruction when a high-impact event is near", () => {
    expect(
      checkResponsibility("Watch the economic calendar.", { reasons: ["macro_event"] }, false),
    ).toEqual({ matched: ["macro_event"], waiting: false, closed: false });
    expect(
      checkResponsibility("Watch gold news.", { reasons: ["headline_change"] }, false).matched,
    ).toEqual(["headline_change"]);
  });

  it("matches a structure instruction only when structure changes", () => {
    expect(
      checkResponsibility(
        "Tell me if structure changes.",
        { reasons: ["structure_change", "new_candle"] },
        true,
      ),
    ).toEqual({ matched: ["structure_change"], waiting: false, closed: false });
    expect(
      checkResponsibility("Tell me if structure changes.", { reasons: ["new_candle"] }, false),
    ).toEqual({ matched: [], waiting: true, closed: true });
    expect(
      checkResponsibility("Watch this liquidity zone.", { reasons: ["liquidity_sweep"] }, true)
        .matched,
    ).toEqual(["liquidity_sweep"]);
    expect(
      checkResponsibility("Watch this liquidity zone.", { reasons: ["volatility_change"] }, true)
        .waiting,
    ).toBe(true);
    const matched = responsibilityEventText("en", {
      matched: ["structure_change", "macro_event"],
      closed: false,
    });
    expect(matched).toBe(`${copy("en", "notify.structure")} ${copy("en", "notify.macro")}`);
    expect(matched).not.toMatch(/structure_change|macro_event/);
    expect(responsibilityEventText("ar", { matched: ["headline_change"], closed: false })).toBe(
      copy("ar", "notify.headline"),
    );
  });

  it("replaces one gold scenario and withholds a rate below five outcomes", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const outcomes = ["win_tp1", "win_tp1", "win_tp1", "loss"] as const;
    for (const [index, outcome] of outcomes.entries()) {
      service.saveRecommendation(
        plan({
          id: `rec-${index}`,
          outcome,
          status: outcome === "loss" ? "sl_hit" : "tp1_hit",
          effectiveEntry: 2300,
        }),
      );
    }
    expect(service.refreshScenarioMemory().winRate).toBeNull();
    expect(service.recommendationRecord()).toMatchObject({
      sample: 4,
      winRate: null,
      invented: false,
    });
    expect(service.recommendationRecord().text).toMatch(/too small/);
    expect(store.searchMemory("realized", "scenario")).toEqual([]);
    service.saveRecommendation(
      plan({ id: "rec-4", outcome: "loss", status: "sl_hit", effectiveEntry: 2300 }),
    );
    const ready = service.refreshScenarioMemory();
    expect(ready.winRate).toBe(60);
    expect(store.searchMemory("Win rate", "scenario")).toHaveLength(1);
    service.refreshScenarioMemory();
    expect(store.searchMemory("Win rate", "scenario")).toHaveLength(1);
    const research = service.delegate({ agent: "research-agent" });
    expect(research.ok).toBe(true);
    expect(research.summary).toMatch(/Win rate 60%/);
    const fromModelCandles = service.delegate({
      agent: "research-agent",
      candles: risingCandles(40),
    });
    expect(fromModelCandles.summary).toBe(research.summary);
    expect(fromModelCandles.summary).not.toMatch(/bias/i);
    store.close();
  });

  it("compares closed candles and withholds a rate from a short sample", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new (class extends LonoraService {
      override readCandles() {
        return Promise.resolve({
          ok: true,
          candles: risingCandles(40),
          price: 2339,
          stale: false,
          invented: false as const,
        });
      }
    })(store);
    const report = await service.compareSimilarHistory();
    expect(report.invented).toBe(false);
    expect(report.brokerCalled).toBe(false);
    expect(report.winRate).toBeNull();
    expect(report.text).not.toMatch(/%/);
    expect(service.agentsView().find((agent) => agent.agent === "research-agent")?.lastResult).toBe(
      report.text,
    );
    store.close();
  });

  it("attributes estimated cost by provider and feature", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    service.recordModelUsage({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      inputTokens: 1_000_000,
      outputTokens: 0,
      sessionKey: "agent:main:main",
    });
    service.recordModelUsage({
      provider: "openai",
      model: "gpt-5",
      inputTokens: 0,
      outputTokens: 1_000,
      jobId: "briefing",
      agent: "market-watcher",
    });
    const summary = service.usageSummary(Date.now());
    expect(summary.estimated).toBe(true);
    expect(summary.byFeature.conversation).toBeGreaterThan(0);
    expect(summary.byFeature.market_monitoring).toBeGreaterThan(0);
    expect(summary.byAgent["market-watcher"]).toBeGreaterThan(0);
    expect(
      estimateCostUsd({
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        inputTokens: 1_000_000,
        outputTokens: 0,
      }).usd,
    ).toBe(3);
    expect(rollupUsage([], Date.now()).tokensToday).toBe(0);
    store.close();
  });
});

describe("delegation and migration", () => {
  it("stops recursive specialist spawning", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const result = service.delegate({
      agent: "structure-analyst",
      candles: risingCandles(30),
      depth: 2,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("delegation_limit");
    const burst = new LonoraService(LonoraStore.open(":memory:"));
    for (let index = 0; index < 4; index += 1) {
      expect(burst.delegate({ agent: "memory-curator", note: `lesson ${index}` }).ok).toBe(true);
    }
    expect(burst.delegate({ agent: "memory-curator", note: "one more" }).failure).toBe(
      "delegation_limit",
    );
    expect(burst.recall("one more", "lesson")).toEqual([]);
    expect(burst.recall("lesson 0", "lesson")).toHaveLength(1);
    burst.store.close();
    const guardian = new LonoraService(LonoraStore.open(":memory:"));
    const checked = guardian.delegate({ agent: "system-guardian" });
    expect(checked.ok).toBe(true);
    expect(checked.summary).toContain("Specialist runs in the last minute: 0.");
    expect(checked.summary).toContain("The cap is 4.");
    expect(checked.summary).toContain("Model trade is blocked.");
    expect(checked.summary).toContain("not linked to a broker.");
    expect(checked.summary).toContain("Coding tools stay blocked.");
    expect(checked.summary).not.toMatch(/Checked delegation/);
    expect(runSpecialist("system-guardian", {}).failure).toBe("unchecked");
    const broken = runSpecialist("system-guardian", {
      guardian: {
        childCount: 0,
        maxChildren: 4,
        modelTradeBlocked: false,
        ownerBrokerCalled: false,
        codingBlocked: true,
      },
    });
    expect(broken.ok).toBe(false);
    expect(broken.failure).toBe("boundary");
    expect(broken.summary).toBe(copy("en", "guardian.failed"));
    guardian.store.setLanguage("ar");
    const second = guardian.delegate({ agent: "system-guardian" });
    expect(second.summary).toContain("1");
    expect(second.summary).toContain("تنفيذ النموذج محظور");
    expect(second.summary).not.toContain("Model trade is blocked.");
    guardian.store.close();
    store.close();
  });

  it("dry-runs a Boty database and refuses multiple users", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "boty-")), "boty.sqlite");
    const source = new DatabaseSync(file);
    source.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE TABLE trading_settings (user_id INTEGER, language TEXT, telegram_chat_id TEXT);
      CREATE TABLE recommendations (
        id INTEGER, user_id INTEGER, symbol TEXT, direction TEXT, entry REAL,
        stop_loss REAL, targets_json TEXT, rationale TEXT, confidence INTEGER, status TEXT
      );
      CREATE TABLE semantic_memories (
        id INTEGER, user_id INTEGER, content TEXT, memory_type TEXT, symbol TEXT, archived INTEGER
      );
    `);
    source.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(1, "a@example.com");
    source.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(2, "b@example.com");
    source
      .prepare(
        "INSERT INTO trading_settings (user_id, language, telegram_chat_id) VALUES (?, ?, ?)",
      )
      .run(1, "ar", "555");
    source
      .prepare(
        "INSERT INTO recommendations (id, user_id, symbol, direction, entry, stop_loss, targets_json, rationale, confidence, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(9, 1, "XAUUSD", "buy", 2300, 2290, "[2310]", "trend", 60, "active");
    source
      .prepare(
        "INSERT INTO recommendations (id, user_id, symbol, direction, entry, stop_loss, targets_json, rationale, confidence, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(10, 1, "EURUSD", "buy", 1.1, 1.0, "[1.2]", "fx", 40, "active");
    source
      .prepare(
        "INSERT INTO recommendations (id, user_id, symbol, direction, entry, stop_loss, targets_json, rationale, confidence, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(11, 1, "XAUUSD", "buy", 2300, 2290, "[2310]", "closed", 60, "sl_hit");
    source
      .prepare(
        "INSERT INTO semantic_memories (id, user_id, content, memory_type, symbol, archived) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(3, 1, "London open fade", "lesson", "XAUUSD", 0);
    source.close();
    const target = LonoraStore.open(":memory:");
    expect(() => planBotyMigration({ sourcePath: file, target })).toThrow(OwnerSelectionRequired);
    const report = planBotyMigration({ sourcePath: file, target, ownerId: "1" });
    expect(report.dryRun).toBe(true);
    expect(target.getOwner()).toBeNull();
    const applied = planBotyMigration({ sourcePath: file, target, ownerId: "1", apply: true });
    expect(applied.dryRun).toBe(false);
    expect(applied.language).toBe("ar");
    expect(target.getOwner()?.telegramChatId).toBe("555");
    expect(report.warnings.join(" ")).toMatch(/not XAUUSD/);
    expect(target.listRecommendations()).toHaveLength(2);
    expect(target.listRecommendations().every((plan) => plan.symbol === "XAUUSD")).toBe(true);
    expect(target.listRecommendations().find((plan) => plan.id === "boty-11")?.outcome).toBe(
      "loss",
    );
    new LonoraService(target).gradeRecommendations([
      { time: Date.now() + 60_000, open: 2300, high: 2400, low: 2295, close: 2350 },
    ]);
    expect(target.listRecommendations().find((plan) => plan.id === "boty-11")?.outcome).toBe(
      "loss",
    );
    expect(target.listRecommendations()[0]?.createdCandleTime).toBeGreaterThan(0);
    expect(target.searchMemory("London")[0]?.kind).toBe("lesson");
    target.close();

    const placeholder = LonoraStore.open(":memory:");
    placeholder.ensureLocalOwner();
    const replaced = planBotyMigration({
      sourcePath: file,
      target: placeholder,
      ownerId: "1",
      apply: true,
    });
    expect(replaced.ownerId).toBe("1");
    expect(placeholder.getOwner()).toMatchObject({ id: "1", source: "migration", language: "ar" });
    placeholder.close();

    const occupied = LonoraStore.open(":memory:");
    occupied.insertOwner({
      id: "keep",
      label: "Keep",
      language: "en",
      telegramChatId: null,
      source: "explicit",
    });
    expect(() =>
      planBotyMigration({ sourcePath: file, target: occupied, ownerId: "1", apply: true }),
    ).toThrow(/second account/);
    expect(occupied.getOwner()?.id).toBe("keep");
    expect(occupied.listRecommendations()).toHaveLength(0);
    occupied.close();
  });

  it("keeps a readable Boty activation rule and blocks an unreadable one", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "boty-rule-")), "boty.sqlite");
    const source = new DatabaseSync(file);
    source.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE TABLE trading_settings (user_id INTEGER, language TEXT, telegram_chat_id TEXT);
      CREATE TABLE recommendations (
        id INTEGER, user_id INTEGER, symbol TEXT, direction TEXT, entry REAL,
        stop_loss REAL, targets_json TEXT, rationale TEXT, confidence INTEGER, status TEXT,
        activation_rule_json TEXT
      );
      CREATE TABLE semantic_memories (
        id INTEGER, user_id INTEGER, content TEXT, memory_type TEXT, symbol TEXT, archived INTEGER
      );
    `);
    source.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(7, "owner@example.com");
    source
      .prepare(
        "INSERT INTO trading_settings (user_id, language, telegram_chat_id) VALUES (?, ?, ?)",
      )
      .run(7, "en", null);
    const rule = JSON.stringify({ kind: "candle_close_above", level: 2300, timeframe: "1h" });
    source
      .prepare(
        "INSERT INTO recommendations (id, user_id, symbol, direction, entry, stop_loss, targets_json, rationale, confidence, status, activation_rule_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(1, 7, "XAUUSD", "buy", 2300, 2290, "[2320]", "close", 70, "pending_entry", rule);
    source
      .prepare(
        "INSERT INTO recommendations (id, user_id, symbol, direction, entry, stop_loss, targets_json, rationale, confidence, status, activation_rule_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(2, 7, "XAUUSD", "buy", 2300, 2290, "[2320]", "bad", 70, "pending_entry", "{");
    source.close();
    const target = LonoraStore.open(":memory:");
    const applied = planBotyMigration({ sourcePath: file, target, apply: true });
    expect(applied.warnings.join(" ")).toMatch(/could not be read/);
    const plans = target.listRecommendations();
    expect(plans.find((item) => item.id === "boty-1")?.activationRule).toMatchObject({
      kind: "candle_close_above",
      level: 2300,
    });
    expect(plans.find((item) => item.id === "boty-1")?.entryType).toBe("confirmation_close");
    expect(plans.find((item) => item.id === "boty-2")?.activationUnreadable).toBe(true);
    const service = new LonoraService(target);
    service.gradeRecommendations([
      { time: Date.now() + 60_000, open: 2290, high: 2304, low: 2288, close: 2295 },
    ]);
    expect(target.listRecommendations().every((item) => item.outcome === "pending")).toBe(true);
    expect(
      service.listRecommendations().find((item) => item.id === "boty-1")?.activationSummary,
    ).toMatch(/2300/);
    target.close();
  });

  it("imports a Boty retest band and leaves a bandless retest unfilled", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "boty-retest-")), "boty.sqlite");
    const source = new DatabaseSync(file);
    source.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT);
      CREATE TABLE trading_settings (user_id INTEGER, language TEXT, telegram_chat_id TEXT);
      CREATE TABLE recommendations (
        id INTEGER, user_id INTEGER, symbol TEXT, direction TEXT, entry REAL,
        stop_loss REAL, targets_json TEXT, rationale TEXT, confidence INTEGER, status TEXT,
        activation_rule_json TEXT, entry_type TEXT, risk_json TEXT
      );
      CREATE TABLE semantic_memories (
        id INTEGER, user_id INTEGER, content TEXT, memory_type TEXT, symbol TEXT, archived INTEGER
      );
    `);
    source.prepare("INSERT INTO users (id, email) VALUES (?, ?)").run(7, "owner@example.com");
    source
      .prepare(
        "INSERT INTO trading_settings (user_id, language, telegram_chat_id) VALUES (?, ?, ?)",
      )
      .run(7, "en", null);
    const rule = JSON.stringify({ kind: "candle_close_below", level: 4348, timeframe: "15m" });
    const insert = source.prepare(
      "INSERT INTO recommendations (id, user_id, symbol, direction, entry, stop_loss, targets_json, rationale, confidence, status, activation_rule_json, entry_type, risk_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    insert.run(
      1,
      7,
      "XAUUSD",
      "sell",
      4348,
      4360,
      "[4320]",
      "retest",
      70,
      "pending_entry",
      rule,
      "retest_zone",
      JSON.stringify({ retestZone: { from: 4344, to: 4349 } }),
    );
    insert.run(
      2,
      7,
      "XAUUSD",
      "sell",
      4348,
      4360,
      "[4320]",
      "missing",
      70,
      "pending_entry",
      rule,
      "retest_zone",
      "{}",
    );
    source.close();
    const target = LonoraStore.open(":memory:");
    const applied = planBotyMigration({ sourcePath: file, target, apply: true });
    expect(applied.warnings.join(" ")).toMatch(/no band/);
    const plans = target.listRecommendations();
    expect(plans.find((item) => item.id === "boty-1")).toMatchObject({
      entryType: "retest_zone",
      retestZone: { from: 4344, to: 4349 },
    });
    expect(plans.find((item) => item.id === "boty-2")?.entryType).toBe("retest_zone");
    expect(plans.find((item) => item.id === "boty-2")?.retestZone).toBeUndefined();
    const service = new LonoraService(target);
    service.gradeRecommendations([
      { time: Date.now() + 60_000, open: 4346, high: 4347, low: 4344, close: 4345 },
    ]);
    const graded = target.listRecommendations();
    expect(graded.find((item) => item.id === "boty-2")?.status).toBe("pending_entry");
    expect(
      service.listRecommendations().find((item) => item.id === "boty-1")?.activationSummary,
    ).toMatch(/4344/);
    target.close();
  });
});

describe("market data", () => {
  it("reads the higher timeframe from the candle feed", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const openAt = Date.UTC(2026, 0, 14, 15, 0);
    service.readCandles = async () => ({
      ok: false,
      candles: [],
      price: null,
      stale: true,
      invented: false,
      error: "down",
    });
    const failed = await service.compareTimeframes(openAt);
    expect(failed.ok).toBe(false);
    expect(failed.summary).toBe("The higher timeframe was not read.");
    expect(failed.summary).not.toMatch(/agree/i);
    store.setLanguage("ar");
    const arabic = await service.compareTimeframes(openAt);
    expect(arabic.summary).toBe("الإطار الزمني الأعلى لم يُقرأ.");
    expect(arabic.summary).not.toContain("was not read");
    const briefAt = Date.UTC(2026, 0, 17, 12, 0);
    expect(service.ownerBrief(briefAt)).toBe(
      `${service.sessionSentence(briefAt)} ${copy("ar", "memory.empty")}`,
    );
    expect(service.ownerBrief(briefAt)).toContain("سيدني");
    expect(service.ownerBrief(briefAt)).not.toContain("Gold is open");
    store.close();
  });

  it("stores the four-hour read from the closed feed in the gold brief", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const openAt = Date.UTC(2026, 0, 14, 15, 0);
    const closedAt = Date.parse("2026-01-03T15:00:00Z");
    const short = hourlyCloses(
      openAt,
      Array.from({ length: 15 }, () => 120),
    );
    service.readCandles = async () => ({
      ok: true,
      candles: short,
      price: 120,
      stale: false,
      invented: false,
    });
    const closed = await service.monitorOnce(closedAt);
    expect(closed.dataStatus).toBe("closed");
    expect(service.ownerBrief(closedAt)).toBe(
      `${service.sessionSentence(closedAt)} ${copy("en", "memory.empty")}`,
    );
    expect(service.ownerBrief(closedAt)).not.toContain("120");

    await service.monitorOnce(openAt);
    expect(service.ownerBrief(openAt)).toContain(
      "Higher timeframe: The higher timeframe was not read.",
    );
    expect(service.ownerBrief(openAt)).toContain(service.sessionSentence(openAt));
    expect(service.ownerBrief()).not.toMatch(/agree/i);
    expect(service.recall("not read", "timeframe_read")).toHaveLength(1);

    service.readCandles = async () => ({
      ok: true,
      candles: hourlyZigzag(96),
      price: 160,
      stale: false,
      invented: false,
    });
    const read = await service.readVisibleCandles(openAt);
    expect(read.invented).toBe(false);
    expect(service.ownerBrief()).toContain("Higher timeframe: Uptrend. The four-hour read is up.");
    expect(service.ownerBrief()).toContain("The working timeframe agrees with that read.");
    expect(service.ownerBrief()).not.toContain("was not read");
    expect(service.remember("timeframe_read", "aligned by a supplied series", "XAUUSD")).toBeNull();
    expect(service.ownerBrief()).not.toContain("supplied series");

    service.readCandles = async () => ({
      ok: false,
      candles: [],
      price: null,
      stale: true,
      invented: false,
      error: "down",
    });
    const failed = await service.readVisibleCandles(openAt);
    expect(failed.ok).toBe(false);
    expect(service.ownerBrief()).toContain("The four-hour read is up.");

    store.setLanguage("ar");
    service.readCandles = async () => ({
      ok: true,
      candles: hourlyZigzag(96),
      price: 160,
      stale: false,
      invented: false,
    });
    await service.readVisibleCandles(openAt);
    expect(service.ownerBrief()).toContain("الإطار الأعلى: اتجاه صاعد. قراءة أربع ساعات صاعدة.");
    expect(service.ownerBrief()).not.toContain("Higher timeframe:");
    store.close();
  });

  it("names a close-confirmed break and leaves a wick or a short sample unread", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const now = Date.UTC(2026, 0, 14, 15, 0);
    service.readCandles = async () => ({
      ok: true,
      candles: breakCandles("short"),
      price: 100,
      stale: false,
      invented: false,
    });
    const short = await service.readVisibleCandles(now);
    expect(short.structureBreak).toBeNull();
    expect(short.breakSummary).toBe("The structure break was not read.");
    expect(short.breakSummary).not.toContain("No fresh close");
    expect(short.timeframeSummary).toBe("The higher timeframe was not read.");
    expect(short.timeframeSummary).not.toMatch(/agree/i);

    service.readCandles = async () => ({
      ok: true,
      candles: breakCandles("wick"),
      price: 100,
      stale: false,
      invented: false,
    });
    const wick = await service.readVisibleCandles(now);
    expect(wick.structureBreak).toBeNull();
    expect(wick.breakSummary).toBe("No fresh close beyond a swing.");
    expect(wick.breakSummary).not.toContain("113");

    service.readCandles = async () => ({
      ok: true,
      candles: breakCandles("close"),
      price: 111,
      stale: false,
      invented: false,
    });
    const closed = await service.readVisibleCandles(now);
    expect(closed.invented).toBe(false);
    expect(closed.structureBreak).toBe(110);
    expect(closed.breakSummary).toBe("Break of structure up at 110.");
    expect(closed.breakSummary).not.toContain("112");

    store.setLanguage("ar");
    const arabic = await service.readVisibleCandles(now);
    expect(arabic.structureBreak).toBe(110);
    expect(arabic.breakSummary).toBe("كسر هيكل صاعد عند 110.");
    expect(arabic.breakSummary).not.toContain("Break of structure");

    service.readCandles = async () => ({
      ok: false,
      candles: [],
      price: null,
      stale: true,
      invented: false,
      error: "down",
    });
    const failed = await service.readVisibleCandles(now);
    expect(failed.ok).toBe(false);
    expect(failed.structureBreak).toBeNull();
    expect(failed.breakSummary).toBeNull();
    expect(failed.timeframeSummary).toBeNull();
    store.close();
  });

  it("reports unavailable candles instead of inventing a quote", async () => {
    const previous = process.env.OANDA_API_TOKEN;
    delete process.env.OANDA_API_TOKEN;
    try {
      const read = await readGoldCandles(20, fetch);
      expect(read.ok).toBe(false);
      expect(read.invented).toBe(false);
      expect(read.candles).toEqual([]);
      expect(read.price).toBeNull();
    } finally {
      if (previous) {
        process.env.OANDA_API_TOKEN = previous;
      }
    }
  });

  it("keeps the session clock out of the market assessment", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const now = Date.UTC(2026, 0, 14, 15, 0);
    const fresh = service.marketSnapshot(now);
    expect(fresh.centers).toContain("London");
    expect(fresh.message).toContain("Gold is open");
    expect(fresh.assessment).toBe("No gold read is stored yet.");
    expect(fresh.assessment).not.toContain("Gold is open");

    store.setLanguage("ar");
    service.readCandles = async () => ({
      ok: true,
      candles: breakCandles("short"),
      price: 100,
      stale: false,
      invented: false,
    });
    await service.readVisibleCandles(now);
    const restarted = new LonoraService(store);
    const kept = restarted.marketSnapshot(now);
    expect(kept.assessment).toContain("الإطار الزمني الأعلى لم يُقرأ");
    expect(kept.assessment).not.toContain("Gold is open");
    expect(kept.assessment).not.toContain("سوق الذهب مفتوح");
    expect(kept.message).toContain("سوق الذهب مفتوح");
    store.close();
  });

  it("names the open centers on the market snapshot", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const winter = service.marketSnapshot(Date.UTC(2026, 0, 14, 15, 0));
    expect(winter.centers).toBe("London and New York are open. London and New York overlap.");
    expect(winter.invented).toBe(false);
    expect(winter.clock.session).toBe("newyork");
    store.setLanguage("ar");
    expect(service.marketSnapshot(Date.UTC(2026, 0, 17, 12, 0)).centers).toContain("سيدني");
    store.close();
  });

  it("drops a candle that has not closed yet", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const now = Date.parse("2026-01-05T15:00:00Z");
    service.readCandles = async () => ({
      ok: true,
      candles: [
        { time: now - 2 * 3_600_000, open: 2300, high: 2310, low: 2290, close: 2305 },
        { time: now, open: 2305, high: 2400, low: 2300, close: 2390 },
      ],
      price: 2390,
      stale: false,
      invented: false,
    });
    const read = await service.readVisibleCandles(now);
    expect(read.invented).toBe(false);
    expect(read.candles.map((candle) => candle.close)).toEqual([2305]);
    expect(read.pattern).toMatchObject({ stage: "unclassified", inventedTarget: false });
    store.close();
  });

  it("keeps the latest closed-candle structure in the gold brief", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const openAt = Date.UTC(2026, 0, 14, 15, 0);
    const closedAt = Date.parse("2026-01-03T15:00:00Z");
    const nearLow = hourlyCloses(openAt, [...Array.from({ length: 21 }, () => 120), 101]);
    const nearHigh = hourlyCloses(openAt, [...Array.from({ length: 21 }, () => 120), 140]);
    service.readCandles = async () => ({
      ok: true,
      candles: nearLow,
      price: 101,
      stale: false,
      invented: false,
    });

    const closed = await service.monitorOnce(closedAt);
    expect(closed.dataStatus).toBe("closed");
    expect(service.ownerBrief(closedAt)).toBe(
      `${service.sessionSentence(closedAt)} ${copy("en", "memory.empty")}`,
    );
    expect(service.ownerBrief(closedAt)).not.toContain("100");
    expect(service.recall("100", "structure_read")).toEqual([]);

    await service.monitorOnce(openAt);
    expect(service.ownerBrief()).toContain("Latest structure: No fresh close beyond a swing.");
    expect(service.ownerBrief()).toContain("Price is near the low of 100–121");
    expect(service.ownerBrief()).not.toMatch(/%/);
    expect(service.recall("near the low", "structure_read")).toHaveLength(1);
    expect(service.remember("structure_read", "invented target 9999", "XAUUSD")).toBeNull();
    expect(service.ownerBrief()).not.toContain("9999");

    service.readCandles = async () => ({
      ok: true,
      candles: nearHigh,
      price: 140,
      stale: false,
      invented: false,
    });
    const replaced = await service.readVisibleCandles(openAt);
    expect(replaced.invented).toBe(false);
    expect(replaced.range).toMatchObject({
      label: "near_high",
      low: 119,
      high: 141,
      invented: false,
    });
    expect(service.ownerBrief()).toContain("Price is near the high of 119–141");
    expect(service.ownerBrief()).not.toContain("near the low");
    expect(service.recall("near the high", "structure_read")).toHaveLength(1);

    service.readCandles = async () => ({
      ok: false,
      candles: [],
      price: null,
      stale: true,
      invented: false,
      error: "down",
    });
    const failed = await service.readVisibleCandles(openAt);
    expect(failed.ok).toBe(false);
    expect(failed.invented).toBe(false);
    expect(service.ownerBrief()).toContain("Price is near the high of 119–141");

    store.setLanguage("ar");
    service.readCandles = async () => ({
      ok: true,
      candles: nearLow,
      price: 101,
      stale: false,
      invented: false,
    });
    await service.readVisibleCandles(openAt);
    expect(service.ownerBrief()).toContain("آخر قراءة: لا إغلاق جديد يتجاوز سوينغاً.");
    expect(service.ownerBrief()).toContain("السعر قرب قاع النطاق 100–121");
    expect(service.ownerBrief()).not.toContain("Latest structure:");
    expect(service.ownerBrief()).not.toMatch(/%/);
    store.close();
  });

  it("keeps the nearest resting liquidity in the gold brief", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const openAt = Date.UTC(2026, 0, 14, 15, 0);
    const closedAt = Date.parse("2026-01-03T15:00:00Z");
    const swept = [
      ...Array.from({ length: 8 }, (_, index) => ({
        time: openAt - (12 - index) * 3_600_000,
        open: 100,
        high: 100.4,
        low: 99.6,
        close: 100,
      })),
      { time: openAt - 4 * 3_600_000, open: 100, high: 101.5, low: 99.9, close: 100 },
      { time: openAt - 3 * 3_600_000, open: 100, high: 101.5, low: 99.85, close: 100 },
      { time: openAt - 2 * 3_600_000, open: 100, high: 102.2, low: 99.95, close: 100.4 },
    ];
    service.readCandles = async () => ({
      ok: true,
      candles: swept,
      price: 100.4,
      stale: false,
      invented: false,
    });

    const closed = await service.monitorOnce(closedAt);
    expect(closed.dataStatus).toBe("closed");
    expect(service.recall("101.5", "liquidity_read")).toEqual([]);

    const read = await service.readVisibleCandles(openAt);
    expect(read.invented).toBe(false);
    expect(read.buySide).toBe(101.5);
    expect(read.sellSide).toBe(99.875);
    expect(read.latestSweep).toMatchObject({ side: "buy_side", sweptLevel: 101.5 });
    expect(service.ownerBrief()).toContain(
      "Latest liquidity: Resting buy-side 101.5. Resting sell-side 99.875. Buy-side sweep of 101.5.",
    );
    expect(service.ownerBrief()).toContain("The close came back inside.");
    expect(service.ownerBrief()).not.toMatch(/%/);
    expect(service.remember("liquidity_read", "invented pool 9999", "XAUUSD")).toBeNull();
    expect(service.ownerBrief()).not.toContain("9999");

    service.readCandles = async () => ({
      ok: true,
      candles: hourlyCloses(openAt, [110, 112, 114, 116, 118, 121]),
      price: 121,
      stale: false,
      invented: false,
    });
    const replaced = await service.readVisibleCandles(openAt);
    expect(replaced.buySide).toBeNull();
    expect(replaced.sellSide).toBeNull();
    expect(replaced.latestSweep).toBeNull();
    expect(service.ownerBrief()).toContain(copy("en", "liquidity.none"));
    expect(service.ownerBrief()).not.toContain("101.5");

    service.readCandles = async () => ({
      ok: false,
      candles: [],
      price: null,
      stale: true,
      invented: false,
      error: "down",
    });
    const failed = await service.readVisibleCandles(openAt);
    expect(failed.ok).toBe(false);
    expect(failed.buySide).toBeNull();
    expect(failed.sellSide).toBeNull();
    expect(service.ownerBrief()).toContain(copy("en", "liquidity.none"));

    store.setLanguage("ar");
    service.readCandles = async () => ({
      ok: true,
      candles: swept,
      price: 100.4,
      stale: false,
      invented: false,
    });
    await service.readVisibleCandles(openAt);
    expect(service.ownerBrief()).toContain("آخر سيولة: سيولة شرائية راكدة 101.5.");
    expect(service.ownerBrief()).toContain("مسح سيولة شرائية عند 101.5.");
    expect(service.ownerBrief()).not.toContain("Latest liquidity:");
    store.close();
  });

  it("keeps the nearest supply and demand zones in the gold brief", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const openAt = Date.UTC(2026, 0, 14, 15, 0);
    const closedAt = Date.parse("2026-01-03T15:00:00Z");
    const zoned = impulseZones(openAt);
    service.readCandles = async () => ({
      ok: true,
      candles: zoned,
      price: 90,
      stale: false,
      invented: false,
    });

    const closed = await service.monitorOnce(closedAt);
    expect(closed.dataStatus).toBe("closed");
    expect(service.recall("98", "zone_read")).toEqual([]);

    const read = await service.readVisibleCandles(openAt);
    expect(read.invented).toBe(false);
    expect(read.demand).toMatchObject({ type: "demand", low: 98, high: 100, invented: false });
    expect(read.supply).toMatchObject({ type: "supply", low: 102, high: 113, invented: false });
    expect(service.ownerBrief()).toContain("Latest zones: Demand 98–100, grade ");
    expect(service.ownerBrief()).toContain("Supply 102–113, grade ");
    expect(service.recall("Demand", "zone_read")[0]?.content).not.toMatch(/\b(buy|sell)\b/i);
    expect(service.ownerBrief()).not.toMatch(/%/);
    expect(service.remember("zone_read", "invented zone 9999", "XAUUSD")).toBeNull();
    expect(service.ownerBrief()).not.toContain("9999");

    service.readCandles = async () => ({
      ok: true,
      candles: hourlyCloses(
        openAt,
        Array.from({ length: 16 }, () => 50),
      ),
      price: 50,
      stale: false,
      invented: false,
    });
    const replaced = await service.readVisibleCandles(openAt);
    expect(replaced.demand).toBeNull();
    expect(replaced.supply).toBeNull();
    expect(service.ownerBrief()).toContain(copy("en", "zones.none"));
    expect(service.ownerBrief()).not.toContain("98–100");

    service.readCandles = async () => ({
      ok: false,
      candles: [],
      price: null,
      stale: true,
      invented: false,
      error: "down",
    });
    const failed = await service.readVisibleCandles(openAt);
    expect(failed.ok).toBe(false);
    expect(failed.demand).toBeNull();
    expect(service.ownerBrief()).toContain(copy("en", "zones.none"));

    store.setLanguage("ar");
    service.readCandles = async () => ({
      ok: true,
      candles: zoned,
      price: 90,
      stale: false,
      invented: false,
    });
    await service.readVisibleCandles(openAt);
    expect(service.ownerBrief()).toContain("آخر مناطق: طلب 98–100");
    expect(service.ownerBrief()).toContain("عرض 102–113");
    expect(service.ownerBrief()).not.toContain("Latest zones:");
    expect(service.recall("طلب", "zone_read")[0]?.content).not.toMatch(/شراء|بيع/);
    store.close();
  });

  it("keeps the last real price while gold is closed", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const closedAt = Date.parse("2026-01-03T15:00:00Z");
    store.saveObservation({
      candleTime: 1,
      price: 2300,
      session: "ny",
      marketOpen: true,
      atr: 1,
      structureEventKey: null,
      recommendationFingerprint: "",
    });
    const result = await service.monitorOnce(closedAt);
    expect(result.dataStatus).toBe("closed");
    expect(service.marketSnapshot(closedAt).lastPrice).toBe(2300);
    expect(service.marketSnapshot(closedAt).invented).toBe(false);
    expect(service.marketSnapshot(closedAt).calendar).toMatchObject({ known: false });
    expect(service.ownerBrief()).not.toContain("2300");
    expect(service.recall("2300", "market_observation")).toEqual([]);
    store.close();
  });

  it("runs the macro analyst from a real calendar event and ignores a closed-market price", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const closedAt = Date.parse("2026-01-03T15:00:00Z");
    store.saveObservation({
      candleTime: 1,
      price: 2300,
      session: "newyork",
      marketOpen: false,
      atr: 1,
      structureEventKey: null,
      macroEventKey: "none",
      recommendationFingerprint: "",
    });
    service.readCalendar = async () => ({
      ok: true,
      events: [
        {
          title: "CPI",
          time: new Date(closedAt + 30 * 60_000).toISOString(),
          impact: "high" as const,
          currency: "USD",
        },
      ],
      invented: false,
      stale: false,
      summary: "High: CPI (USD).",
    });
    const result = await service.monitorOnce(closedAt);
    expect(result.decision.reasons).toContain("macro_event");
    expect(result.decision.reasons).not.toContain("price_move");
    expect(service.marketSnapshot(closedAt).lastPrice).toBe(2300);
    expect(service.marketSnapshot(closedAt).assessment).toContain("CPI");
    expect(store.listAgentRuns()[0]).toMatchObject({ agent: "macro-news-analyst", status: "ok" });
    expect(service.ownerBrief()).toContain("Latest observation:");
    expect(service.ownerBrief()).toContain("A high-impact gold event is near.");
    expect(service.recall("high-impact", "market_observation")).toHaveLength(1);
    expect(service.ownerBrief()).not.toContain("2300");
    await service.monitorOnce(closedAt);
    expect(service.recall("high-impact", "market_observation")).toHaveLength(1);
    store.setLanguage("ar");
    expect(service.ownerBrief()).toContain("آخر ملاحظة:");
    store.close();
  });

  it("runs the macro analyst from a real headline and does not invent a price", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const closedAt = Date.parse("2026-01-03T15:00:00Z");
    store.saveObservation({
      candleTime: 1,
      price: 2300,
      session: "newyork",
      marketOpen: false,
      atr: 1,
      structureEventKey: null,
      macroEventKey: "none",
      headlineKey: "none",
      recommendationFingerprint: "",
    });
    service.readHeadlines = async () => ({
      ok: true,
      headlines: [
        {
          title: "Gold slips before CPI",
          source: "Reuters",
          publishedAt: new Date(closedAt - 60_000).toISOString(),
        },
      ],
      invented: false,
      stale: false,
      summary: "Gold slips before CPI from Reuters.",
    });
    const result = await service.monitorOnce(closedAt);
    expect(result.decision.reasons).toContain("headline_change");
    expect(result.decision.reasons).not.toContain("price_move");
    expect(service.marketSnapshot(closedAt).lastPrice).toBe(2300);
    expect(service.marketSnapshot(closedAt).assessment).toContain("Gold slips before CPI");
    expect(service.marketSnapshot(closedAt).assessment).toContain(
      copy("en", "calendar.unavailable"),
    );
    store.close();
  });

  it("sends a closed-session notice only when Telegram is bound", async () => {
    const closedAt = Date.parse("2026-01-03T15:00:00Z");
    const previous = {
      candleTime: 1,
      price: 2300,
      session: "asia",
      marketOpen: true,
      atr: 1,
      structureEventKey: null,
      recommendationFingerprint: "",
    };
    const unbound = LonoraStore.open(":memory:");
    const waiting = new LonoraService(unbound);
    const missed: string[] = [];
    waiting.setNoticeDelivery(async () => {
      missed.push("sent");
      return true;
    });
    unbound.saveObservation(previous);
    await waiting.monitorOnce(closedAt);
    expect(missed).toEqual([]);
    expect(unbound.getNotice("session:newyork:closed")).toMatchObject({
      status: "failed",
      payload: copy("en", "notify.telegramMissing"),
    });
    unbound.close();

    const bound = LonoraStore.open(":memory:");
    const service = new LonoraService(bound);
    expect(service.bindTelegram("555").ok).toBe(true);
    const sent: string[] = [];
    service.setNoticeDelivery(async ({ chatId, key, text }) => {
      sent.push(`${chatId}:${key}:${text}`);
      return true;
    });
    bound.saveObservation(previous);
    service.upsertResponsibility({
      title: "Morning briefing",
      instruction: "Every morning prepare a gold briefing",
      status: "scheduled",
      lastEvent: "Scheduled 0 8 * * 1-5 America/New_York.",
    });
    service.upsertResponsibility({
      title: "Watch structure",
      instruction: "Tell me if structure changes.",
      status: "running",
    });
    await service.monitorOnce(closedAt);
    const sessionNotice = `${copy("en", "notify.sessionClosed")} ${copy("en", "session.closed_saturday")}`;
    expect(sent).toEqual([`555:session:newyork:closed:${sessionNotice}`]);
    expect(sessionNotice).not.toMatch(/session_transition|macro_event/);
    expect(bound.getNotice("session:newyork:closed")).toMatchObject({
      status: "delivered",
      payload: sessionNotice,
    });
    expect(describeNotice("ar", "macro_event:USD:1:cpi")).toBe(copy("ar", "notify.macro"));
    expect(describeNotice("ar", "headline:gold")).not.toMatch(/headline_change/);
    const rows = bound.listResponsibilities();
    expect(rows.find((row) => row.status === "scheduled")).toMatchObject({
      lastEvent: "Scheduled 0 8 * * 1-5 America/New_York.",
      lastCheckAt: closedAt,
    });
    expect(rows.find((row) => row.status === "running")).toMatchObject({
      lastEvent: copy("en", "tasks.waitingClosed"),
      nextCheckAt: null,
      lastCheckAt: closedAt,
    });
    bound.close();
  });
});

describe("manual execution", () => {
  it("does not call a broker from the owner path when no broker is linked", () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    expect(service.confirmTrade({ caller: "schedule", ownerConfirmed: true })).toMatchObject({
      ok: false,
      code: "autonomous_trade_blocked",
      brokerCalled: false,
    });
    expect(service.confirmTrade({ caller: "owner", ownerConfirmed: true })).toEqual({
      ok: false,
      code: "not_linked",
      brokerCalled: false,
    });
    expect(() => service.notifyOwner("alert", "structure changed")).toThrow(/owner confirmation/);
    store.close();
  });

  it("prepares a recommendation from closed candles and does not call a broker", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const candles = Array.from({ length: 22 }, (_, index) => {
      const close = 2305;
      if (index === 4) {
        return {
          time: 1_700_000_000_000 + index * 3_600_000,
          open: 2300,
          high: 2304,
          low: 2296,
          close: 2298,
        };
      }
      if (index === 5) {
        return {
          time: 1_700_000_000_000 + index * 3_600_000,
          open: 2299,
          high: 2312,
          low: 2297,
          close: 2310,
        };
      }
      if (index === 14) {
        return {
          time: 1_700_000_000_000 + index * 3_600_000,
          open: 2304,
          high: 2360,
          low: 2302,
          close: 2305,
        };
      }
      return {
        time: 1_700_000_000_000 + index * 3_600_000,
        open: close + 0.2,
        high: close + 0.4,
        low: close - 0.4,
        close,
      };
    });
    service.readCandles = async () => ({
      ok: true,
      candles,
      price: 2305,
      stale: false,
      invented: false,
    });
    const prepared = await service.prepareRecommendation(candles.at(-1)!.time + 3_600_000);
    expect(prepared.ok).toBe(true);
    expect(prepared.brokerCalled).toBe(false);
    expect(prepared.invented).toBe(false);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.plan.stopLoss).toBeLessThan(2296);
    expect(prepared.plan.rationale).not.toContain("Gold is closed.");
    expect(store.listRecommendations()).toHaveLength(1);
    const saturday = Date.UTC(2026, 0, 17, 12, 0);
    const closed = await service.prepareRecommendation(saturday);
    expect(closed.ok).toBe(true);
    expect(closed.brokerCalled).toBe(false);
    if (!closed.ok) {
      return;
    }
    expect(closed.plan.entryType).not.toBe("market");
    expect(closed.plan.rationale).toContain(copy("en", "plan.closedScenario"));
    expect(closed.plan.rationale).toContain(copy("en", "plan.closedClock"));
    expect(evaluateRecommendation(closed.plan, candles).triggered).toBe(false);
    store.setLanguage("ar");
    const arabic = await service.prepareRecommendation(saturday);
    expect(arabic.ok).toBe(true);
    if (arabic.ok) {
      expect(arabic.plan.rationale).toContain(copy("ar", "plan.closedScenario"));
    }
    store.close();
  });

  it("grades closed candles from the market read and ignores a caller-supplied series", async () => {
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    const createdCandleTime = 1_800_000_000_000;
    service.saveRecommendation(plan({ createdCandleTime, createdAt: createdCandleTime }));
    service.readCandles = async () => ({
      ok: true,
      candles: [
        {
          time: createdCandleTime - 60_000,
          open: 2400,
          high: 2500,
          low: 2200,
          close: 2450,
        },
      ],
      price: 2450,
      stale: false,
      invented: false,
    });
    const graded = await service.gradeLiveRecommendations(createdCandleTime + 3_600_000);
    expect(graded.ok).toBe(true);
    expect(graded.updated).toEqual([]);
    expect(store.listRecommendations()[0]?.outcome).toBe("pending");
    const forced = service.gradeRecommendations([
      {
        time: createdCandleTime + 60_000,
        open: 2300,
        high: 2360,
        low: 2295,
        close: 2340,
      },
    ]);
    expect(forced[0]?.outcome).not.toBe("pending");
    store.close();
  });

  it("skips specialist work when today's usage has no price", async () => {
    const openAt = Date.parse("2026-01-05T15:00:00Z");
    expect(isGoldMarketOpenAt(openAt)).toBe(true);
    const store = LonoraStore.open(":memory:");
    const service = new LonoraService(store);
    service.dailyBudgetUsd = 5;
    store.saveObservation({
      candleTime: 1,
      price: 2300,
      session: "asia",
      marketOpen: true,
      atr: 1,
      structureEventKey: "none",
      recommendationFingerprint: "previous",
    });
    service.saveRecommendation(plan());
    service.upsertResponsibility({
      title: "Watch the plan",
      instruction: "Tell me if the recommendation changes.",
      status: "running",
    });
    service.readCandles = async () => ({
      ok: true,
      candles: risingCandles(20),
      price: 2320,
      stale: false,
      invented: false,
    });
    store.addUsage({
      id: "unpriced",
      at: openAt,
      provider: "unknown",
      model: "unknown",
      feature: "conversation",
      agent: "lonora",
      inputTokens: 10,
      outputTokens: 10,
      estimated: true,
    });
    expect(dailyBudgetAllows({ budgetUsd: 5, events: store.listUsage(), now: openAt })).toBe(false);
    const result = await service.monitorOnce(openAt);
    expect(result.decision.deepAnalysis).toBe(true);
    expect(result.assessment).toBeNull();
    expect(store.listResponsibilities()[0]?.lastEvent).toBe(copy("en", "notify.recommendation"));
    expect(store.listResponsibilities()[0]?.lastEvent).not.toMatch(/recommendation_change/);
    service.recordMonitorFailure(new Error("parse failed"));
    expect(service.marketSnapshot(openAt).dataStatus).toBe("failed");
    expect(service.marketSnapshot(openAt).dataError).toBe("parse failed");
    let reads = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    service.readCandles = async () => {
      reads += 1;
      await gate;
      return {
        ok: false,
        candles: [],
        price: null,
        stale: true,
        invented: false,
        error: "held",
      };
    };
    const first = service.startMonitor(openAt);
    const second = service.startMonitor(openAt);
    for (let step = 0; step < 6 && reads === 0; step += 1) {
      await Promise.resolve();
    }
    expect(reads).toBe(1);
    release();
    await first;
    await second;
    expect(reads).toBe(1);
    store.close();
  });
});
