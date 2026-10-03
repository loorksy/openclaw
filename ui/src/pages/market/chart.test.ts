// @vitest-environment node
import { describe, expect, it } from "vitest";
import { candleChart } from "./chart.ts";

describe("candleChart", () => {
  it("draws nothing when the feed has no closed candles", () => {
    expect(candleChart([])).toBeNull();
  });

  it("marks a rising close as up and a falling close as down", () => {
    const chart = candleChart([
      { time: 1, open: 100, high: 110, low: 95, close: 108 },
      { time: 2, open: 108, high: 109, low: 90, close: 92 },
    ]);
    expect(chart?.bars).toHaveLength(2);
    expect(chart?.bars[0]?.up).toBe(true);
    expect(chart?.bars[1]?.up).toBe(false);
    expect(chart?.bars[0]?.highY).toBeLessThan(chart?.bars[0]?.lowY ?? 0);
    expect(chart?.lines).toEqual([]);
    expect(chart?.bands).toEqual([]);
  });

  it("draws a known level above the candles without adding a candle", () => {
    const candles = [{ time: 1, open: 100, high: 110, low: 95, close: 108 }];
    const chart = candleChart(candles, [
      { kind: "prior-high", price: 130 },
      { kind: "buy-side", price: Number.NaN },
      { kind: "demand", low: 90, high: 100 },
    ]);
    expect(chart?.bars).toHaveLength(1);
    expect(chart?.lines.map((line) => line.kind)).toEqual(["prior-high"]);
    expect(chart?.lines[0]?.y).toBeLessThan(chart?.bars[0]?.highY ?? 0);
    expect(chart?.bands).toEqual([
      expect.objectContaining({ kind: "demand", height: expect.any(Number) }),
    ]);
    expect(chart?.bands[0]?.height).toBeGreaterThan(0);
    expect(candleChart([], [{ kind: "prior-high", price: 130 }])).toBeNull();
  });
});
