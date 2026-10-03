import { describe, expect, it } from "vitest";
import {
  createActivationEvaluator,
  describeActivationRule,
  evaluateActivationRule,
  explainActivationRuleIncoherence,
  normalizeActivationRule,
  parseActivationRule,
  serializeActivationRule,
  type ActivationRule,
} from "./activation-rule.js";

function candle(time: number, open: number, high: number, low: number, close: number) {
  return { time, open, high, low, close };
}

const WICK_THROUGH_100 = candle(1, 98, 101.5, 97.5, 99);
const CLOSE_ABOVE_100 = candle(2, 99, 101.8, 98.8, 101.2);

describe("activation rules", () => {
  it("lets a wick satisfy a touch and not a close", () => {
    const touch: ActivationRule = {
      kind: "price_touch",
      level: 100,
      direction: "above",
      timeframe: "1h",
    };
    const close: ActivationRule = { kind: "candle_close_above", level: 100, timeframe: "1h" };
    expect(evaluateActivationRule(touch, [WICK_THROUGH_100]).activated).toBe(true);
    expect(evaluateActivationRule(close, [WICK_THROUGH_100]).activated).toBe(false);
    expect(evaluateActivationRule(close, [CLOSE_ABOVE_100]).evidence?.at).toBe(2);
  });

  it("requires consecutive closes and honors tolerance", () => {
    const two: ActivationRule = {
      kind: "candle_close_above",
      level: 100,
      timeframe: "1h",
      closes: 2,
    };
    expect(
      evaluateActivationRule(two, [
        CLOSE_ABOVE_100,
        candle(3, 101, 101.4, 98, 99.2),
        candle(4, 99, 101.6, 98.9, 101.1),
      ]).activated,
    ).toBe(false);
    expect(
      evaluateActivationRule(two, [CLOSE_ABOVE_100, candle(3, 101, 102, 100.5, 101.6)]).activated,
    ).toBe(true);
    const tolerant: ActivationRule = {
      kind: "candle_close_above",
      level: 100,
      timeframe: "1h",
      tolerance: 0.5,
    };
    expect(evaluateActivationRule(tolerant, [candle(1, 99, 100.9, 98, 100.3)]).activated).toBe(
      false,
    );
    expect(evaluateActivationRule(tolerant, [candle(1, 99, 101.5, 98, 100.9)]).activated).toBe(
      true,
    );
  });

  it("requires break, return, then confirmation for a retest", () => {
    const rule: ActivationRule = {
      kind: "retest_confirmed",
      level: 100,
      direction: "above",
      retestZone: { low: 99.5, high: 100.5 },
      timeframe: "1h",
    };
    const returned = candle(3, 101, 101.2, 99.8, 100.4);
    const confirmed = candle(4, 100.4, 102.5, 100.2, 102.1);
    expect(
      evaluateActivationRule(rule, [CLOSE_ABOVE_100, candle(3, 101, 104, 101, 103.8)]).activated,
    ).toBe(false);
    expect(evaluateActivationRule(rule, [returned, confirmed]).activated).toBe(false);
    expect(evaluateActivationRule(rule, [CLOSE_ABOVE_100, returned, confirmed]).evidence?.at).toBe(
      4,
    );
  });

  it("requires a pierce and a close back for a rejection", () => {
    const rule: ActivationRule = {
      kind: "rejection_confirmed",
      level: 100,
      direction: "above",
      timeframe: "1h",
    };
    expect(evaluateActivationRule(rule, [candle(1, 100.5, 102, 100.2, 101.5)]).activated).toBe(
      false,
    );
    expect(evaluateActivationRule(rule, [candle(1, 100.5, 101, 98, 98.4)]).activated).toBe(false);
    expect(evaluateActivationRule(rule, [candle(1, 100.6, 101.2, 98.4, 100.9)]).activated).toBe(
      true,
    );
  });

  it("treats composite all and any differently and ignores expired candles", () => {
    const all: ActivationRule = {
      kind: "composite",
      operator: "all",
      rules: [
        { kind: "candle_close_above", level: 100, timeframe: "1h" },
        { kind: "price_touch", level: 103, direction: "above", timeframe: "1h" },
      ],
    };
    expect(evaluateActivationRule(all, [CLOSE_ABOVE_100]).activated).toBe(false);
    expect(
      evaluateActivationRule(all, [CLOSE_ABOVE_100, candle(3, 101, 103.4, 100.9, 103.1)]).activated,
    ).toBe(true);
    expect(evaluateActivationRule({ ...all, operator: "any" }, [CLOSE_ABOVE_100]).activated).toBe(
      true,
    );
    expect(
      evaluateActivationRule(
        { kind: "candle_close_above", level: 100, timeframe: "1h", expiresAt: 1 },
        [CLOSE_ABOVE_100],
      ).activated,
    ).toBe(false);
  });

  it("keeps the first activation when later candles also qualify", () => {
    const evaluator = createActivationEvaluator({
      kind: "candle_close_above",
      level: 100,
      timeframe: "1h",
    });
    const first = evaluator.observe(CLOSE_ABOVE_100);
    const second = evaluator.observe(candle(3, 101, 103, 100.8, 102.6));
    expect(first.evidence?.at).toBe(2);
    expect(second.evidence?.at).toBe(2);
  });

  it("parses a stored rule and rejects a malformed one", () => {
    const rule: ActivationRule = {
      kind: "retest_confirmed",
      level: 1.1025,
      direction: "above",
      retestZone: { low: 1.1, high: 1.1035 },
      timeframe: "15m",
    };
    expect(parseActivationRule(serializeActivationRule(rule))).toEqual(rule);
    expect(parseActivationRule("not json")).toBeNull();
    expect(parseActivationRule({ kind: "teleport", level: 1 })).toBeNull();
    expect(parseActivationRule({ kind: "candle_close_above", level: 100 })).toEqual({
      kind: "candle_close_above",
      level: 100,
    });
    expect(
      parseActivationRule({
        kind: "retest_confirmed",
        level: 100,
        direction: "above",
        timeframe: "1h",
        retestZone: { low: 101, high: 99 },
      }),
    ).toBeNull();
    expect(
      parseActivationRule({
        kind: "composite",
        operator: "all",
        rules: [
          { kind: "price_touch", level: 4000 },
          { kind: "candle_close_above", level: 4000, timeframe: "15m" },
        ],
      }),
    ).toMatchObject({ kind: "composite" });
  });

  it("fills only a missing timeframe and flags an already-satisfied condition", () => {
    expect(normalizeActivationRule({ kind: "candle_close_above", level: 100 }, "15m")).toEqual({
      kind: "candle_close_above",
      level: 100,
      timeframe: "15m",
    });
    expect(
      explainActivationRuleIncoherence({
        rule: { kind: "candle_close_below", level: 4348.27, timeframe: "15m" },
        direction: "sell",
        currentPrice: 4340,
        tolerance: 0.5,
      }),
    ).toMatch(/already satisfied/);
    expect(
      explainActivationRuleIncoherence({
        rule: {
          kind: "breakout_confirmed",
          level: 4360,
          direction: "above",
          timeframe: "15m",
        },
        direction: "sell",
        currentPrice: 4340,
      }),
    ).toMatch(/contradicts/);
    expect(describeActivationRule({ kind: "price_touch", level: 100 }, "ar")).toBe(
      "لمس السعر مستوى 100",
    );
  });
});
