import { describe, expect, it } from "vitest";
import type { Candle } from "./candles.js";
import { computeNetR } from "./geometry.js";
import { applyStopDistanceFloor, placeProtectedStop, stopBuffer } from "./geometry.js";
import {
  holdClosedMarketPlan,
  prepareGoldPlan,
  selectStructuralTargets,
  analyzePathToEntry,
  describePlanQuality,
  higherTimeframeBias,
  timeframeAlignment,
} from "./plan.js";
import { evaluateRecommendation } from "./recommendations.js";

function bar(index: number, open: number, high: number, low: number, close: number): Candle {
  return { time: 1_700_000_000_000 + index * 3_600_000, open, high, low, close };
}

function quiet(index: number, close: number): Candle {
  return bar(index, close + 0.2, close + 0.4, close - 0.4, close);
}

describe("protected stop", () => {
  it("places the stop beyond structure and does not pull a wide stop inward", () => {
    const buffer = stopBuffer({ symbolPrice: 2300, atr: 8, interval: "1h" });
    expect(buffer).toBeCloseTo(6);
    const placed = placeProtectedStop({
      action: "buy",
      entry: 2300,
      structuralStop: 2290,
      atr: 8,
      interval: "1h",
    });
    expect(placed?.stop).toBeLessThan(2290);
    expect(placed?.stop).toBeCloseTo(2284, 1);
    expect(placed?.widened).toBe(false);
    const wide = applyStopDistanceFloor({
      action: "buy",
      entry: 2300,
      stop: 2200,
      atr: 8,
      interval: "1h",
    });
    expect(wide.widened).toBe(false);
    expect(wide.stop).toBe(2200);
  });

  it("widens a stop that sits one rejection away from the entry", () => {
    const tight = applyStopDistanceFloor({
      action: "sell",
      entry: 2300,
      stop: 2301,
      atr: 10,
      interval: "15m",
    });
    expect(tight.widened).toBe(true);
    expect(tight.stop).toBeGreaterThan(2301);
  });
});

describe("prepare gold plan", () => {
  it("prepares a buy whose stop is beyond the demand zone and does not invent a target", () => {
    const candles: Candle[] = [];
    for (let index = 0; index < 4; index += 1) {
      candles.push(quiet(index, 2302));
    }
    candles.push(bar(4, 2300, 2304, 2296, 2298));
    candles.push(bar(5, 2299, 2312, 2297, 2310));
    for (let index = 6; index < 22; index += 1) {
      candles.push(index === 14 ? bar(14, 2304, 2360, 2302, 2305) : quiet(index, 2305));
    }
    const prepared = prepareGoldPlan(candles, "en", candles.at(-1)!.time);
    expect(prepared.ok).toBe(true);
    expect(prepared.brokerCalled).toBe(false);
    expect(prepared.invented).toBe(false);
    if (!prepared.ok) {
      return;
    }
    expect(prepared.plan.direction).toBe("buy");
    expect(prepared.plan.stopLoss).toBeLessThan(2296);
    expect(prepared.plan.targets[0]).toBeGreaterThan(prepared.plan.entry);
    expect(prepared.plan.targets.length).toBeLessThanOrEqual(3);
    expect(prepared.plan.rationale).toContain("Structural targets");
    expect(prepared.plan.rationale).toContain("The spread was not read");
    expect(prepared.plan.rationale).not.toContain("Net reward after spread");
    expect(prepared.plan.rationale).toContain("The higher timeframe was not read.");
    expect(prepared.plan.rationale).toContain("Price is in the discount of");
    expect(prepared.plan.rationale).not.toContain("does not favor an immediate entry");
    expect(prepared.plan.outcome).toBe("pending");
    expect(prepared.plan.rationale).toContain("2296");
    expect(prepared.plan.rationale).toMatch(/Zone grade [AB]/);
  });

  it("keeps only structural targets past the span floor", () => {
    expect(
      selectStructuralTargets({
        action: "buy",
        entry: 2300,
        atr: 2,
        levels: [2304, 2320, 2360, 2400],
      }),
    ).toEqual([2320, 2360, 2400]);
    expect(
      selectStructuralTargets({
        action: "buy",
        entry: 2300,
        atr: 10,
        levels: [2305, 2312],
      }),
    ).toEqual([]);
  });

  it("does not turn distance into a trade the other way", () => {
    const broken = analyzePathToEntry({
      action: "buy",
      currentPrice: 2280,
      entry: 2300,
      atr: 8,
      zoneLow: 2290,
      zoneHigh: 2300,
    });
    expect(broken.class).toBe("invalidated_before_activation");
    expect(broken.transitionalTrade).toBe(false);
    const away = analyzePathToEntry({
      action: "sell",
      currentPrice: 2280,
      entry: 2320,
      atr: 8,
      zoneLow: 2310,
      zoneHigh: 2330,
    });
    expect(away.class).toBe("unlikely_reach");
    expect(away.transitionalTrade).toBe(false);
    const waiting = analyzePathToEntry({
      action: "buy",
      currentPrice: 2310,
      entry: 2300,
      atr: 8,
      zoneLow: 2290,
      zoneHigh: 2302,
    });
    expect(waiting.class).toBe("neutral_path");
    expect(waiting.transitionalTrade).toBe(false);
  });

  it("names an unread spread and a short higher timeframe instead of inventing either", () => {
    const unread = computeNetR({ entry: 2300, stop: 2290, target: 2330 });
    expect(unread.spreadKnown).toBe(false);
    expect(unread.netR).toBeCloseTo(3);
    const wide = computeNetR({ entry: 2300, stop: 2290, target: 2330, spread: 2 });
    expect(wide.spreadKnown).toBe(true);
    expect(wide.netR).toBeLessThan(2.5);
    const text = describePlanQuality({
      action: "buy",
      entry: 2300,
      stop: 2290,
      target: 2330,
      spread: 2,
      higherBias: "bearish",
      language: "en",
    });
    expect(text).toContain("does not pay the spread");
    expect(text).toContain("conflicts");
    expect(text).not.toContain("was not read");
    const rising = Array.from({ length: 80 }, (_, index) => quiet(index, 2300 + index));
    expect(higherTimeframeBias(rising)).toBe("bullish");
    expect(timeframeAlignment("buy", "bullish")).toBe("aligned");
    expect(timeframeAlignment("sell", "bullish")).toBe("conflict");
    expect(higherTimeframeBias(rising.slice(0, 22))).toBe("unknown");
    expect(timeframeAlignment("buy", "unknown")).toBe("unknown");
  });

  it("holds a closed-market entry until the next open", () => {
    const nextOpenAt = Date.UTC(2026, 0, 18, 23, 0);
    const held = holdClosedMarketPlan(
      {
        id: "closed",
        symbol: "XAUUSD",
        direction: "buy",
        entryType: "market",
        entry: 2300,
        stopLoss: 2280,
        targets: [2360],
        status: "pending_entry",
        outcome: "pending",
        createdCandleTime: 1,
        createdAt: Date.UTC(2026, 0, 17, 12, 0),
        rationale: "Live plan.",
      },
      "en",
      nextOpenAt,
    );
    expect(held.entryType).toBe("limit_touch");
    expect(held.triggeredAt).toBeUndefined();
    expect(held.rationale).toContain("Gold is closed. This plan waits for the next open at");
    expect(held.rationale).toContain("New York.");
    expect(evaluateRecommendation(held, []).triggered).toBe(false);
    expect(evaluateRecommendation(held, []).status).toBe("pending_entry");
    expect(holdClosedMarketPlan(held, "ar", nextOpenAt).rationale).toContain("الذهب مغلق");
  });

  it("does not invent a plan when the candle sample is too short", () => {
    const prepared = prepareGoldPlan([quiet(0, 2300), quiet(1, 2301)], "ar");
    expect(prepared.ok).toBe(false);
    if (!prepared.ok) {
      expect(prepared.reason).toBe("insufficient_candles");
      expect(prepared.message).toContain("الشموع");
    }
  });
});
