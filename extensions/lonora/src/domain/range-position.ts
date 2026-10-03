/**
 * Where the last closed price sits inside the recent high-low range.
 * Premium and discount describe location. They do not invent a price or a trade.
 */
import type { Candle } from "./candles.js";
import { copy, type CopyKey } from "./copy.js";
import type { OwnerLanguage } from "./owner.js";

export type RangeLabel = "premium" | "discount" | "mid_range" | "near_high" | "near_low";

export interface DealingRange {
  high: number;
  low: number;
  positionPct: number;
  label: RangeLabel;
  invented: false;
}

const LOOKBACK = 120;
const MIN_BARS = 20;

export function computeRangePosition(
  candles: readonly Candle[],
  price: number | null,
): DealingRange | null {
  if (price == null || !Number.isFinite(price)) {
    return null;
  }
  const window = candles.slice(-LOOKBACK);
  if (window.length < MIN_BARS) {
    return null;
  }
  let high = Number.NEGATIVE_INFINITY;
  let low = Number.POSITIVE_INFINITY;
  for (const candle of window) {
    if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) {
      return null;
    }
    if (candle.high > high) {
      high = candle.high;
    }
    if (candle.low < low) {
      low = candle.low;
    }
  }
  const span = high - low;
  if (!(span > 0)) {
    return null;
  }
  const positionPct = Math.max(0, Math.min(1, (price - low) / span));
  return { high, low, positionPct, label: labelFor(positionPct), invented: false };
}

/** Location can delay an entry. It does not remove the direction. */
export function positionDisfavorsEntry(label: RangeLabel, action: "buy" | "sell"): boolean {
  if (label === "mid_range") {
    return true;
  }
  if (action === "buy") {
    return label === "premium" || label === "near_high";
  }
  return label === "discount" || label === "near_low";
}

export function describeRange(language: OwnerLanguage, range: DealingRange): string {
  return `${copy(language, rangeKey(range.label))} ${range.low}–${range.high}`;
}

function labelFor(position: number): RangeLabel {
  if (position >= 0.95) {
    return "near_high";
  }
  if (position <= 0.05) {
    return "near_low";
  }
  if (position >= 0.62) {
    return "premium";
  }
  if (position <= 0.38) {
    return "discount";
  }
  return "mid_range";
}

function rangeKey(label: RangeLabel): CopyKey {
  switch (label) {
    case "premium":
      return "range.premium";
    case "discount":
      return "range.discount";
    case "mid_range":
      return "range.mid";
    case "near_high":
      return "range.nearHigh";
    case "near_low":
      return "range.nearLow";
  }
}
