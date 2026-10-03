import { describe, expect, it } from "vitest";
import { detectLiquiditySweeps, enrichSweepsWithStructure } from "./liquidity-sweeps.js";

const BAR = 60_000;

function candle(index: number, open: number, high: number, low: number, close: number) {
  return { time: index * BAR, open, high, low, close };
}

function flat(count: number) {
  return Array.from({ length: count }, (_, index) => candle(index, 100, 100.5, 99.5, 100));
}

describe("liquidity sweeps", () => {
  it("detects a buy-side wick that closes back inside", () => {
    const sweeps = detectLiquiditySweeps({
      candles: [...flat(10), candle(10, 100, 102.2, 99.9, 100.6)],
      equalHighs: [{ price: 101.5, time: 4 * BAR }],
      equalLows: [],
      atr: 1,
    });
    expect(sweeps).toHaveLength(1);
    expect(sweeps[0]).toMatchObject({
      side: "buy_side",
      sweptLevel: 101.5,
      closeBackInside: true,
      followedByStructureShift: false,
    });
  });

  it("detects a sell-side wick that closes back inside", () => {
    const sweeps = detectLiquiditySweeps({
      candles: [...flat(10), candle(10, 100, 100.2, 97.8, 99.4)],
      equalHighs: [],
      equalLows: [{ price: 98.5, time: 4 * BAR }],
      atr: 1,
    });
    expect(sweeps[0]?.side).toBe("sell_side");
  });

  it("ignores a pool that forms after the candle", () => {
    const sweeps = detectLiquiditySweeps({
      candles: [...flat(10), candle(10, 100, 102.2, 99.9, 100.6)],
      equalHighs: [{ price: 101.5, time: 20 * BAR }],
      equalLows: [],
      atr: 1,
    });
    expect(sweeps).toEqual([]);
  });

  it("raises strength when a later opposite CHoCH follows the sweep", () => {
    const sweeps = detectLiquiditySweeps({
      candles: [...flat(10), candle(10, 100, 102.2, 99.9, 100.6)],
      equalHighs: [{ price: 101.5, time: 4 * BAR }],
      equalLows: [],
      atr: 1,
    });
    const enriched = enrichSweepsWithStructure(sweeps, [
      {
        type: "CHoCH",
        direction: "bearish",
        brokenLevel: 99.8,
        breakCandleTime: 12 * BAR,
        confirmationClose: 99.5,
        strength: 70,
      },
    ]);
    expect(enriched[0]?.followedByStructureShift).toBe(true);
    expect(enriched[0]?.strength).toBeGreaterThan(sweeps[0]?.strength ?? 0);
  });
});
