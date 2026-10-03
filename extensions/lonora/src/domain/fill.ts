/**
 * Gold touch band for entries and targets. The stop stays exact.
 * A near miss is graded at the price the candle actually traded.
 */

export const GOLD_FILL_TOLERANCE_FLOOR = 10;
export const GOLD_FILL_TOLERANCE_CAP = 15;

export interface FillCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function entryFillTolerance(input: { price: number; atr?: number | null }): number {
  const price = input.price;
  if (!Number.isFinite(price) || price <= 0) {
    return 0;
  }
  const fromAtr =
    input.atr != null && Number.isFinite(input.atr) && input.atr > 0 ? input.atr * 0.15 : 0;
  if (price >= 100) {
    return Math.min(GOLD_FILL_TOLERANCE_CAP, Math.max(GOLD_FILL_TOLERANCE_FLOOR, fromAtr));
  }
  const floor = price * 1.1e-4;
  const cap = price * 3.3e-4;
  return Math.min(cap, Math.max(floor, fromAtr));
}

export function targetHitTolerance(input: { price: number; atr?: number | null }): number {
  return entryFillTolerance(input);
}

export function resolveTargetHit(input: {
  direction: "buy" | "sell";
  target: number;
  candle: { high: number; low: number };
  tolerance?: number;
}): { reached: boolean; hitPrice?: number } {
  if (!Number.isFinite(input.target)) {
    return { reached: false };
  }
  const tolerance =
    input.tolerance != null && Number.isFinite(input.tolerance) && input.tolerance > 0
      ? input.tolerance
      : 0;
  const reached =
    input.direction === "buy"
      ? input.candle.high >= input.target - tolerance
      : input.candle.low <= input.target + tolerance;
  if (!reached) {
    return { reached: false };
  }
  return {
    reached: true,
    hitPrice: Math.min(input.candle.high, Math.max(input.candle.low, input.target)),
  };
}

export function resolveFill(input: {
  plan: {
    direction: "buy" | "sell";
    entryType: "market" | "limit_touch" | "confirmation_close";
    entry: number;
  };
  candle: FillCandle;
  conditionMet: boolean;
  armedBefore: boolean;
  tolerance?: number;
}): { filled: boolean; effectiveEntry?: number } {
  const { plan, candle, conditionMet, armedBefore } = input;
  if (!conditionMet && !armedBefore) {
    return { filled: false };
  }
  if (plan.entryType === "market") {
    return { filled: true, effectiveEntry: plan.entry };
  }
  if (plan.entryType === "confirmation_close") {
    if (armedBefore) {
      return { filled: false };
    }
    return { filled: true, effectiveEntry: candle.close };
  }
  const tolerance =
    input.tolerance != null && Number.isFinite(input.tolerance) && input.tolerance > 0
      ? input.tolerance
      : 0;
  const bandLow = plan.entry - tolerance;
  const bandHigh = plan.entry + tolerance;
  if (!(candle.low <= bandHigh && candle.high >= bandLow)) {
    return { filled: false };
  }
  return {
    filled: true,
    effectiveEntry: Math.min(candle.high, Math.max(candle.low, plan.entry)),
  };
}
