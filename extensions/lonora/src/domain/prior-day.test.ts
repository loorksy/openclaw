import { describe, expect, it } from "vitest";
import { detectMajorLevels, type Candle } from "./candles.js";
import { priorGoldDay } from "./market.js";

/** Monday 5 Oct 2026 18:00 America/New_York, during eastern daylight time. */
const DAY_OPEN = Date.UTC(2026, 9, 5, 22, 0, 0);

function bar(offsetHours: number, high: number, low: number): Candle {
  return {
    time: DAY_OPEN + offsetHours * 3_600_000,
    open: low,
    high,
    low,
    close: low,
  };
}

describe("prior gold day", () => {
  it("leaves the forming day unread and ignores the 17:00 halt", () => {
    const currentOnly = [0, 1, 2, 3].map((offset) => bar(offset, 108, 104));
    expect(priorGoldDay(currentOnly)).toBeNull();

    const shortPrior = [0, 1, 2].map((offset) => bar(offset, 110, 100));
    const nextDay = [24, 25, 26, 27].map((offset) => bar(offset, 106, 104));
    expect(priorGoldDay([...shortPrior, ...nextDay])).toBeNull();

    const prior = [0, 1, 2, 3].map((offset) =>
      bar(offset, offset === 1 ? 110 : 106, offset === 2 ? 100 : 104),
    );
    const halt = bar(23, 999, 1);
    const read = priorGoldDay([...prior, halt, ...nextDay]);
    expect(read).toMatchObject({ high: 110, low: 100, invented: false });
    expect(read?.high).not.toBe(999);
  });

  it("offers the prior high and low as structural levels beyond the last close", () => {
    const prior = [0, 1, 2, 3].map((offset) => bar(offset, 110, 100));
    const current = [24, 25, 26, 27].map((offset) => bar(offset, 106, 104));
    const candles = [...prior, ...current];
    const day = priorGoldDay(candles);
    expect(day).not.toBeNull();
    const levels = detectMajorLevels(candles, [
      {
        time: day!.highTime,
        open: day!.low,
        high: day!.high,
        low: day!.low,
        close: day!.low,
      },
    ]);
    expect(levels.resistance.map((level) => level.price)).toContain(110);
    expect(levels.support.map((level) => level.price)).toContain(100);
  });
});
