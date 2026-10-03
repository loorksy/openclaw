import { describe, expect, it } from "vitest";
import type { Candle } from "./candles.js";
import {
  CASE_FORWARD,
  CASE_LOOKBACK,
  findSimilarCases,
  fingerprintAt,
  fingerprintSimilarity,
  indexCandleCases,
  resolveForwardOutcome,
  type HistoricalCase,
} from "./cases.js";

function candle(index: number, close: number, span = 1): Candle {
  return {
    time: 1_700_000_000_000 + index * 3_600_000,
    open: close - span / 4,
    high: close + span,
    low: close - span,
    close,
  };
}

describe("historical cases", () => {
  it("refuses a fingerprint until the window can describe a moment", () => {
    expect(fingerprintAt([candle(0, 2300)])).toBeNull();
  });

  it("resolves a bar that touches both the stop and the target as a stop", () => {
    const outcome = resolveForwardOutcome({
      direction: "buy",
      entry: 2300,
      atr: 10,
      future: [candle(1, 2300, 30)],
    });
    expect(outcome.resolution).toBe("stop_first");
    expect(outcome.netR).toBe(-1);
  });

  it("indexes only moments that still have a later outcome window", () => {
    const candles = Array.from({ length: CASE_LOOKBACK + CASE_FORWARD + 8 }, (_, index) =>
      candle(index, 2200 + index),
    );
    const cases = indexCandleCases(candles);
    expect(cases.length).toBeGreaterThan(0);
    const latestAllowed = candles.at(-(CASE_FORWARD + 1))!.time;
    for (const item of cases) {
      expect(item.caseTime).toBeLessThanOrEqual(latestAllowed);
      expect(item.caseTime).toBeLessThan(candles.at(-1)!.time);
    }
  });

  it("does not turn a handful of similar moments into a win rate", () => {
    const candles = Array.from({ length: 40 }, (_, index) => candle(index, 2300 + index * 0.2));
    const current = fingerprintAt(candles);
    expect(current).not.toBeNull();
    const cases: HistoricalCase[] = Array.from({ length: 3 }, (_, index) => ({
      caseTime: candles[0]!.time - (index + 1) * 3_600_000,
      direction: "buy" as const,
      fingerprint: current!,
      outcome: {
        resolution: "target_first" as const,
        bars: 2,
        maxFavourableAtr: 2,
        maxAdverseAtr: 0.2,
        netR: 2,
      },
    }));
    const report = findSimilarCases(candles, cases, "en");
    expect(report.matches).toBe(3);
    expect(report.winRate).toBeNull();
    expect(report.text).not.toMatch(/%/);
    expect(fingerprintSimilarity(current!, current!)).toBe(1);
  });

  it("reports a rate only after eight resolved matches", () => {
    const candles = Array.from({ length: 40 }, (_, index) => candle(index, 2300));
    const current = fingerprintAt(candles)!;
    const cases: HistoricalCase[] = Array.from({ length: 8 }, (_, index) => ({
      caseTime: candles[0]!.time - (index + 1) * 3_600_000,
      direction: "buy" as const,
      fingerprint: current,
      outcome: {
        resolution: "target_first" as const,
        bars: 3,
        maxFavourableAtr: 2,
        maxAdverseAtr: 0.1,
        netR: 2,
      },
    }));
    const report = findSimilarCases(candles, cases, "ar");
    expect(report.winRate).toBe(1);
    expect(report.text).toContain("شراء 8, 100%.");
    expect(report.text).not.toContain("بيع");
  });

  it("does not average a buy and a sell from the same moment", () => {
    const candles = Array.from({ length: 40 }, (_, index) => candle(index, 2300));
    const current = fingerprintAt(candles)!;
    const cases: HistoricalCase[] = [];
    for (let index = 0; index < 8; index += 1) {
      const caseTime = candles[0]!.time - (index + 1) * 3_600_000;
      cases.push(
        {
          caseTime,
          direction: "buy",
          fingerprint: current,
          outcome: {
            resolution: "target_first",
            bars: 3,
            maxFavourableAtr: 2,
            maxAdverseAtr: 0.1,
            netR: 2,
          },
        },
        {
          caseTime,
          direction: "sell",
          fingerprint: current,
          outcome: {
            resolution: "stop_first",
            bars: 3,
            maxFavourableAtr: 0.2,
            maxAdverseAtr: 1,
            netR: -1,
          },
        },
      );
    }
    const report = findSimilarCases(candles, cases, "en");
    expect(report.matches).toBe(16);
    expect(report.resolved).toBe(16);
    expect(report.winRate).toBeNull();
    expect(report.text).toContain("Buy 8, 100%.");
    expect(report.text).toContain("Sell 8, 0%.");
    expect(report.text).not.toMatch(/50%/);
    const thin = findSimilarCases(
      candles,
      [
        ...cases.filter((item) => item.direction === "buy"),
        ...cases.filter((item) => item.direction === "sell").slice(0, 3),
      ],
      "en",
    );
    expect(thin.winRate).toBeNull();
    expect(thin.text).toContain("Buy 8, 100%.");
    expect(thin.text).toContain("Sell 3/3.");
    expect(thin.text.split("Sell")[1] ?? "").not.toMatch(/%/);
  });
});
