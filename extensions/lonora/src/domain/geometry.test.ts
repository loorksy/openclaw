import { describe, expect, it } from "vitest";
import type { Candle } from "./candles.js";
import { applyStopDistanceFloor, placeProtectedStop, stopBuffer } from "./geometry.js";
import { prepareGoldPlan } from "./plan.js";

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
    expect(prepared.plan.outcome).toBe("pending");
    expect(prepared.plan.rationale).toContain("2296");
    expect(prepared.plan.rationale).toMatch(/Zone grade [AB]/);
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
