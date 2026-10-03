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
  /** A named swing extreme when the swings qualify. Never a projected target. */
  named: NamedExtreme | null;
}

export interface NamedExtreme {
  kind:
    | "double_top"
    | "double_bottom"
    | "triple_top"
    | "triple_bottom"
    | "head_and_shoulders"
    | "inverse_head_and_shoulders"
    | "ascending_triangle"
    | "descending_triangle"
    | "symmetrical_triangle"
    | "rising_wedge"
    | "falling_wedge"
    | "flag"
    | "pennant"
    | "cup_and_handle"
    | "inverse_cup_and_handle"
    | "rectangle"
    | "support"
    | "resistance"
    | "rising_channel"
    | "falling_channel"
    | "horizontal_channel";
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
const MAX_TRIPLE_GAP_ATR = 0.5;
const MIN_TRIPLE_BAR_SEPARATION = 6;
const MIN_TRIPLE_HEIGHT_ATR = 0.6;
const MIN_HEAD_PROMINENCE_ATR = 1.2;
const MAX_SHOULDER_ASYMMETRY = 0.25;
const MIN_TRIANGLE_BARS = 40;
const BOUNDARY_CONFORM_ATR = 0.35;
const FLAT_SLOPE_ATR_PER_BAR = 0.05;
const MAX_END_WIDTH_RATIO = 0.8;
const APEX_CONSUMED_LIMIT = 0.8;
const IMPULSE_MIN_ATR = 2.5;
const IMPULSE_MIN_BARS = 5;
const IMPULSE_MAX_BARS = 10;
const CONSOLIDATION_MIN_BARS = 3;
const CONSOLIDATION_MAX_BARS = 20;
const CONSOLIDATION_MAX_RANGE_ATR = 1.6;
const MAX_RETRACE_RATIO = 0.6;
const PENNANT_NARROWING_RATIO = 0.6;
const MAX_FLAG_STALENESS_BARS = 10;
const RIM_TOLERANCE_ATR = 0.6;
const MIN_CUP_DEPTH_ATR = 1.5;
const MAX_CUP_DEPTH_ATR = 12;
const MAX_HANDLE_RETRACE = 0.5;
const RECTANGLE_TOLERANCE_ATR = 0.35;
const MIN_RECTANGLE_HEIGHT_ATR = 1.2;
const MIN_RECTANGLE_SPAN = 12;
const MIN_TREND_SEPARATION = 8;
const MIN_TREND_SCORE = 60;
const MIN_TREND_TOUCHES = 2;
const TREND_TOUCH_ATR = 0.15;
const MIN_TREND_TOUCH_GAP = 3;
const TREND_ENVELOPE_ATR = 0.25;
const MAX_TREND_ANCHOR_AGE = 100;
const MAX_TREND_LINES = 2;
const TREND_COLLINEAR_ATR = 0.5;
const CHANNEL_TOUCH_ATR = 0.15;
const MIN_CHANNEL_WIDTH_ATR = 1;
const MAX_CHANNEL_WIDTH_ATR = 8;
const MIN_CHANNEL_TOUCHES = 2;
const HORIZONTAL_CHANNEL_SLOPE = 0.03;

export function classifySwingRange(candles: Candle[]): SwingRangePattern {
  return {
    ...classifyRange(candles),
    named:
      classifyHeadShoulders(candles) ??
      classifyCup(candles) ??
      classifyTriangle(candles) ??
      classifyTripleExtreme(candles) ??
      classifyRectangle(candles) ??
      classifyDoubleExtreme(candles) ??
      classifyFlag(candles) ??
      classifyTrendline(candles),
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
    case "triple_top":
      return copy(language, "pattern.tripleTop");
    case "triple_bottom":
      return copy(language, "pattern.tripleBottom");
    case "head_and_shoulders":
      return copy(language, "pattern.headShoulders");
    case "inverse_head_and_shoulders":
      return copy(language, "pattern.inverseHeadShoulders");
    case "ascending_triangle":
      return copy(language, "pattern.ascending");
    case "descending_triangle":
      return copy(language, "pattern.descending");
    case "symmetrical_triangle":
      return copy(language, "pattern.symmetrical");
    case "rising_wedge":
      return copy(language, "pattern.risingWedge");
    case "falling_wedge":
      return copy(language, "pattern.fallingWedge");
    case "flag":
      return copy(language, "pattern.flag");
    case "pennant":
      return copy(language, "pattern.pennant");
    case "cup_and_handle":
      return copy(language, "pattern.cup");
    case "inverse_cup_and_handle":
      return copy(language, "pattern.inverseCup");
    case "rectangle":
      return copy(language, "pattern.rectangle");
    case "support":
      return copy(language, "pattern.support");
    case "resistance":
      return copy(language, "pattern.resistance");
    case "rising_channel":
      return copy(language, "pattern.risingChannel");
    case "falling_channel":
      return copy(language, "pattern.fallingChannel");
    case "horizontal_channel":
      return copy(language, "pattern.horizontalChannel");
  }
}

function classifyTripleExtreme(candles: Candle[]): NamedExtreme | null {
  if (candles.length < 15) {
    return null;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return null;
  }
  const swings = swingsWithIndex(candles);
  const top = scanTriple(candles, swings, atr, "top");
  const bottom = scanTriple(candles, swings, atr, "bottom");
  if (top && bottom) {
    return top.thirdIndex >= bottom.thirdIndex ? top.named : bottom.named;
  }
  return top?.named ?? bottom?.named ?? null;
}

function scanTriple(
  candles: readonly Candle[],
  swings: readonly (Swing & { index: number })[],
  atr: number,
  variant: "top" | "bottom",
): { named: NamedExtreme; thirdIndex: number } | null {
  const extremeKind = variant === "top" ? "high" : "low";
  for (let end = swings.length - 1; end >= 4; end -= 1) {
    const third = swings[end]!;
    const counter2 = swings[end - 1]!;
    const second = swings[end - 2]!;
    const counter1 = swings[end - 3]!;
    const first = swings[end - 4]!;
    if (
      first.type !== extremeKind ||
      second.type !== extremeKind ||
      third.type !== extremeKind ||
      counter1.type === extremeKind ||
      counter2.type === extremeKind
    ) {
      continue;
    }
    if (second.index - first.index < MIN_TRIPLE_BAR_SEPARATION) {
      continue;
    }
    if (third.index - second.index < MIN_TRIPLE_BAR_SEPARATION) {
      continue;
    }
    const prices = [first.price, second.price, third.price];
    const extreme = variant === "top" ? Math.max(...prices) : Math.min(...prices);
    const spread = Math.max(...prices) - Math.min(...prices);
    if (spread > MAX_TRIPLE_GAP_ATR * atr) {
      continue;
    }
    // Farther pullback. The shallower one must not complete the pattern.
    const neckline =
      variant === "top"
        ? Math.min(counter1.price, counter2.price)
        : Math.max(counter1.price, counter2.price);
    if (!(Math.abs(extreme - neckline) > atr * MIN_TRIPLE_HEIGHT_ATR)) {
      continue;
    }
    const breakDirection = variant === "top" ? "down" : "up";
    const completion = firstCloseBeyond(candles, third.index, neckline, breakDirection, atr);
    const invalidation = firstCloseBeyond(
      candles,
      third.index,
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
      thirdIndex: third.index,
      named: {
        kind: variant === "top" ? "triple_top" : "triple_bottom",
        stage,
        neckline,
        extreme,
        inventedTarget: false,
      },
    };
  }
  return null;
}

function classifyRectangle(candles: Candle[]): NamedExtreme | null {
  if (candles.length < 15) {
    return null;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return null;
  }
  const recent = swingsWithIndex(candles).slice(-8);
  const highs = recent.filter((swing) => swing.type === "high");
  const lows = recent.filter((swing) => swing.type === "low");
  if (highs.length < 2 || lows.length < 2) {
    return null;
  }
  const top = median(highs.map((swing) => swing.price));
  const bottom = median(lows.map((swing) => swing.price));
  const height = top - bottom;
  if (!(height >= MIN_RECTANGLE_HEIGHT_ATR * atr)) {
    return null;
  }
  const tolerance = RECTANGLE_TOLERANCE_ATR * atr;
  if (highs.some((swing) => Math.abs(swing.price - top) > tolerance)) {
    return null;
  }
  if (lows.some((swing) => Math.abs(swing.price - bottom) > tolerance)) {
    return null;
  }
  const anchors = [...recent].sort((left, right) => left.index - right.index);
  const first = anchors[0];
  const last = anchors.at(-1);
  if (!first || !last || last.index - first.index < MIN_RECTANGLE_SPAN) {
    return null;
  }
  const up = firstCloseBeyond(candles, last.index, top, "up", atr);
  const down = firstCloseBeyond(candles, last.index, bottom, "down", atr);
  const failed = up.breakIndex != null && down.breakIndex != null;
  const brokeUp =
    up.breakIndex != null && (down.breakIndex == null || up.breakIndex <= down.breakIndex);
  const breakIndex = failed
    ? Math.min(
        up.breakIndex ?? Number.POSITIVE_INFINITY,
        down.breakIndex ?? Number.POSITIVE_INFINITY,
      )
    : (up.breakIndex ?? down.breakIndex);
  const neckline = breakIndex == null ? top : brokeUp ? top : bottom;
  const extreme = neckline === top ? bottom : top;
  let stage: PatternStage;
  if (failed) {
    stage = "failed";
  } else if (breakIndex != null) {
    const confirmed = candles
      .slice(breakIndex + 1)
      .some((candle) => Math.abs(candle.close - neckline) > atr * CONFIRMATION_ATR);
    stage = confirmed ? "confirmed" : "completed_unconfirmed";
  } else {
    const lastClose = candles.at(-1)?.close;
    const distanceAtr =
      lastClose == null
        ? 2
        : Math.min(Math.abs(lastClose - top), Math.abs(lastClose - bottom)) / atr;
    const proximity = Math.max(0, Math.min(1, 1 - distanceAtr / 2));
    const ratio = Math.max(0.45, proximity * 0.9);
    stage = ratio < 0.75 ? "forming" : "near_completion";
  }
  return {
    kind: "rectangle",
    stage,
    neckline,
    extreme,
    inventedTarget: false,
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  const lower = sorted[mid - 1];
  const upper = sorted[mid];
  if (upper == null) {
    return 0;
  }
  return sorted.length % 2 === 1 || lower == null ? upper : (lower + upper) / 2;
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

function classifyTriangle(candles: Candle[]): NamedExtreme | null {
  if (candles.length < MIN_TRIANGLE_BARS) {
    return null;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return null;
  }
  const swings = swingsWithIndex(candles);
  const upper = fitBoundary(
    swings.filter((swing) => swing.type === "high"),
    atr,
  );
  const lower = fitBoundary(
    swings.filter((swing) => swing.type === "low"),
    atr,
  );
  if (!upper || !lower) {
    return null;
  }
  const upperAt = (index: number) => lineAt(upper.first, upper.last, index);
  const lowerAt = (index: number) => lineAt(lower.first, lower.last, index);
  const startIndex = Math.max(upper.first.index, lower.first.index);
  const endIndex = Math.max(upper.last.index, lower.last.index);
  const startWidth = upperAt(startIndex) - lowerAt(startIndex);
  const endWidth = upperAt(endIndex) - lowerAt(endIndex);
  if (!(startWidth > 0) || !(endWidth > 0)) {
    return null;
  }
  const converging = endWidth <= startWidth * MAX_END_WIDTH_RATIO;
  const upperClass = slopeClass(upper.slope, atr);
  const lowerClass = slopeClass(lower.slope, atr);
  const shape = triangleKind(upperClass, lowerClass, converging);
  if (!shape) {
    return null;
  }
  const shrinkPerBar = (startWidth - endWidth) / Math.max(1, endIndex - startIndex);
  const barsToApex = shrinkPerBar > 0 ? startWidth / shrinkPerBar : Number.POSITIVE_INFINITY;
  const consumed = (candles.length - 1 - startIndex) / barsToApex;
  const expired = consumed > APEX_CONSUMED_LIMIT;
  const upBreak = firstCloseBeyond(candles, endIndex, upperAt, "up", atr);
  const downBreak = firstCloseBeyond(candles, endIndex, lowerAt, "down", atr);
  const first =
    upBreak.breakIndex != null && downBreak.breakIndex != null
      ? upBreak.breakIndex <= downBreak.breakIndex
        ? { index: upBreak.breakIndex, direction: "up" as const }
        : { index: downBreak.breakIndex, direction: "down" as const }
      : upBreak.breakIndex != null
        ? { index: upBreak.breakIndex, direction: "up" as const }
        : downBreak.breakIndex != null
          ? { index: downBreak.breakIndex, direction: "down" as const }
          : null;
  const completes =
    first != null && (shape.either || first.direction === (shape.up ? "up" : "down"));
  const breakLevel =
    first == null ? null : first.direction === "up" ? upperAt(first.index) : lowerAt(first.index);
  return triangleStage({
    candles,
    atr,
    kind: shape.kind,
    neckline: shape.up ? upper.last.price : lower.last.price,
    extreme: shape.up ? lower.last.price : upper.last.price,
    breakIndex: completes ? first.index : null,
    breakLevel: completes ? breakLevel : null,
    failed: first == null ? expired : !completes,
  });
}

function triangleStage(input: {
  candles: readonly Candle[];
  atr: number;
  kind: NamedExtreme["kind"];
  neckline: number;
  extreme: number;
  breakIndex: number | null;
  breakLevel: number | null;
  failed: boolean;
}): NamedExtreme {
  let stage: PatternStage;
  if (input.failed) {
    stage = "failed";
  } else if (input.breakIndex != null && input.breakLevel != null) {
    const confirmed = input.candles
      .slice(input.breakIndex + 1)
      .some((candle) => Math.abs(candle.close - input.breakLevel!) > input.atr * CONFIRMATION_ATR);
    stage = confirmed ? "confirmed" : "completed_unconfirmed";
  } else {
    const lastClose = input.candles.at(-1)?.close ?? input.neckline;
    const distanceAtr = Math.abs(lastClose - input.neckline) / input.atr;
    const proximity = Math.max(0, Math.min(1, 1 - distanceAtr / 2));
    const ratio = Math.max(0.45, proximity * 0.9);
    stage = ratio < 0.75 ? "forming" : "near_completion";
  }
  return {
    kind: input.kind,
    stage,
    neckline: input.neckline,
    extreme: input.extreme,
    inventedTarget: false,
  };
}

function triangleKind(
  upper: "flat" | "rising" | "falling",
  lower: "flat" | "rising" | "falling",
  converging: boolean,
): { kind: NamedExtreme["kind"]; up: boolean; either: boolean } | null {
  if (upper === "flat" && lower === "rising") {
    return { kind: "ascending_triangle", up: true, either: false };
  }
  if (upper === "falling" && lower === "flat") {
    return { kind: "descending_triangle", up: false, either: false };
  }
  if (upper === "falling" && lower === "rising" && converging) {
    return { kind: "symmetrical_triangle", up: true, either: true };
  }
  if (upper === "rising" && lower === "rising" && converging) {
    return { kind: "rising_wedge", up: false, either: false };
  }
  if (upper === "falling" && lower === "falling" && converging) {
    return { kind: "falling_wedge", up: true, either: false };
  }
  return null;
}

function slopeClass(slope: number, atr: number): "flat" | "rising" | "falling" {
  const perBar = slope / Math.max(atr, Number.EPSILON);
  if (Math.abs(perBar) < FLAT_SLOPE_ATR_PER_BAR) {
    return "flat";
  }
  return perBar > 0 ? "rising" : "falling";
}

function fitBoundary(
  pivots: readonly (Swing & { index: number })[],
  atr: number,
): { first: Swing & { index: number }; last: Swing & { index: number }; slope: number } | null {
  const tolerance = Math.max(atr * BOUNDARY_CONFORM_ATR, Number.EPSILON);
  const maxSuffix = Math.min(pivots.length, 6);
  for (let size = maxSuffix; size >= 2; size -= 1) {
    const subset = pivots.slice(-size);
    const first = subset[0]!;
    const last = subset[subset.length - 1]!;
    if (last.index - first.index < 8) {
      continue;
    }
    const conforms = subset.every(
      (pivot) => Math.abs(pivot.price - lineAt(first, last, pivot.index)) <= tolerance,
    );
    if (!conforms) {
      continue;
    }
    return {
      first,
      last,
      slope: (last.price - first.price) / Math.max(1, last.index - first.index),
    };
  }
  return null;
}

function lineAt(
  first: Swing & { index: number },
  last: Swing & { index: number },
  index: number,
): number {
  if (last.index === first.index) {
    return last.price;
  }
  const slope = (last.price - first.price) / (last.index - first.index);
  return first.price + slope * (index - first.index);
}

function classifyFlag(candles: Candle[]): NamedExtreme | null {
  if (candles.length < IMPULSE_MIN_BARS + 8) {
    return null;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return null;
  }
  for (
    let impulseEnd = candles.length - CONSOLIDATION_MIN_BARS - 1;
    impulseEnd >= IMPULSE_MIN_BARS;
    impulseEnd -= 1
  ) {
    for (let span = IMPULSE_MIN_BARS; span <= IMPULSE_MAX_BARS; span += 1) {
      const impulseStart = impulseEnd - span;
      if (impulseStart < 0) {
        break;
      }
      const from = candles[impulseStart]!;
      const to = candles[impulseEnd]!;
      const net = to.close - from.open;
      if (Math.abs(net) < IMPULSE_MIN_ATR * atr) {
        continue;
      }
      const direction: "up" | "down" = net > 0 ? "up" : "down";
      const consolidation = buildConsolidation(candles, impulseEnd, direction, atr);
      if (!consolidation) {
        continue;
      }
      const consolidationRange = consolidation.high - consolidation.low;
      if (consolidationRange > CONSOLIDATION_MAX_RANGE_ATR * atr) {
        continue;
      }
      const retrace =
        direction === "up"
          ? (to.close - consolidation.low) / Math.abs(net)
          : (consolidation.high - to.close) / Math.abs(net);
      if (retrace > MAX_RETRACE_RATIO) {
        continue;
      }
      const lastRelevant = consolidation.resolutionIndex ?? candles.length - 1;
      if (candles.length - 1 - lastRelevant > MAX_FLAG_STALENESS_BARS) {
        continue;
      }
      const expired =
        consolidation.resolution === "open" &&
        candles.length - 1 - impulseEnd > CONSOLIDATION_MAX_BARS;
      const completed = consolidation.resolution === "breakout";
      const boundary = direction === "up" ? consolidation.high : consolidation.low;
      const opposite = direction === "up" ? consolidation.low : consolidation.high;
      return triangleStage({
        candles,
        atr,
        kind: consolidation.converging ? "pennant" : "flag",
        neckline: boundary,
        extreme: opposite,
        breakIndex: completed ? (consolidation.resolutionIndex ?? null) : null,
        breakLevel: completed ? boundary : null,
        failed: consolidation.resolution === "breakdown" || expired,
      });
    }
  }
  return null;
}

function buildConsolidation(
  candles: readonly Candle[],
  startIndex: number,
  direction: "up" | "down",
  atr: number,
): {
  endIndex: number;
  high: number;
  low: number;
  converging: boolean;
  resolution: "breakout" | "breakdown" | "open";
  resolutionIndex?: number;
} | null {
  const tolerance = Math.max(atr * BREAK_BUFFER_ATR, Number.EPSILON);
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  const ranges: number[] = [];
  let end = startIndex;
  for (
    let index = startIndex;
    index < candles.length && index <= startIndex + CONSOLIDATION_MAX_BARS;
    index += 1
  ) {
    const candle = candles[index]!;
    const bars = index - startIndex;
    if (bars >= CONSOLIDATION_MIN_BARS) {
      if (direction === "up" && candle.close > high + tolerance) {
        return finishConsolidation(index, "breakout");
      }
      if (direction === "down" && candle.close < low - tolerance) {
        return finishConsolidation(index, "breakout");
      }
      if (direction === "up" && candle.close < low - tolerance) {
        return finishConsolidation(index, "breakdown");
      }
      if (direction === "down" && candle.close > high + tolerance) {
        return finishConsolidation(index, "breakdown");
      }
    }
    high = Math.max(high, candle.high);
    low = Math.min(low, candle.low);
    ranges.push(candle.high - candle.low);
    end = index;
  }
  if (end - startIndex < CONSOLIDATION_MIN_BARS) {
    return null;
  }
  return finishConsolidation(undefined, "open");

  function finishConsolidation(
    resolutionIndex: number | undefined,
    resolution: "breakout" | "breakdown" | "open",
  ) {
    const mid = Math.floor(ranges.length / 2);
    const width = (slice: number[]) => (slice.length > 0 ? Math.max(...slice) : 0);
    const early = width(ranges.slice(0, mid));
    const late = width(ranges.slice(mid));
    return {
      endIndex: end,
      high,
      low,
      converging: early > 0 && late <= early * PENNANT_NARROWING_RATIO,
      resolution,
      resolutionIndex,
    };
  }
}

function classifyCup(candles: Candle[]): NamedExtreme | null {
  if (candles.length < 15) {
    return null;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return null;
  }
  const swings = swingsWithIndex(candles);
  const cup = scanCup(candles, swings, atr, false);
  const inverse = scanCup(candles, swings, atr, true);
  if (cup && inverse) {
    return cup.handleIndex >= inverse.handleIndex ? cup.named : inverse.named;
  }
  return cup?.named ?? inverse?.named ?? null;
}

function scanCup(
  candles: readonly Candle[],
  swings: readonly (Swing & { index: number })[],
  atr: number,
  inverse: boolean,
): { named: NamedExtreme; handleIndex: number } | null {
  const rimKind = inverse ? "low" : "high";
  for (let end = swings.length - 1; end >= 3; end -= 1) {
    const handle = swings[end]!;
    const rim2 = swings[end - 1]!;
    const base = swings[end - 2]!;
    const rim1 = swings[end - 3]!;
    if (
      rim1.type !== rimKind ||
      rim2.type !== rimKind ||
      base.type === rimKind ||
      handle.type === rimKind
    ) {
      continue;
    }
    const rimLevel = inverse ? Math.min(rim1.price, rim2.price) : Math.max(rim1.price, rim2.price);
    if (Math.abs(rim1.price - rim2.price) > RIM_TOLERANCE_ATR * atr) {
      continue;
    }
    const depth = Math.abs(rimLevel - base.price);
    if (depth < MIN_CUP_DEPTH_ATR * atr || depth > MAX_CUP_DEPTH_ATR * atr) {
      continue;
    }
    const span = rim2.index - rim1.index;
    if (span < 10) {
      continue;
    }
    const basePosition = (base.index - rim1.index) / span;
    if (basePosition < 0.3 || basePosition > 0.7) {
      continue;
    }
    const handleRetrace = Math.abs(rimLevel - handle.price) / depth;
    if (handleRetrace > MAX_HANDLE_RETRACE || handle.index - rim2.index < 3) {
      continue;
    }
    const breakDirection = inverse ? "down" : "up";
    const completion = firstCloseBeyond(candles, handle.index, rimLevel, breakDirection, atr);
    const invalidationLevel = inverse
      ? rimLevel + depth * MAX_HANDLE_RETRACE
      : rimLevel - depth * MAX_HANDLE_RETRACE;
    const invalidation = firstCloseBeyond(
      candles,
      handle.index,
      invalidationLevel,
      inverse ? "up" : "down",
      atr,
    );
    const invalidatedFirst =
      invalidation.breakIndex != null &&
      (completion.breakIndex == null || invalidation.breakIndex < completion.breakIndex);
    const completed = completion.breakIndex != null && !invalidatedFirst;
    return {
      handleIndex: handle.index,
      named: triangleStage({
        candles,
        atr,
        kind: inverse ? "inverse_cup_and_handle" : "cup_and_handle",
        neckline: rimLevel,
        extreme: base.price,
        breakIndex: completed ? (completion.breakIndex ?? null) : null,
        breakLevel: completed ? rimLevel : null,
        failed: invalidatedFirst,
      }),
    };
  }
  return null;
}

function classifyTrendline(candles: Candle[]): NamedExtreme | null {
  if (candles.length < 15) {
    return null;
  }
  const atr = calculateAtr(candles);
  if (atr == null || !(atr > 0)) {
    return null;
  }
  const swings = swingsWithIndex(candles);
  const support = acceptedTrendlines(candles, swings, atr, "low");
  const resistance = acceptedTrendlines(candles, swings, atr, "high");
  const channel = strongestChannel(candles, [...support, ...resistance], swings, atr);
  if (channel) {
    return channel;
  }
  const line = [...support, ...resistance].sort(compareTrendlines)[0];
  if (!line) {
    return null;
  }
  const last = candles.length - 1;
  const price = linePrice(line.anchors[0], line.anchors[1], last);
  return {
    kind: line.side,
    stage: "forming",
    neckline: price,
    extreme: price,
    inventedTarget: false,
  };
}

interface TrendAnchor {
  index: number;
  price: number;
}

interface TrendLine {
  side: "support" | "resistance";
  anchors: [TrendAnchor, TrendAnchor];
  slope: number;
  touches: number;
  confidence: number;
}

function acceptedTrendlines(
  candles: readonly Candle[],
  swings: readonly (Swing & { index: number })[],
  atr: number,
  side: "low" | "high",
): TrendLine[] {
  const pivots = swings.filter((swing) => swing.type === side);
  const candidates = pivots.flatMap((first, index) =>
    pivots.slice(index + 1).flatMap((second) => {
      const line = scoreTrendline(candles, pivots, first, second, side, atr);
      return line ? [line] : [];
    }),
  );
  candidates.sort(compareTrendlines);
  const accepted: TrendLine[] = [];
  for (const candidate of candidates) {
    if (accepted.length >= MAX_TREND_LINES) {
      break;
    }
    if (accepted.every((line) => distinctTrendline(candidate, line, atr))) {
      accepted.push(candidate);
    }
  }
  return accepted;
}

function scoreTrendline(
  candles: readonly Candle[],
  pivots: readonly (Swing & { index: number })[],
  first: Swing & { index: number },
  second: Swing & { index: number },
  side: "low" | "high",
  atr: number,
): TrendLine | null {
  const separation = second.index - first.index;
  if (separation < MIN_TREND_SEPARATION) {
    return null;
  }
  const lastIndex = candles.length - 1;
  const anchorAge = lastIndex - second.index;
  if (anchorAge > MAX_TREND_ANCHOR_AGE) {
    return null;
  }
  const anchors: [TrendAnchor, TrendAnchor] = [
    { index: first.index, price: first.price },
    { index: second.index, price: second.price },
  ];
  if (closesThroughLine(candles, anchors, side, atr)) {
    return null;
  }
  const touches = countLineTouches(pivots, anchors, atr);
  if (touches < MIN_TREND_TOUCHES) {
    return null;
  }
  let score = 40 + Math.min(30, touches * 10);
  score += Math.min(15, Math.round((15 * separation) / Math.max(1, lastIndex)));
  score += Math.max(0, 15 - Math.round((15 * anchorAge) / MAX_TREND_ANCHOR_AGE));
  if (score < MIN_TREND_SCORE) {
    return null;
  }
  return {
    side: side === "low" ? "support" : "resistance",
    anchors,
    slope: (second.price - first.price) / Math.max(1, separation),
    touches,
    confidence: Math.max(0, Math.min(100, Math.round(score))),
  };
}

function closesThroughLine(
  candles: readonly Candle[],
  anchors: readonly [TrendAnchor, TrendAnchor],
  side: "low" | "high",
  atr: number,
): boolean {
  const tolerance = Math.max(atr * TREND_ENVELOPE_ATR, Number.EPSILON);
  for (let index = anchors[0].index; index < candles.length; index += 1) {
    const expected = linePrice(anchors[0], anchors[1], index);
    const close = candles[index]!.close;
    if (side === "low" && close < expected - tolerance) {
      return true;
    }
    if (side === "high" && close > expected + tolerance) {
      return true;
    }
  }
  return false;
}

function countLineTouches(
  pivots: readonly (Swing & { index: number })[],
  anchors: readonly [TrendAnchor, TrendAnchor],
  atr: number,
): number {
  const tolerance = Math.max(atr * TREND_TOUCH_ATR, Number.EPSILON);
  let touches = 0;
  let lastCounted = Number.NEGATIVE_INFINITY;
  for (const pivot of pivots) {
    if (pivot.index < anchors[0].index) {
      continue;
    }
    const expected = linePrice(anchors[0], anchors[1], pivot.index);
    if (Math.abs(pivot.price - expected) > tolerance) {
      continue;
    }
    if (pivot.index - lastCounted < MIN_TREND_TOUCH_GAP) {
      continue;
    }
    touches += 1;
    lastCounted = pivot.index;
  }
  return touches;
}

function distinctTrendline(candidate: TrendLine, accepted: TrendLine, atr: number): boolean {
  const tolerance = Math.max(atr * TREND_COLLINEAR_ATR, Number.EPSILON);
  const [first, second] = accepted.anchors;
  const deviation = Math.max(
    ...candidate.anchors.map((anchor) =>
      Math.abs(anchor.price - linePrice(first, second, anchor.index)),
    ),
  );
  return deviation > tolerance;
}

function compareTrendlines(left: TrendLine, right: TrendLine): number {
  return (
    right.touches - left.touches ||
    right.confidence - left.confidence ||
    right.anchors[1].index - left.anchors[1].index ||
    left.anchors[0].index - right.anchors[0].index
  );
}

function strongestChannel(
  candles: readonly Candle[],
  lines: readonly TrendLine[],
  swings: readonly (Swing & { index: number })[],
  atr: number,
): NamedExtreme | null {
  let best: { named: NamedExtreme; confidence: number } | null = null;
  for (const base of lines) {
    const channel = channelFromLine(candles, base, swings, atr);
    if (!channel) {
      continue;
    }
    if (!best || channel.confidence > best.confidence) {
      best = channel;
    }
  }
  return best?.named ?? null;
}

function channelFromLine(
  candles: readonly Candle[],
  base: TrendLine,
  swings: readonly (Swing & { index: number })[],
  atr: number,
): { named: NamedExtreme; confidence: number } | null {
  const oppositeKind = base.side === "support" ? "high" : "low";
  const [first, second] = base.anchors;
  const opposite = swings.filter(
    (swing) =>
      swing.type === oppositeKind && swing.index >= first.index && swing.index <= second.index,
  );
  if (opposite.length < MIN_CHANNEL_TOUCHES) {
    return null;
  }
  const offsets = opposite.map((swing) => swing.price - linePrice(first, second, swing.index));
  const boundary = offsets.reduce((best, offset) =>
    base.side === "support" ? Math.max(best, offset) : Math.min(best, offset),
  );
  const widthAtr = Math.abs(boundary) / atr;
  if (widthAtr < MIN_CHANNEL_WIDTH_ATR || widthAtr > MAX_CHANNEL_WIDTH_ATR) {
    return null;
  }
  const tolerance = Math.max(atr * CHANNEL_TOUCH_ATR, Number.EPSILON);
  const touching = offsets.filter((offset) => Math.abs(offset - boundary) <= tolerance);
  if (touching.length < MIN_CHANNEL_TOUCHES) {
    return null;
  }
  const last = candles.length - 1;
  const neckline = linePrice(first, second, last);
  const slopeAtr = base.slope / atr;
  const kind: NamedExtreme["kind"] =
    Math.abs(slopeAtr) < HORIZONTAL_CHANNEL_SLOPE
      ? "horizontal_channel"
      : base.slope > 0
        ? "rising_channel"
        : "falling_channel";
  return {
    confidence: base.confidence * 0.6 + touching.length * 10 + Math.min(10, widthAtr * 2),
    named: {
      kind,
      stage: "forming",
      neckline,
      extreme: neckline + boundary,
      inventedTarget: false,
    },
  };
}

function linePrice(first: TrendAnchor, second: TrendAnchor, index: number): number {
  if (second.index === first.index) {
    return first.price;
  }
  const progress = (index - first.index) / (second.index - first.index);
  return first.price + progress * (second.price - first.price);
}

function swingsWithIndex(candles: readonly Candle[]): (Swing & { index: number })[] {
  return detectSwings(candles)
    .map((swing) => ({
      ...swing,
      index: candles.findIndex((candle) => candle.time === swing.time),
    }))
    .filter((swing) => swing.index >= 0);
}
