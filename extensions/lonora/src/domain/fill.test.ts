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
