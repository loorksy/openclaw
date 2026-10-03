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
  kind: "double_top" | "double_bottom" | "head_and_shoulders" | "inverse_head_and_shoulders";
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
const MIN_HEAD_PROMINENCE_ATR = 1.2;
const MAX_SHOULDER_ASYMMETRY = 0.25;

export function classifySwingRange(candles: Candle[]): SwingRangePattern {
  return {
    ...classifyRange(candles),
    named: classifyHeadShoulders(candles) ?? classifyDoubleExtreme(candles),
  };
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
  switch (named.kind) {
    case "double_top":
      return copy(language, "pattern.doubleTop");
    case "double_bottom":
      return copy(language, "pattern.doubleBottom");
    case "head_and_shoulders":
      return copy(language, "pattern.headShoulders");
    case "inverse_head_and_shoulders":
      return copy(language, "pattern.inverseHeadShoulders");
  }
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
  level: number | ((index: number) => number),
  direction: "up" | "down",
  atr: number,
): { breakIndex?: number } {
  const tolerance = Math.max(atr * BREAK_BUFFER_ATR, Number.EPSILON);
  for (let index = Math.max(0, fromIndex + 1); index < candles.length; index += 1) {
    const close = candles[index]!.close;
    const line = typeof level === "function" ? level(index) : level;
    if (!Number.isFinite(line)) {
      continue;
    }
    if (direction === "up" && close > line + tolerance) {
      return { breakIndex: index };
    }
    if (direction === "down" && close < line - tolerance) {
      return { breakIndex: index };
    }
  }
  return {};
}

function classifyHeadShoulders(candles: Candle[]): NamedExtreme | null {
  if (candles.length < 15) {
    return null;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return null;
  }
  const swings = swingsWithIndex(candles);
  const regular = scanHead(candles, swings, atr, false);
  const inverse = scanHead(candles, swings, atr, true);
  if (regular && inverse) {
    return regular.rightIndex >= inverse.rightIndex ? regular.named : inverse.named;
  }
  return regular?.named ?? inverse?.named ?? null;
}

function scanHead(
  candles: readonly Candle[],
  swings: readonly (Swing & { index: number })[],
  atr: number,
  inverse: boolean,
): { named: NamedExtreme; rightIndex: number } | null {
  const peakKind = inverse ? "low" : "high";
  for (let end = swings.length - 1; end >= 4; end -= 1) {
    const window = swings.slice(end - 4, end + 1);
    const [leftShoulder, leftNeck, head, rightNeck, rightShoulder] = window as [
      Swing & { index: number },
      Swing & { index: number },
      Swing & { index: number },
      Swing & { index: number },
      Swing & { index: number },
    ];
    if (
      leftShoulder.type !== peakKind ||
      head.type !== peakKind ||
      rightShoulder.type !== peakKind ||
      leftNeck.type === peakKind ||
      rightNeck.type === peakKind
    ) {
      continue;
    }
    const sign = inverse ? -1 : 1;
    const prominence = Math.min(
      sign * (head.price - leftShoulder.price),
      sign * (head.price - rightShoulder.price),
    );
    if (prominence < MIN_HEAD_PROMINENCE_ATR * atr) {
      continue;
    }
    const necklineAt = (index: number) => {
      if (rightNeck.index === leftNeck.index) {
        return rightNeck.price;
      }
      const slope = (rightNeck.price - leftNeck.price) / (rightNeck.index - leftNeck.index);
      return leftNeck.price + slope * (index - leftNeck.index);
    };
    const headHeight = Math.abs(head.price - necklineAt(head.index));
    if (!(headHeight > 0)) {
      continue;
    }
    if (Math.abs(leftShoulder.price - rightShoulder.price) > headHeight * MAX_SHOULDER_ASYMMETRY) {
      continue;
    }
    const breakDirection = inverse ? "up" : "down";
    const completion = firstCloseBeyond(
      candles,
      rightShoulder.index,
      necklineAt,
      breakDirection,
      atr,
    );
    const invalidation = firstCloseBeyond(
      candles,
      rightShoulder.index,
      head.price,
      inverse ? "down" : "up",
      atr,
    );
    const invalidatedFirst =
      invalidation.breakIndex != null &&
      (completion.breakIndex == null || invalidation.breakIndex < completion.breakIndex);
    const completed = completion.breakIndex != null && !invalidatedFirst;
    const neckline = rightNeck.price;
    let stage: PatternStage;
    if (invalidatedFirst) {
      stage = "failed";
    } else if (completed && completion.breakIndex != null) {
      const breakLevel = necklineAt(completion.breakIndex);
      const confirmed = candles
        .slice(completion.breakIndex + 1)
        .some((candle) => Math.abs(candle.close - breakLevel) > atr * CONFIRMATION_ATR);
      stage = confirmed ? "confirmed" : "completed_unconfirmed";
    } else {
      const lastClose = candles.at(-1)?.close ?? neckline;
      const distanceAtr = Math.abs(lastClose - necklineAt(candles.length - 1)) / atr;
      const proximity = Math.max(0, Math.min(1, 1 - distanceAtr / 2));
      const ratio = Math.max(0.45, proximity * 0.9);
      stage = ratio < 0.75 ? "forming" : "near_completion";
    }
    return {
      rightIndex: rightShoulder.index,
      named: {
        kind: inverse ? "inverse_head_and_shoulders" : "head_and_shoulders",
        stage,
        neckline,
        extreme: head.price,
        inventedTarget: false,
      },
    };
  }
  return null;
}

function swingsWithIndex(candles: readonly Candle[]): (Swing & { index: number })[] {
  return detectSwings(candles)
    .map((swing) => ({
      ...swing,
      index: candles.findIndex((candle) => candle.time === swing.time),
    }))
    .filter((swing) => swing.index >= 0);
}
