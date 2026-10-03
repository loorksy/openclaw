import { mkdtempSync } from "node:fs";
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
import { checkResponsibility, cronForResponsibility } from "./domain/responsibilities.js";
import { dailyBudgetAllows, estimateCostUsd, rollupUsage, usageIdentity } from "./domain/usage.js";
import { planBotyMigration } from "./migrate-boty.js";
import { LonoraService } from "./service.js";
import { LonoraStore } from "./store.js";

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
    expect(result.summary).toContain("uptrend");
    expect(result.summary.toLowerCase()).not.toMatch(/quiet|no pattern/);
    expect(result.data.pattern).toMatchObject({ inventedTarget: false });
    expect(result.summary).not.toBe("reviewed supplied evidence");
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
    expect(result.summary).toContain("buy_side sweep of 101.5");
  });

  it("fails closed when the sample is too short", () => {
    const result = runSpecialist("liquidity-analyst", { candles: risingCandles(2) });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("insufficient_candles");
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
    expect(empty.ownerBrief()).toBe(copy("en", "memory.empty"));
    expect(empty.ownerBrief()).not.toMatch(/%/);
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
    burst.store.close();
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
    expect(store.listRecommendations()).toHaveLength(1);
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
