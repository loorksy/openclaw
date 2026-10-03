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
  kind:
    | "double_top"
    | "double_bottom"
    | "head_and_shoulders"
    | "inverse_head_and_shoulders"
    | "ascending_triangle"
    | "descending_triangle"
    | "symmetrical_triangle"
    | "rising_wedge"
    | "falling_wedge";
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
const MIN_TRIANGLE_BARS = 40;
const BOUNDARY_CONFORM_ATR = 0.35;
const FLAT_SLOPE_ATR_PER_BAR = 0.05;
const MAX_END_WIDTH_RATIO = 0.8;
const APEX_CONSUMED_LIMIT = 0.8;

export function classifySwingRange(candles: Candle[]): SwingRangePattern {
  return {
    ...classifyRange(candles),
    named:
      classifyHeadShoulders(candles) ?? classifyTriangle(candles) ?? classifyDoubleExtreme(candles),
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

function swingsWithIndex(candles: readonly Candle[]): (Swing & { index: number })[] {
  return detectSwings(candles)
    .map((swing) => ({
      ...swing,
      index: candles.findIndex((candle) => candle.time === swing.time),
    }))
    .filter((swing) => swing.index >= 0);
}
