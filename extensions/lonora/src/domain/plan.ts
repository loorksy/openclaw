/**
 * Prepare one XAUUSD recommendation from closed candles.
 * The stop sits beyond the zone by the volatility buffer. No target is invented,
 * and nothing here places an order.
 */
import { randomUUID } from "node:crypto";
import {
  biasFromCandles,
  calculateAtr,
  detectMajorLevels,
  detectSupplyDemandZones,
  detectSwings,
  isSaneCandle,
  type Candle,
  type SupplyDemandZone,
} from "./candles.js";
import { copy } from "./copy.js";
import { placeProtectedStop, roundToTick, tradeSpanFor } from "./geometry.js";
import type { OwnerLanguage } from "./owner.js";
import type { RecommendationPlan } from "./recommendations.js";

const INTERVAL = "1h";

export interface PreparedPlan {
  ok: true;
  plan: RecommendationPlan;
  invented: false;
  brokerCalled: false;
}

export interface RejectedPlan {
  ok: false;
  reason: "insufficient_candles" | "no_zone" | "no_structural_target" | "invalid_geometry";
  message: string;
  invented: false;
  brokerCalled: false;
}

export function prepareGoldPlan(
  candles: Candle[],
  language: OwnerLanguage = "en",
  now = Date.now(),
): PreparedPlan | RejectedPlan {
  const visible = candles.filter((candle) => isSaneCandle(candle));
  const atr = calculateAtr(visible);
  const last = visible.at(-1);
  if (!last || atr == null) {
    return rejected("insufficient_candles", language);
  }
  const zone = selectZone(visible, last.close);
  if (!zone) {
    return rejected("no_zone", language);
  }
  const action = zone.type === "demand" ? "buy" : "sell";
  const inside = last.close >= zone.low && last.close <= zone.high;
  const entry = roundToTick(inside ? last.close : action === "buy" ? zone.high : zone.low);
  const structuralStop = action === "buy" ? zone.low : zone.high;
  const placed = placeProtectedStop({
    action,
    entry,
    structuralStop,
    atr,
    interval: INTERVAL,
  });
  if (!placed || !(Math.abs(entry - placed.stop) > 0)) {
    return rejected("invalid_geometry", language);
  }
  const target = selectTarget(visible, action, entry, atr);
  if (target == null) {
    return rejected("no_structural_target", language);
  }
  const plan: RecommendationPlan = {
    id: randomUUID(),
    symbol: "XAUUSD",
    direction: action,
    entryType: inside ? "market" : "limit_touch",
    entry,
    stopLoss: placed.stop,
    targets: [target],
    status: "pending_entry",
    outcome: "pending",
    createdCandleTime: last.time,
    createdAt: now,
    rationale: stopRationale(language, placed.structuralStop, placed.stop, placed.widened),
  };
  return { ok: true, plan, invented: false, brokerCalled: false };
}

function selectZone(candles: Candle[], price: number): SupplyDemandZone | null {
  const bias = biasFromCandles(candles);
  const preferred = bias === "bullish" ? "demand" : bias === "bearish" ? "supply" : null;
  const zones = detectSupplyDemandZones(candles);
  const typed = preferred ? zones.filter((zone) => zone.type === preferred) : zones;
  const pool = typed.length > 0 ? typed : zones;
  const usable = pool.filter((zone) =>
    zone.type === "demand" ? price >= zone.low : price <= zone.high,
  );
  return usable.at(-1) ?? null;
}

function selectTarget(
  candles: Candle[],
  action: "buy" | "sell",
  entry: number,
  atr: number,
): number | null {
  const span = tradeSpanFor(INTERVAL);
  const minimum = atr * span.minTp1Atr;
  const levels = detectMajorLevels(candles);
  const pool = [
    ...detectSwings(candles).map((swing) => swing.price),
    ...levels.support.map((level) => level.price),
    ...levels.resistance.map((level) => level.price),
  ];
  const ranked = [...new Set(pool.map((level) => roundToTick(level)))]
    .filter((level) => (action === "buy" ? level > entry : level < entry))
    .filter((level) => Math.abs(level - entry) + 1e-9 >= minimum)
    .sort((left, right) => Math.abs(left - entry) - Math.abs(right - entry));
  return ranked[0] ?? null;
}

function stopRationale(
  language: OwnerLanguage,
  structuralStop: number,
  stop: number,
  widened: boolean,
): string {
  const base = `${copy(language, "plan.stopBeyond")} ${structuralStop} → ${stop}.`;
  return widened ? `${base} ${copy(language, "plan.widened")}` : base;
}

function rejected(reason: RejectedPlan["reason"], language: OwnerLanguage): RejectedPlan {
  const key =
    reason === "insufficient_candles"
      ? "plan.insufficient"
      : reason === "no_zone"
        ? "plan.noZone"
        : reason === "no_structural_target"
          ? "plan.noTarget"
          : "plan.invalid";
  return { ok: false, reason, message: copy(language, key), invented: false, brokerCalled: false };
}
