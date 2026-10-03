/**
 * Closed-candle shapes. A name describes the bar. It does not place a trade
 * or store a measured target.
 */
import { calculateAtr, type Candle } from "./candles.js";
import { copy } from "./copy.js";
import type { OwnerLanguage } from "./owner.js";

export type CandleShapeName =
  | "doji"
  | "hammer"
  | "inverted_hammer"
  | "shooting_star"
  | "hanging_man"
  | "marubozu_bullish"
  | "marubozu_bearish"
  | "spinning_top"
  | "bullish_engulfing"
  | "bearish_engulfing"
  | "morning_star"
  | "evening_star"
  | "three_white_soldiers"
  | "three_black_crows"
  | "bullish_harami"
  | "bearish_harami"
  | "tweezer_top"
  | "tweezer_bottom";

export interface CandleShape {
  name: CandleShapeName;
  bias: "bullish" | "bearish" | "neutral";
  inventedTarget: false;
}

const DOJI_BODY_ATR = 0.08;
const LONG_BODY_ATR = 0.6;
const LONG_WICK_RATIO = 2;

interface Parts {
  body: number;
  upper: number;
  lower: number;
  range: number;
  bullish: boolean;
  bearish: boolean;
}

export function latestCandleShape(candles: readonly Candle[]): CandleShape | null {
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0) || candles.length < 3) {
    return null;
  }
  const signals = detectShapes(candles, atr);
  const latest = signals[0];
  if (!latest) {
    return null;
  }
  return { name: latest.name, bias: latest.bias, inventedTarget: false };
}

export function describeCandleShape(shape: CandleShape | null, language: OwnerLanguage): string {
  if (!shape || shape.inventedTarget !== false) {
    return copy(language, "candle.none");
  }
  return `${copy(language, shapeKey(shape.name))}. ${copy(language, "candle.notATrade")}`;
}

function shapeKey(name: CandleShapeName) {
  switch (name) {
    case "doji":
      return "candle.doji" as const;
    case "hammer":
      return "candle.hammer" as const;
    case "inverted_hammer":
      return "candle.inverted_hammer" as const;
    case "shooting_star":
      return "candle.shooting_star" as const;
    case "hanging_man":
      return "candle.hanging_man" as const;
    case "marubozu_bullish":
      return "candle.marubozu_bullish" as const;
    case "marubozu_bearish":
      return "candle.marubozu_bearish" as const;
    case "spinning_top":
      return "candle.spinning_top" as const;
    case "bullish_engulfing":
      return "candle.bullish_engulfing" as const;
    case "bearish_engulfing":
      return "candle.bearish_engulfing" as const;
    case "morning_star":
      return "candle.morning_star" as const;
    case "evening_star":
      return "candle.evening_star" as const;
    case "three_white_soldiers":
      return "candle.three_white_soldiers" as const;
    case "three_black_crows":
      return "candle.three_black_crows" as const;
    case "bullish_harami":
      return "candle.bullish_harami" as const;
    case "bearish_harami":
      return "candle.bearish_harami" as const;
    case "tweezer_top":
      return "candle.tweezer_top" as const;
    case "tweezer_bottom":
      return "candle.tweezer_bottom" as const;
  }
}

function detectShapes(
  candles: readonly Candle[],
  atr: number,
): { name: CandleShapeName; index: number; bias: CandleShape["bias"]; strength: number }[] {
  const start = Math.max(2, candles.length - 30);
  const signals: {
    name: CandleShapeName;
    index: number;
    bias: CandleShape["bias"];
    strength: number;
  }[] = [];
  const push = (
    name: CandleShapeName,
    index: number,
    bias: CandleShape["bias"],
    strength: number,
  ) => {
    signals.push({ name, index, bias, strength: clamp(strength) });
  };

  for (let index = start; index < candles.length; index += 1) {
    const candle = candles[index]!;
    const part = parts(candle);
    const previous = candles[index - 1]!;
    const previousPart = parts(previous);
    const trend = priorTrend(candles, index);

    if (part.body <= atr * DOJI_BODY_ATR) {
      push("doji", index, "neutral", 55 + (1 - part.body / (atr * DOJI_BODY_ATR)) * 25);
    } else if (
      part.body >= atr * LONG_BODY_ATR &&
      part.upper <= part.body * 0.1 &&
      part.lower <= part.body * 0.1
    ) {
      push(
        part.bullish ? "marubozu_bullish" : "marubozu_bearish",
        index,
        part.bullish ? "bullish" : "bearish",
        70 + (part.body / atr) * 10,
      );
    } else if (part.body <= part.range * 0.35 && part.upper > part.body && part.lower > part.body) {
      push("spinning_top", index, "neutral", 50);
    }

    const longLower =
      part.lower >= part.body * LONG_WICK_RATIO &&
      part.lower >= part.range * 0.5 &&
      part.upper <= part.lower * 0.35;
    const longUpper =
      part.upper >= part.body * LONG_WICK_RATIO &&
      part.upper >= part.range * 0.5 &&
      part.lower <= part.upper * 0.35;
    if (longLower && part.body > atr * DOJI_BODY_ATR) {
      if (trend === "down") {
        push("hammer", index, "bullish", 60 + (part.lower / atr) * 12);
      } else if (trend === "up") {
        push("hanging_man", index, "bearish", 55 + (part.lower / atr) * 10);
      }
    }
    if (longUpper && part.body > atr * DOJI_BODY_ATR) {
      if (trend === "up") {
        push("shooting_star", index, "bearish", 60 + (part.upper / atr) * 12);
      } else if (trend === "down") {
        push("inverted_hammer", index, "bullish", 55 + (part.upper / atr) * 10);
      }
    }

    const engulfsBody =
      Math.min(candle.open, candle.close) <= Math.min(previous.open, previous.close) &&
      Math.max(candle.open, candle.close) >= Math.max(previous.open, previous.close);
    if (engulfsBody && part.body > previousPart.body && previousPart.body > 0) {
      if (part.bullish && previousPart.bearish) {
        push("bullish_engulfing", index, "bullish", 65 + (part.body / atr) * 10);
      } else if (part.bearish && previousPart.bullish) {
        push("bearish_engulfing", index, "bearish", 65 + (part.body / atr) * 10);
      }
    }

    const insidePrevious =
      Math.max(candle.open, candle.close) <= Math.max(previous.open, previous.close) &&
      Math.min(candle.open, candle.close) >= Math.min(previous.open, previous.close);
    if (insidePrevious && previousPart.body >= atr * 0.4 && part.body < previousPart.body * 0.6) {
      if (previousPart.bearish) {
        push("bullish_harami", index, "bullish", 58);
      } else if (previousPart.bullish) {
        push("bearish_harami", index, "bearish", 58);
      }
    }

    const tweezerTolerance = atr * 0.1;
    if (Math.abs(candle.high - previous.high) <= tweezerTolerance && trend === "up") {
      push("tweezer_top", index, "bearish", 55);
    }
    if (Math.abs(candle.low - previous.low) <= tweezerTolerance && trend === "down") {
      push("tweezer_bottom", index, "bullish", 55);
    }

    if (index >= 2) {
      const first = candles[index - 2]!;
      const firstPart = parts(first);
      const smallMiddle = previousPart.body <= firstPart.body * 0.5;
      if (
        firstPart.bearish &&
        smallMiddle &&
        part.bullish &&
        candle.close > first.open - firstPart.body * 0.5 &&
        firstPart.body >= atr * 0.4
      ) {
        push("morning_star", index, "bullish", 70);
      }
      if (
        firstPart.bullish &&
        smallMiddle &&
        part.bearish &&
        candle.close < first.open + firstPart.body * 0.5 &&
        firstPart.body >= atr * 0.4
      ) {
        push("evening_star", index, "bearish", 70);
      }
      const three = [first, previous, candle];
      const bodiesReal = three.every((bar) => Math.abs(bar.close - bar.open) >= atr * 0.3);
      const allBull = three.every((bar) => bar.close > bar.open);
      const allBear = three.every((bar) => bar.close < bar.open);
      if (allBull && previous.close > first.close && candle.close > previous.close && bodiesReal) {
        push("three_white_soldiers", index, "bullish", 72);
      }
      if (allBear && previous.close < first.close && candle.close < previous.close && bodiesReal) {
        push("three_black_crows", index, "bearish", 72);
      }
    }
  }

  signals.sort((left, right) => right.index - left.index || right.strength - left.strength);
  return signals.slice(0, 8);
}

function priorTrend(candles: readonly Candle[], index: number): "up" | "down" | "flat" {
  const from = Math.max(0, index - 5);
  if (index - from < 2) {
    return "flat";
  }
  const first = candles[from]!.close;
  const last = candles[index - 1]!.close;
  const move = last - first;
  const scale = Math.abs(first) * 0.0008;
  if (move > scale) {
    return "up";
  }
  if (move < -scale) {
    return "down";
  }
  return "flat";
}

function parts(candle: Candle): Parts {
  const body = Math.abs(candle.close - candle.open);
  const upper = candle.high - Math.max(candle.open, candle.close);
  const lower = Math.min(candle.open, candle.close) - candle.low;
  return {
    body,
    upper: Math.max(0, upper),
    lower: Math.max(0, lower),
    range: Math.max(candle.high - candle.low, Number.EPSILON),
    bullish: candle.close > candle.open,
    bearish: candle.close < candle.open,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}
