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
  });
});
