import { describe, expect, it } from "vitest";
import { entryFillTolerance, resolveFill, resolveTargetHit } from "./fill.js";

describe("gold fill band", () => {
  it("keeps the gold band between 10 and 15 points", () => {
    expect(entryFillTolerance({ price: 2300, atr: null })).toBe(10);
    expect(entryFillTolerance({ price: 2300, atr: 200 })).toBe(15);
  });

  it("records the traded price when the candle only reaches the band", () => {
    const fill = resolveFill({
      plan: { direction: "buy", entryType: "limit_touch", entry: 2300 },
      candle: { time: 2, open: 2288, high: 2292, low: 2284, close: 2288 },
      conditionMet: true,
      armedBefore: false,
      tolerance: 10,
    });
    expect(fill).toEqual({ filled: true, effectiveEntry: 2292 });
  });

  it("fills a sell retest at the band edge the candle traded", () => {
    const fill = resolveFill({
      plan: {
        direction: "sell",
        entryType: "retest_zone",
        entry: 4348.27,
        stopLoss: 4360,
        retestZone: { from: 4344, to: 4349 },
      },
      candle: { time: 2, open: 4335, high: 4346, low: 4333, close: 4340 },
      conditionMet: false,
      armedBefore: true,
    });
    expect(fill).toEqual({ filled: true, effectiveEntry: 4344 });
  });

  it("records the traded overlap when the candle does not reach the far edge", () => {
    const fill = resolveFill({
      plan: {
        direction: "sell",
        entryType: "retest_zone",
        entry: 4348.27,
        stopLoss: 4360,
        retestZone: { from: 4344, to: 4349 },
      },
      candle: { time: 3, open: 4345.2, high: 4346, low: 4345, close: 4345.4 },
      conditionMet: true,
      armedBefore: false,
    });
    expect(fill).toEqual({ filled: true, effectiveEntry: 4345 });
  });

  it("does not fill a retest outside the band, without a band, or through the stop", () => {
    const outside = resolveFill({
      plan: {
        direction: "sell",
        entryType: "retest_zone",
        entry: 4348.27,
        stopLoss: 4360,
        retestZone: { from: 4344, to: 4349 },
      },
      candle: { time: 2, open: 4335, high: 4342, low: 4330, close: 4336 },
      conditionMet: true,
      armedBefore: false,
    });
    const missing = resolveFill({
      plan: { direction: "sell", entryType: "retest_zone", entry: 4348.27, stopLoss: 4360 },
      candle: { time: 2, open: 4345, high: 4346, low: 4344, close: 4345 },
      conditionMet: true,
      armedBefore: false,
    });
    const throughStop = resolveFill({
      plan: {
        direction: "sell",
        entryType: "retest_zone",
        entry: 4348.27,
        stopLoss: 4348,
        retestZone: { from: 4344, to: 4349 },
      },
      candle: { time: 2, open: 4345, high: 4346, low: 4344, close: 4345 },
      conditionMet: true,
      armedBefore: false,
    });
    expect(outside.filled).toBe(false);
    expect(missing.filled).toBe(false);
    expect(throughStop.filled).toBe(false);
  });

  it("leaves a limit unfilled when price stays outside the band", () => {
    const fill = resolveFill({
      plan: { direction: "buy", entryType: "limit_touch", entry: 2300 },
      candle: { time: 2, open: 2270, high: 2280, low: 2260, close: 2275 },
      conditionMet: true,
      armedBefore: false,
      tolerance: 10,
    });
    expect(fill.filled).toBe(false);
  });

  it("counts a target inside the band at the price that printed", () => {
    expect(
      resolveTargetHit({
        direction: "buy",
        target: 2320,
        candle: { high: 2312, low: 2304 },
        tolerance: 10,
      }),
    ).toEqual({ reached: true, hitPrice: 2312 });
    expect(
      resolveTargetHit({
        direction: "buy",
        target: 2320,
        candle: { high: 2304, low: 2300 },
        tolerance: 10,
      }).reached,
    ).toBe(false);
  });
});
