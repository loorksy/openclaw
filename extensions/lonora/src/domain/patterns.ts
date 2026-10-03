/**
 * Swing-range stage from closed candles.
 *
 * A range completes only when a later close clears the swing by the break
 * buffer. A wick through the swing is not a completion. The stage describes
 * the range; it does not invent a measured-move target.
 */
import {
  calculateAtr,
  detectSwings,
  detectTrend,
  type Candle,
  type Swing,
  type TrendLabel,
} from "./candles.js";
import { copy } from "./copy.js";
import type { OwnerLanguage } from "./owner.js";

/** Close must clear the swing by this multiple of ATR. Wicks do not count. */
export const BREAK_BUFFER_ATR = 0.25;
/** Follow-through after the breaking close before the stage is confirmed. */
export const CONFIRMATION_ATR = 0.5;

export type PatternStage =
  | "starting"
  | "forming"
  | "near_completion"
  | "completed_unconfirmed"
  | "confirmed"
  | "failed"
  | "unclassified";

export interface SwingRangePattern {
  stage: PatternStage;
  high: number | null;
  low: number | null;
  direction: "up" | "down" | null;
  breakLevel: number | null;
  completionRatio: number;
  inventedTarget: false;
}

const UNCLASSIFIED: SwingRangePattern = {
  stage: "unclassified",
  high: null,
  low: null,
  direction: null,
  breakLevel: null,
  completionRatio: 0,
  inventedTarget: false,
};

export function classifySwingRange(candles: Candle[]): SwingRangePattern {
  if (candles.length < 15) {
    return UNCLASSIFIED;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return UNCLASSIFIED;
  }
  const swings = detectSwings(candles);
  const high = swings.filter((swing) => swing.type === "high").at(-1);
  const low = swings.filter((swing) => swing.type === "low").at(-1);
  if (!high || !low || !(high.price > low.price)) {
    return UNCLASSIFIED;
  }
  if (high.price - low.price <= atr * BREAK_BUFFER_ATR) {
    return UNCLASSIFIED;
  }
  const establishedTime = Math.max(high.time, low.time);
  const fromIndex = candles.findIndex((candle) => candle.time >= establishedTime);
  if (fromIndex < 0) {
    return UNCLASSIFIED;
  }
  const trend = detectTrend(swings);
  const resolved = resolveRange({
    candles,
    fromIndex,
    high: high.price,
    low: low.price,
    atr,
    trend,
  });
  if (resolved.status === "invalidated") {
    return {
      stage: "failed",
      high: high.price,
      low: low.price,
      direction: resolved.direction,
      breakLevel: resolved.breakLevel,
      completionRatio: shapeProgress(swings, high.price, low.price, atr),
      inventedTarget: false,
    };
  }
  if (
    resolved.status === "completed" &&
    resolved.breakIndex != null &&
    resolved.breakLevel != null
  ) {
    const confirmed = candles
      .slice(resolved.breakIndex + 1)
      .some((candle) => Math.abs(candle.close - resolved.breakLevel!) > atr * CONFIRMATION_ATR);
    return {
      stage: confirmed ? "confirmed" : "completed_unconfirmed",
      high: high.price,
      low: low.price,
      direction: resolved.direction,
      breakLevel: resolved.breakLevel,
      completionRatio: 1,
      inventedTarget: false,
    };
  }
  const lastClose = candles.at(-1)?.close;
  if (lastClose == null || !Number.isFinite(lastClose)) {
    return UNCLASSIFIED;
  }
  const distanceAtr =
    Math.min(Math.abs(lastClose - high.price), Math.abs(lastClose - low.price)) / atr;
  const proximity = Math.max(0, Math.min(1, 1 - distanceAtr / 2));
  const progress = shapeProgress(swings, high.price, low.price, atr);
  const ratio = Math.max(progress * 0.6, proximity * 0.9);
  const stage: PatternStage =
    ratio < 0.35 ? "starting" : ratio < 0.75 ? "forming" : "near_completion";
  return {
    stage,
    high: high.price,
    low: low.price,
    direction: null,
    breakLevel:
      Math.abs(lastClose - high.price) <= Math.abs(lastClose - low.price) ? high.price : low.price,
    completionRatio: ratio,
    inventedTarget: false,
  };
}

export function describePattern(pattern: SwingRangePattern, language: OwnerLanguage): string {
  const bounds =
    pattern.low != null && pattern.high != null ? ` ${pattern.low}–${pattern.high}` : "";
  switch (pattern.stage) {
    case "unclassified":
      return copy(language, "pattern.unclassified");
    case "starting":
      return `${copy(language, "pattern.starting")}${bounds}`;
    case "forming":
      return `${copy(language, "pattern.forming")}${bounds}`;
    case "near_completion":
      return `${copy(language, "pattern.near")}${bounds}`;
    case "completed_unconfirmed":
      return copy(language, "pattern.completed");
    case "confirmed":
      return copy(language, "pattern.confirmed");
    case "failed":
      return copy(language, "pattern.failed");
  }
}

function shapeProgress(swings: Swing[], high: number, low: number, atr: number): number {
  const tolerance = Math.max(atr * BREAK_BUFFER_ATR, 0.05);
  let anchors = 0;
  for (const swing of swings) {
    if (swing.type === "high" && Math.abs(swing.price - high) <= tolerance) {
      anchors += 1;
    }
    if (swing.type === "low" && Math.abs(swing.price - low) <= tolerance) {
      anchors += 1;
    }
  }
  return Math.max(0, Math.min(1, anchors / 4));
}

function resolveRange(input: {
  candles: readonly Candle[];
  fromIndex: number;
  high: number;
  low: number;
  atr: number;
  trend: TrendLabel;
}): {
  status: "forming" | "completed" | "invalidated";
  breakIndex?: number;
  breakLevel: number | null;
  direction: "up" | "down" | null;
} {
  const completeDirection: "up" | "down" | "either" =
    input.trend === "uptrend" ? "up" : input.trend === "downtrend" ? "down" : "either";
  const up = firstCloseBeyond(input.candles, input.fromIndex, input.high, "up", input.atr);
  const down = firstCloseBeyond(input.candles, input.fromIndex, input.low, "down", input.atr);
  const first =
    up.breakIndex != null && down.breakIndex != null
      ? up.breakIndex <= down.breakIndex
        ? { direction: "up" as const, index: up.breakIndex, level: input.high }
        : { direction: "down" as const, index: down.breakIndex, level: input.low }
      : up.breakIndex != null
        ? { direction: "up" as const, index: up.breakIndex, level: input.high }
        : down.breakIndex != null
          ? { direction: "down" as const, index: down.breakIndex, level: input.low }
          : null;
  if (!first) {
    return { status: "forming", breakLevel: null, direction: null };
  }
  if (completeDirection === "either" || first.direction === completeDirection) {
    return {
      status: "completed",
      breakIndex: first.index,
      breakLevel: first.level,
      direction: first.direction,
    };
  }
  return {
    status: "invalidated",
    breakIndex: first.index,
    breakLevel: first.level,
    direction: first.direction,
  };
}

function firstCloseBeyond(
  candles: readonly Candle[],
  fromIndex: number,
  level: number,
  direction: "up" | "down",
  atr: number,
): { breakIndex?: number } {
  const tolerance = Math.max(atr * BREAK_BUFFER_ATR, Number.EPSILON);
  for (let index = Math.max(0, fromIndex + 1); index < candles.length; index += 1) {
    const close = candles[index]!.close;
    if (direction === "up" && close > level + tolerance) {
      return { breakIndex: index };
    }
    if (direction === "down" && close < level - tolerance) {
      return { breakIndex: index };
    }
  }
  return {};
}
