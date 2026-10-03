import { describe, expect, it } from "vitest";
import type { Candle, SupplyDemandZone } from "./candles.js";
import { scoreZone } from "./score-poi.js";

function candle(time: number, low: number, high: number): Candle {
  return { time, open: (low + high) / 2, high, low, close: (low + high) / 2 };
}

describe("zone score", () => {
  const zone: SupplyDemandZone = { type: "demand", low: 100, high: 102, time: 1_000 };

  it("rejects a zone that has been retested three times", () => {
    const candles = [
      candle(1_000, 100, 102),
      candle(2_000, 101, 103),
      candle(3_000, 110, 112),
      candle(4_000, 101, 103),
      candle(5_000, 110, 112),
      candle(6_000, 101, 103),
      candle(7_000, 110, 111),
    ];
    const scored = scoreZone({
      zone,
      candles,
      currentPrice: 110,
      atr: 2,
      structureEvents: [],
      sweeps: [],
      range: null,
      htfLevels: [],
      otherZones: [],
    });
    expect(scored.warnings).toContain("spent");
    expect(scored.tradable).toBe(false);
  });

  it("marks a fresh impulsive zone as tradable", () => {
    const candles = [candle(1_000, 100, 102), candle(2_000, 104, 112), candle(3_000, 108, 110)];
    const scored = scoreZone({
      zone,
      candles,
      currentPrice: 109,
      atr: 2,
      structureEvents: [
        {
          type: "BOS",
          direction: "bullish",
          brokenLevel: 104,
          breakCandleTime: 2_000,
          confirmationClose: 110,
          strength: 60,
        },
      ],
      sweeps: [],
      range: { rangeLow: 100, rangeHigh: 112 },
      htfLevels: [],
      otherZones: [],
    });
    expect(scored.reasons).toEqual(
      expect.arrayContaining(["fresh", "impulse_strong", "structure", "discount"]),
    );
    expect(scored.tradable).toBe(true);
    expect(scored.grade === "A" || scored.grade === "B").toBe(true);
  });
});
