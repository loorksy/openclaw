import { describe, expect, it } from "vitest";
import type { Candle } from "./candles.js";
import { computeRangePosition, describeRange, positionDisfavorsEntry } from "./range-position.js";

function flat(count: number, low: number, high: number, close: number): Candle[] {
  return Array.from({ length: count }, (_, index) => ({
    time: 1_700_000_000_000 + index * 3_600_000,
    open: close,
    high,
    low,
    close,
  }));
}

describe("dealing range", () => {
  it("does not invent a location from a short or flat sample", () => {
    expect(computeRangePosition(flat(19, 100, 110, 105), 105)).toBeNull();
    expect(computeRangePosition(flat(20, 100, 100, 100), 100)).toBeNull();
    expect(computeRangePosition(flat(20, 100, 110, 105), null)).toBeNull();
  });

  it("names premium, discount, and the edges from the last closed price", () => {
    const candles = flat(20, 100, 200, 150);
    expect(computeRangePosition(candles, 162)?.label).toBe("premium");
    expect(computeRangePosition(candles, 161)?.label).toBe("mid_range");
    expect(computeRangePosition(candles, 138)?.label).toBe("discount");
    expect(computeRangePosition(candles, 139)?.label).toBe("mid_range");
    expect(computeRangePosition(candles, 195)?.label).toBe("near_high");
    expect(computeRangePosition(candles, 105)?.label).toBe("near_low");
    const named = computeRangePosition(candles, 170);
    expect(named).toMatchObject({ high: 200, low: 100, label: "premium", invented: false });
    expect(describeRange("en", named!)).toBe("Price is in the premium of 100–200");
    expect(describeRange("ar", named!)).toContain("العلاوة");
    expect(describeRange("en", named!).toLowerCase()).not.toMatch(/target|buy|sell/);
  });

  it("delays an entry that starts on the wrong side and keeps the direction available", () => {
    expect(positionDisfavorsEntry("premium", "buy")).toBe(true);
    expect(positionDisfavorsEntry("discount", "buy")).toBe(false);
    expect(positionDisfavorsEntry("discount", "sell")).toBe(true);
    expect(positionDisfavorsEntry("premium", "sell")).toBe(false);
    expect(positionDisfavorsEntry("near_high", "buy")).toBe(true);
    expect(positionDisfavorsEntry("near_low", "sell")).toBe(true);
    expect(positionDisfavorsEntry("mid_range", "buy")).toBe(true);
    expect(positionDisfavorsEntry("mid_range", "sell")).toBe(true);
  });
});
