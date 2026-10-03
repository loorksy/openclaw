/**
 * Zone quality for a gold plan. A nearby zone is not tradable by itself.
 * Grades match Boty: A above 85, B from 75, C from 60, otherwise reject.
 * Only A and B may become a recommendation.
 */
import type { Candle, SupplyDemandZone } from "./candles.js";
import type { LiquiditySweep } from "./liquidity-sweeps.js";
import type { StructureEvent } from "./structure.js";

export interface ZoneScore {
  score: number;
  grade: "A" | "B" | "C" | "reject";
  reasons: string[];
  warnings: string[];
  tradable: boolean;
}

export interface RangeSpan {
  rangeHigh: number;
  rangeLow: number;
}

export function scoreZone(input: {
  zone: SupplyDemandZone;
  candles: Candle[];
  currentPrice: number;
  atr: number | null;
  structureEvents: StructureEvent[];
  sweeps: LiquiditySweep[];
  range: RangeSpan | null;
  htfLevels: number[];
  otherZones: SupplyDemandZone[];
}): ZoneScore {
  const { zone, candles, currentPrice } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const atr = input.atr && input.atr > 0 ? input.atr : approximateRange(candles);
  if (!atr || candles.length === 0 || !(currentPrice > 0)) {
    return { score: 0, grade: "reject", reasons: ["insufficient"], warnings, tradable: false };
  }
  const mid = (zone.low + zone.high) / 2;
  const width = zone.high - zone.low;
  let score = 20;

  const touches = countTouchesAfterFormation(zone, candles);
  if (touches === 0) {
    score += 20;
    reasons.push("fresh");
  } else if (touches === 1) {
    score += 10;
    reasons.push("tested_once");
  } else if (touches >= 3) {
    score -= 20;
    warnings.push("spent");
  }

  const impulse = impulseAwayAtr(zone, candles, atr);
  if (impulse >= 2) {
    score += 20;
    reasons.push("impulse_strong");
  } else if (impulse >= 1) {
    score += 10;
  } else {
    warnings.push("impulse_weak");
  }

  const levelTolerance = Math.max(atr * 0.75, mid * 0.0008);
  if (input.htfLevels.some((level) => Math.abs(level - mid) <= levelTolerance)) {
    score += 15;
    reasons.push("htf");
  }

  const sweepTolerance = Math.max(atr, width);
  if (
    input.sweeps.some(
      (sweep) =>
        Math.abs(sweep.sweptLevel - mid) <= sweepTolerance * 2 &&
        (zone.type === "demand" ? sweep.side === "sell_side" : sweep.side === "buy_side"),
    )
  ) {
    score += 10;
    reasons.push("sweep");
  }

  if (
    input.structureEvents.some(
      (event) =>
        event.breakCandleTime >= zone.time &&
        (zone.type === "demand" ? event.direction === "bullish" : event.direction === "bearish"),
    )
  ) {
    score += 15;
    reasons.push("structure");
  }

  const widthAtr = width / atr;
  if (widthAtr > 3) {
    score -= 15;
    warnings.push("wide");
  } else if (widthAtr < 0.1) {
    score -= 10;
    warnings.push("narrow");
  }

  const distanceAtr = Math.abs(currentPrice - mid) / atr;
  if (distanceAtr > 10) {
    score -= 20;
    warnings.push("far");
  } else if (distanceAtr <= 4) {
    score += 5;
    reasons.push("near");
  }

  if (input.range) {
    const span = Math.max(input.range.rangeHigh - input.range.rangeLow, 1e-9);
    const zonePct = clamp01((mid - input.range.rangeLow) / span);
    if (zone.type === "demand" && zonePct <= 0.45) {
      score += 10;
      reasons.push("discount");
    } else if (zone.type === "supply" && zonePct >= 0.55) {
      score += 10;
      reasons.push("premium");
    } else if (
      (zone.type === "demand" && zonePct >= 0.62) ||
      (zone.type === "supply" && zonePct <= 0.38)
    ) {
      score -= 15;
      warnings.push("range_mismatch");
    }
  }

  const crowdTolerance = Math.max(atr * 0.5, width);
  if (
    input.otherZones.some((other) => {
      if (other === zone || other.type !== zone.type) {
        return false;
      }
      const otherMid = (other.low + other.high) / 2;
      return Math.abs(otherMid - mid) <= crowdTolerance;
    })
  ) {
    score -= 10;
    warnings.push("crowded");
  }

  score = Math.max(0, Math.min(100, score));
  const grade = score > 85 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : "reject";
  return { score, grade, reasons, warnings, tradable: grade === "A" || grade === "B" };
}

export function rangeSpan(candles: Candle[]): RangeSpan | null {
  if (candles.length < 20) {
    return null;
  }
  const window = candles.slice(-120);
  let rangeHigh = Number.NEGATIVE_INFINITY;
  let rangeLow = Number.POSITIVE_INFINITY;
  for (const candle of window) {
    rangeHigh = Math.max(rangeHigh, candle.high);
    rangeLow = Math.min(rangeLow, candle.low);
  }
  if (!(rangeHigh > rangeLow)) {
    return null;
  }
  return { rangeHigh, rangeLow };
}

function countTouchesAfterFormation(zone: SupplyDemandZone, candles: Candle[]): number {
  let touches = 0;
  let inTouch = false;
  for (const candle of candles) {
    if (candle.time <= zone.time) {
      continue;
    }
    const touching = candle.low <= zone.high && candle.high >= zone.low;
    if (touching && !inTouch) {
      touches += 1;
    }
    inTouch = touching;
  }
  return touches;
}

function impulseAwayAtr(zone: SupplyDemandZone, candles: Candle[], atr: number): number {
  const after = candles.filter(
    (candle) => candle.time > zone.time && candle.time <= zone.time + 7 * 24 * 60 * 60_000,
  );
  const window = after.slice(0, 12);
  let extreme = 0;
  for (const candle of window) {
    extreme =
      zone.type === "demand"
        ? Math.max(extreme, candle.high - zone.high)
        : Math.max(extreme, zone.low - candle.low);
  }
  return Math.max(0, extreme) / atr;
}

function approximateRange(candles: Candle[]): number | null {
  const window = candles.slice(-14);
  const ranges = window.map((candle) => candle.high - candle.low).filter((value) => value > 0);
  if (ranges.length === 0) {
    return null;
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
