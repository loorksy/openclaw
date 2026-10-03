import { describe, expect, it } from "vitest";
import type { Candle } from "./candles.js";
import { describePattern, classifySwingRange } from "./patterns.js";

function bar(index: number, high: number, low: number, close: number): Candle {
  return {
    time: 1_700_000_000_000 + index * 3_600_000,
    open: close,
    high,
    low,
    close,
  };
}

/** Tight bars keep ATR near 1 so a later wick or close is easy to judge. */
function base(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => bar(index, 100.5, 99.5, 100));
}

describe("swing range stage", () => {
  it("leaves a short sample unclassified and does not call the market quiet", () => {
    const pattern = classifySwingRange(base(8));
    const text = describePattern(pattern, "en");
    expect(pattern.stage).toBe("unclassified");
    expect(pattern.inventedTarget).toBe(false);
    expect(text.toLowerCase()).not.toMatch(/quiet|no pattern/);
    expect(describePattern(pattern, "ar")).not.toMatch(/هادئ|لا يوجد نمط/);
  });

  it("ignores a wick through the swing high", () => {
    const candles = [
      ...base(16),
      bar(16, 104, 99.5, 100),
      bar(17, 103, 99.5, 100),
      bar(18, 103, 99.5, 100),
      bar(19, 99.6, 96, 100),
      bar(20, 99.6, 97, 100),
      bar(21, 99.6, 97, 100),
      bar(22, 112, 99.6, 100.1),
    ];
    const pattern = classifySwingRange(candles);
    expect(pattern.stage).not.toBe("completed_unconfirmed");
    expect(pattern.stage).not.toBe("confirmed");
    expect(pattern.inventedTarget).toBe(false);
    expect(pattern.high).toBe(104);
  });

  it("completes on a close beyond the swing high and confirms only after follow-through", () => {
    const shared = [
      ...base(16),
      bar(16, 104, 99.5, 100),
      bar(17, 103, 99.5, 100),
      bar(18, 103, 99.5, 100),
      bar(19, 99.6, 96, 100),
      bar(20, 99.6, 97, 100),
      bar(21, 99.6, 97, 100),
    ];
    const completed = classifySwingRange([...shared, bar(22, 108, 99.6, 107)]);
    expect(completed.stage).toBe("completed_unconfirmed");
    expect(completed.direction).toBe("up");
    expect(completed.inventedTarget).toBe(false);
    expect(completed).not.toHaveProperty("target");

    const confirmed = classifySwingRange([
      ...shared,
      bar(22, 108, 99.6, 107),
      bar(23, 112, 99.6, 111),
    ]);
    expect(confirmed.stage).toBe("confirmed");
    expect(confirmed.inventedTarget).toBe(false);
  });

  it("marks an uptrend range failed when price closes through the opposite side", () => {
    const closes = [100, 110, 140, 120, 105, 115, 160, 130, 112, 125, 190, 150, 128, 140, 145];
    const candles = closes.map((close, index) => bar(index, close + 1, close - 1, close));
    candles.push(bar(15, 146, 90, 100));
    const pattern = classifySwingRange(candles);
    expect(pattern.stage).toBe("failed");
    expect(pattern.direction).toBe("down");
    expect(pattern.inventedTarget).toBe(false);
    expect(describePattern(pattern, "en").toLowerCase()).not.toMatch(/target|projected/);
  });

  it("calls a wide untouched range a start, not a finished structure", () => {
    const candles = [
      ...base(12),
      bar(12, 120, 99.5, 100),
      bar(13, 100.5, 99.5, 100),
      bar(14, 100.5, 99.5, 100),
      bar(15, 100.5, 80, 100),
      bar(16, 100.5, 99.5, 100),
      bar(17, 100.5, 99.5, 100),
      ...Array.from({ length: 6 }, (_, offset) => bar(18 + offset, 100.5, 99.5, 100)),
    ];
    const pattern = classifySwingRange(candles);
    expect(pattern.stage).toBe("starting");
    expect(pattern.inventedTarget).toBe(false);
    expect(pattern.completionRatio).toBeLessThan(0.35);
  });
});
