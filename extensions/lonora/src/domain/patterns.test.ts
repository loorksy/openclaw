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

  it("names a double top only after a close through the neckline", () => {
    const candles = doubleTop();
    const forming = classifySwingRange(candles);
    expect(forming.named).toMatchObject({
      kind: "double_top",
      stage: "forming",
      neckline: 100,
      inventedTarget: false,
    });
    expect(forming.named).not.toHaveProperty("target");
    expect(describePattern(forming, "en")).toContain("Double top");
    expect(describePattern(forming, "ar")).toContain("قمة مزدوجة");
    expect(describePattern(forming, "en").toLowerCase()).not.toMatch(/projected|measured/);

    const wicked = classifySwingRange([...candles, bar(candles.length, 104.4, 90, 103)]);
    expect(wicked.named?.stage).not.toBe("completed_unconfirmed");
    expect(wicked.named?.stage).not.toBe("confirmed");

    const completed = classifySwingRange([...candles, bar(candles.length, 104.4, 96, 98)]);
    expect(completed.named?.stage).toBe("completed_unconfirmed");
    expect(completed.named?.inventedTarget).toBe(false);

    const confirmed = classifySwingRange([
      ...candles,
      bar(candles.length, 104.4, 96, 98),
      bar(candles.length + 1, 104.4, 94, 96),
    ]);
    expect(confirmed.named?.stage).toBe("confirmed");

    const failed = classifySwingRange([...candles, bar(candles.length, 114, 103, 113)]);
    expect(failed.named?.stage).toBe("failed");
    expect(failed.named?.inventedTarget).toBe(false);
  });

  it("names a head and shoulders only after a close through the neckline", () => {
    const candles = headAndShoulders();
    const forming = classifySwingRange(candles);
    expect(forming.named).toMatchObject({
      kind: "head_and_shoulders",
      neckline: 100,
      extreme: 116,
      inventedTarget: false,
    });
    expect(forming.named?.stage).not.toBe("completed_unconfirmed");
    expect(forming.named).not.toHaveProperty("target");
    expect(describePattern(forming, "en")).toContain("Head and shoulders");
    expect(describePattern(forming, "ar")).toContain("رأس وكتفان");
    expect(describePattern(forming, "en").toLowerCase()).not.toMatch(/projected|measured/);

    const wicked = classifySwingRange([...candles, bar(candles.length, 104, 90, 103)]);
    expect(wicked.named?.stage).not.toBe("completed_unconfirmed");
    expect(wicked.named?.kind).toBe("head_and_shoulders");

    const completed = classifySwingRange([...candles, bar(candles.length, 104, 96, 98)]);
    expect(completed.named).toMatchObject({
      kind: "head_and_shoulders",
      stage: "completed_unconfirmed",
      inventedTarget: false,
    });

    const confirmed = classifySwingRange([
      ...candles,
      bar(candles.length, 104, 96, 98),
      bar(candles.length + 1, 104, 94, 96),
    ]);
    expect(confirmed.named?.stage).toBe("confirmed");

    const failed = classifySwingRange([...candles, bar(candles.length, 122, 104, 120)]);
    expect(failed.named).toMatchObject({
      kind: "head_and_shoulders",
      stage: "failed",
      inventedTarget: false,
    });
  });

  it("names an ascending triangle only after a close beyond the flat ceiling", () => {
    const candles = ascendingTriangle();
    const forming = classifySwingRange(candles);
    expect(forming.named).toMatchObject({
      kind: "ascending_triangle",
      stage: "forming",
      neckline: 112,
      extreme: 106,
      inventedTarget: false,
    });
    expect(forming.named).not.toHaveProperty("target");
    expect(forming.named).not.toHaveProperty("projectedTarget");
    expect(describePattern(forming, "en")).toContain("Ascending triangle");
    expect(describePattern(forming, "ar")).toContain("مثلث صاعد");
    expect(describePattern(forming, "en").toLowerCase()).not.toMatch(/projected|measured/);

    const wicked = classifySwingRange([...candles, bar(candles.length, 120, 107, 109)]);
    expect(wicked.named?.kind).toBe("ascending_triangle");
    expect(wicked.named?.stage).not.toBe("completed_unconfirmed");
    expect(wicked.named?.stage).not.toBe("confirmed");

    const completed = classifySwingRange([...candles, bar(candles.length, 116, 107, 114)]);
    expect(completed.named).toMatchObject({
      kind: "ascending_triangle",
      stage: "completed_unconfirmed",
      inventedTarget: false,
    });
    expect(completed.named).not.toHaveProperty("target");

    const confirmed = classifySwingRange([
      ...candles,
      bar(candles.length, 116, 107, 114),
      bar(candles.length + 1, 120, 110, 118),
    ]);
    expect(confirmed.named?.stage).toBe("confirmed");
    expect(confirmed.named?.inventedTarget).toBe(false);

    const failed = classifySwingRange([...candles, bar(candles.length, 110, 96, 100)]);
    expect(failed.named).toMatchObject({
      kind: "ascending_triangle",
      stage: "failed",
      inventedTarget: false,
    });
  });
});

function headAndShoulders(): Candle[] {
  const candles = Array.from({ length: 40 }, (_, index) => bar(index, 104.4, 103.6, 104));
  const peak = (index: number, price: number) => {
    candles[index] = bar(index, price, 103.6, price - 1);
    candles[index - 1] = bar(index - 1, price - 2, 103.6, 104);
    candles[index + 1] = bar(index + 1, price - 2, 103.6, 104);
    candles[index - 2] = bar(index - 2, price - 2, 103.6, 104);
    candles[index + 2] = bar(index + 2, price - 2, 103.6, 104);
  };
  const trough = (index: number) => {
    candles[index] = bar(index, 104.2, 100, 102);
    candles[index - 1] = bar(index - 1, 105, 103, 104);
    candles[index + 1] = bar(index + 1, 105, 103, 104);
    candles[index - 2] = bar(index - 2, 105, 103, 104);
    candles[index + 2] = bar(index + 2, 105, 103, 104);
  };
  peak(8, 108);
  trough(14);
  peak(20, 116);
  trough(26);
  peak(32, 108);
  return candles;
}

function ascendingTriangle(): Candle[] {
  const candles = Array.from({ length: 46 }, (_, index) => bar(index, 109, 108.5, 108.7));
  const peak = (index: number) => {
    candles[index] = bar(index, 112, 108.5, 108.7);
    for (const offset of [-2, -1, 1, 2]) {
      candles[index + offset] = bar(index + offset, 110, 108.5, 108.7);
    }
  };
  const trough = (index: number, price: number) => {
    candles[index] = bar(index, 109, price, 108.7);
    for (const offset of [-2, -1, 1, 2]) {
      candles[index + offset] = bar(index + offset, 109, price + 2, 108.7);
    }
  };
  peak(10);
  trough(16, 100);
  peak(22);
  trough(28, 103);
  peak(34);
  trough(40, 106);
  return candles;
}

function doubleTop(): Candle[] {
  const candles = Array.from({ length: 28 }, (_, index) => bar(index, 104.5, 103.5, 104));
  const high = (index: number, price: number) => {
    candles[index] = bar(index, price, 103.5, 105);
    candles[index - 2] = bar(index - 2, 106, 103.5, 104);
    candles[index - 1] = bar(index - 1, 106, 103.5, 104);
    candles[index + 1] = bar(index + 1, 106, 103.5, 104);
    candles[index + 2] = bar(index + 2, 106, 103.5, 104);
  };
  high(8, 110);
  high(20, 110.2);
  candles[14] = bar(14, 104.2, 100, 102);
  candles[12] = bar(12, 105, 103, 104);
  candles[13] = bar(13, 105, 103, 104);
  candles[15] = bar(15, 105, 103, 104);
  candles[16] = bar(16, 105, 103, 104);
  return candles;
}
