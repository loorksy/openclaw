/**
 * Prepare one XAUUSD recommendation from closed candles.
 * The stop sits beyond the zone by the volatility buffer. Targets are structural
 * levels only. A path toward a pending zone is not a trade the other way,
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
import { analyzeLiquidity } from "./liquidity-sweeps.js";
import type { OwnerLanguage } from "./owner.js";
import type { RecommendationPlan } from "./recommendations.js";
import { rangeSpan, scoreZone, type ZoneScore } from "./score-poi.js";
import { detectStructureEvents } from "./structure.js";

const INTERVAL = "1h";

export interface PreparedPlan {
  ok: true;
  plan: RecommendationPlan;
  invented: false;
  brokerCalled: false;
}

export interface RejectedPlan {
  ok: false;
  reason:
    | "insufficient_candles"
    | "no_zone"
    | "zone_weak"
    | "no_structural_target"
    | "invalid_geometry"
    | "path_broken";
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
  const zone = selectZone(visible, last.close, atr);
  if (zone == null) {
    return rejected(
      detectSupplyDemandZones(visible).length === 0 ? "no_zone" : "zone_weak",
      language,
    );
  }
  const action = zone.zone.type === "demand" ? "buy" : "sell";
  const inside = last.close >= zone.zone.low && last.close <= zone.zone.high;
  const entry = roundToTick(
    inside ? last.close : action === "buy" ? zone.zone.high : zone.zone.low,
  );
  const structuralStop = action === "buy" ? zone.zone.low : zone.zone.high;
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
  const targets = selectStructuralTargets({
    action,
    entry,
    atr,
    levels: structuralLevels(visible),
  });
  if (targets.length === 0) {
    return rejected("no_structural_target", language);
  }
  const path = inside
    ? null
    : analyzePathToEntry({
        action,
        currentPrice: last.close,
        entry,
        atr,
        zoneLow: zone.zone.low,
        zoneHigh: zone.zone.high,
      });
  if (path?.class === "invalidated_before_activation") {
    return rejected("path_broken", language);
  }
  const pathLine =
    path?.class === "unlikely_reach"
      ? `${copy(language, "plan.pathUnlikely")} `
      : path?.class === "neutral_path"
        ? `${copy(language, "plan.pathNeutral")} `
        : "";
  const plan: RecommendationPlan = {
    id: randomUUID(),
    symbol: "XAUUSD",
    direction: action,
    entryType: inside ? "market" : "limit_touch",
    entry,
    stopLoss: placed.stop,
    targets,
    status: "pending_entry",
    outcome: "pending",
    createdCandleTime: last.time,
    createdAt: now,
    rationale: `${stopRationale(language, placed.structuralStop, placed.stop, placed.widened)} ${copy(language, "plan.grade")} ${zone.score.grade}. ${pathLine}${copy(language, "plan.targets")} ${targets.join(", ")}.`,
  };
  return { ok: true, plan, invented: false, brokerCalled: false };
}

function selectZone(
  candles: Candle[],
  price: number,
  atr: number,
): { zone: SupplyDemandZone; score: ZoneScore } | null {
  const bias = biasFromCandles(candles);
  const preferred = bias === "bullish" ? "demand" : bias === "bearish" ? "supply" : null;
  const zones = detectSupplyDemandZones(candles);
  const typed = preferred ? zones.filter((zone) => zone.type === preferred) : zones;
  const pool = typed.length > 0 ? typed : zones;
  const usable = pool.filter((zone) =>
    zone.type === "demand" ? price >= zone.low : price <= zone.high,
  );
  const swings = detectSwings(candles);
  const levels = detectMajorLevels(candles);
  const context = {
    candles,
    currentPrice: price,
    atr,
    structureEvents: detectStructureEvents(candles, swings, atr),
    sweeps: analyzeLiquidity(candles).sweeps,
    range: rangeSpan(candles),
    htfLevels: [...levels.support, ...levels.resistance].map((level) => level.price),
    otherZones: zones,
  };
  const ranked = usable
    .map((zone) => ({ zone, score: scoreZone({ ...context, zone }) }))
    .filter((item) => item.score.tradable)
    .sort(
      (left, right) => right.score.score - left.score.score || right.zone.time - left.zone.time,
    );
  return ranked[0] ?? null;
}

export function selectStructuralTargets(input: {
  action: "buy" | "sell";
  entry: number;
  atr: number;
  levels: number[];
}): number[] {
  const span = tradeSpanFor(INTERVAL);
  const floor1 = input.atr * span.minTp1Atr;
  const floor2 = input.atr * span.minTp2Atr;
  const unique = [...new Set(input.levels.map((level) => roundToTick(level)))]
    .filter((level) => (input.action === "buy" ? level > input.entry : level < input.entry))
    .sort((left, right) => (input.action === "buy" ? left - right : right - left));
  const distance = (level: number) => Math.abs(level - input.entry);
  const tp1 = unique.find((level) => distance(level) + 1e-9 >= floor1) ?? null;
  if (tp1 == null) {
    return [];
  }
  const beyond = (level: number, previous: number) =>
    input.action === "buy" ? level > previous : level < previous;
  const tp2 =
    unique.find((level) => beyond(level, tp1) && distance(level) + 1e-9 >= floor2) ?? null;
  const tp3 = tp2 == null ? null : (unique.find((level) => beyond(level, tp2)) ?? null);
  const picked = [tp1, tp2, tp3].filter((level): level is number => level != null);
  const distinct: number[] = [];
  for (const level of picked) {
    const previous = distinct.at(-1);
    if (previous != null && Math.abs(level - previous) < Math.max(input.atr * 0.25, 0.05)) {
      continue;
    }
    distinct.push(level);
  }
  return distinct;
}

/** A pending zone is not a trade back toward it. Distance alone never justifies one. */
export function analyzePathToEntry(input: {
  action: "buy" | "sell";
  currentPrice: number;
  entry: number;
  atr: number;
  zoneLow: number;
  zoneHigh: number;
}): {
  class: "invalidated_before_activation" | "unlikely_reach" | "neutral_path";
  transitionalTrade: false;
} {
  const broken =
    input.action === "buy"
      ? input.currentPrice < input.zoneLow - input.atr * 0.25
      : input.currentPrice > input.zoneHigh + input.atr * 0.25;
  if (broken) {
    return { class: "invalidated_before_activation", transitionalTrade: false };
  }
  const distance = Math.abs(input.entry - input.currentPrice);
  const drifting =
    input.action === "buy"
      ? input.currentPrice > input.entry + input.atr * 0.75
      : input.currentPrice < input.entry - input.atr * 0.75;
  if (drifting && distance > input.atr * 1.5) {
    return { class: "unlikely_reach", transitionalTrade: false };
  }
  return { class: "neutral_path", transitionalTrade: false };
}

function structuralLevels(candles: Candle[]): number[] {
  const levels = detectMajorLevels(candles);
  return [
    ...detectSwings(candles).map((swing) => swing.price),
    ...levels.support.map((level) => level.price),
    ...levels.resistance.map((level) => level.price),
  ];
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
        : reason === "zone_weak"
          ? "plan.zoneWeak"
          : reason === "no_structural_target"
            ? "plan.noTarget"
            : reason === "path_broken"
              ? "plan.pathBroken"
              : "plan.invalid";
  return { ok: false, reason, message: copy(language, key), invented: false, brokerCalled: false };
}
