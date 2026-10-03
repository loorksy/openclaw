import { describe, expect, it } from "vitest";
import type { Candle } from "./candles.js";
import { describeCandleShape, latestCandleShape } from "./candlesticks.js";

function bar(index: number, open: number, high: number, low: number, close: number): Candle {
  return { time: 1_700_000_000_000 + index * 3_600_000, open, high, low, close };
}

function trend(direction: "down" | "up"): Candle[] {
  return Array.from({ length: 16 }, (_, index) => {
    const close = direction === "down" ? 120 - index : 100 + index;
    return bar(index, close, close + 0.3, close - 0.3, close);
  });
}

describe("closed candle shapes", () => {
  it("names a hammer after a decline and does not call it a trade", () => {
    const candles = [...trend("down"), bar(16, 105, 105.6, 101, 105.5)];
    const shape = latestCandleShape(candles);
    expect(shape).toMatchObject({ name: "hammer", bias: "bullish", inventedTarget: false });
    expect(shape).not.toHaveProperty("target");
    const text = describeCandleShape(shape, "en");
    expect(text).toContain("Hammer");
    expect(text.toLowerCase()).not.toMatch(/target|buy|sell/);
    expect(describeCandleShape(shape, "ar")).toContain("مطرقة");
    expect(describeCandleShape(shape, "ar")).toContain("ليست صفقة");
  });

  it("names the same lower wick a hanging man after a rise", () => {
    const candles = [...trend("up"), bar(16, 116, 116.6, 112, 116.5)];
    expect(latestCandleShape(candles)).toMatchObject({
      name: "hanging_man",
      bias: "bearish",
      inventedTarget: false,
    });
  });

  it("does not name a short lower wick a hammer", () => {
    const candles = [...trend("down"), bar(16, 105, 105.4, 104.7, 105.2)];
    expect(latestCandleShape(candles)?.name).not.toBe("hammer");
  });

  it("names a bullish engulfing only when the body covers the previous body", () => {
    const base = Array.from({ length: 16 }, (_, index) => bar(index, 108, 108.4, 107.6, 108));
    const covered = [
      ...base.slice(0, 15),
      bar(15, 110, 110.4, 103.6, 104),
      bar(16, 103, 113, 102, 112),
    ];
    expect(latestCandleShape(covered)).toMatchObject({
      name: "bullish_engulfing",
      bias: "bullish",
      inventedTarget: false,
    });
    expect(latestCandleShape(covered)).not.toHaveProperty("target");

    const wickOnly = [
      ...base.slice(0, 15),
      bar(15, 110, 110.4, 103.6, 104),
      bar(16, 103.5, 112, 100, 104.2),
    ];
    expect(latestCandleShape(wickOnly)?.name).not.toBe("bullish_engulfing");
  });

  it("names a doji only when the body is tiny against ATR", () => {
    const candles = [
      ...Array.from({ length: 16 }, (_, index) => bar(index, 100, 101, 99, 100)),
      bar(16, 100, 101.2, 98.8, 100.02),
    ];
    const shape = latestCandleShape(candles);
    expect(shape).toMatchObject({ name: "doji", bias: "neutral", inventedTarget: false });
    expect(describeCandleShape(shape, "en").toLowerCase()).not.toMatch(/target|buy|sell/);
  });
});
