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
  /** A double top or double bottom when the swings qualify. Never a projected target. */
  named: NamedExtreme | null;
}

export interface NamedExtreme {
  kind: "double_top" | "double_bottom";
  stage: PatternStage;
  neckline: number;
  extreme: number;
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
  named: null,
};

const MAX_EXTREME_GAP_ATR = 0.4;
const MIN_BAR_SEPARATION = 8;
const MIN_HEIGHT_ATR = 0.5;

export function classifySwingRange(candles: Candle[]): SwingRangePattern {
  return { ...classifyRange(candles), named: classifyDoubleExtreme(candles) };
}

function classifyRange(candles: Candle[]): Omit<SwingRangePattern, "named"> {
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
  const name = namedLabel(pattern.named, language);
  const body = rangeSentence(pattern.stage, bounds, language);
  return name ? `${body} ${name}` : body;
}

function rangeSentence(stage: PatternStage, bounds: string, language: OwnerLanguage): string {
  switch (stage) {
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

function namedLabel(named: NamedExtreme | null, language: OwnerLanguage): string {
  if (!named || named.inventedTarget !== false) {
    return "";
  }
  return copy(language, named.kind === "double_top" ? "pattern.doubleTop" : "pattern.doubleBottom");
}

function classifyDoubleExtreme(candles: Candle[]): NamedExtreme | null {
  if (candles.length < 15) {
    return null;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return null;
  }
  const swings = detectSwings(candles)
    .map((swing) => ({
      ...swing,
      index: candles.findIndex((candle) => candle.time === swing.time),
    }))
    .filter((swing) => swing.index >= 0);
  const top = scanDouble(candles, swings, atr, "top");
  const bottom = scanDouble(candles, swings, atr, "bottom");
  if (top && bottom) {
    return top.secondIndex >= bottom.secondIndex ? top.named : bottom.named;
  }
  return top?.named ?? bottom?.named ?? null;
}

function scanDouble(
  candles: readonly Candle[],
  swings: readonly (Swing & { index: number })[],
  atr: number,
  variant: "top" | "bottom",
): { named: NamedExtreme; secondIndex: number } | null {
  const extremeKind = variant === "top" ? "high" : "low";
  for (let end = swings.length - 1; end >= 2; end -= 1) {
    const second = swings[end]!;
    const middle = swings[end - 1]!;
    const first = swings[end - 2]!;
    if (first.type !== extremeKind || second.type !== extremeKind || middle.type === extremeKind) {
      continue;
    }
    if (second.index - first.index < MIN_BAR_SEPARATION) {
      continue;
    }
    if (Math.abs(second.price - first.price) > MAX_EXTREME_GAP_ATR * atr) {
      continue;
    }
    const extreme =
      variant === "top" ? Math.max(first.price, second.price) : Math.min(first.price, second.price);
    const neckline = middle.price;
    if (Math.abs(extreme - neckline) <= atr * MIN_HEIGHT_ATR) {
      continue;
    }
    const breakDirection = variant === "top" ? "down" : "up";
    const completion = firstCloseBeyond(candles, second.index, neckline, breakDirection, atr);
    const invalidation = firstCloseBeyond(
      candles,
      second.index,
      extreme,
      variant === "top" ? "up" : "down",
      atr,
    );
    const invalidatedFirst =
      invalidation.breakIndex != null &&
      (completion.breakIndex == null || invalidation.breakIndex < completion.breakIndex);
    const completed = completion.breakIndex != null && !invalidatedFirst;
    let stage: PatternStage;
    if (invalidatedFirst) {
      stage = "failed";
    } else if (completed && completion.breakIndex != null) {
      const confirmed = candles
        .slice(completion.breakIndex + 1)
        .some((candle) => Math.abs(candle.close - neckline) > atr * CONFIRMATION_ATR);
      stage = confirmed ? "confirmed" : "completed_unconfirmed";
    } else {
      const lastClose = candles.at(-1)?.close;
      const distanceAtr = lastClose == null ? 2 : Math.abs(lastClose - neckline) / atr;
      const proximity = Math.max(0, Math.min(1, 1 - distanceAtr / 2));
      const ratio = Math.max(0.45, proximity * 0.9);
      stage = ratio < 0.75 ? "forming" : "near_completion";
    }
    return {
      secondIndex: second.index,
      named: {
        kind: variant === "top" ? "double_top" : "double_bottom",
        stage,
        neckline,
        extreme,
        inventedTarget: false,
      },
    };
  }
  return null;
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
