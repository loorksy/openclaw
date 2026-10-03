/**
 * Deterministic recommendation lifecycle. No model calls and no order routing.
 * The creation candle never fills or stops a plan. Same-candle stop and target
 * resolve stop-first until a target was already banked.
 */

export type RecommendationStatus =
  | "pending_entry"
  | "triggered"
  | "tp1_hit"
  | "tp2_hit"
  | "tp3_hit"
  | "sl_hit"
  | "invalidated"
  | "expired"
  | "cancelled";

export type RecommendationOutcome =
  | "pending"
  | "win_tp1"
  | "win_tp2"
  | "win_tp3"
  | "loss"
  | "expired"
  | "cancelled"
  | "invalidated";

export type Direction = "buy" | "sell";
export type EntryType = "market" | "limit_touch" | "confirmation_close";
export type InvalidationMode = "touch" | "close";

export interface RecommendationPlan {
  id: string;
  symbol: string;
  direction: Direction;
  entryType: EntryType;
  entry: number;
  effectiveEntry?: number;
  stopLoss: number;
  targets: number[];
  invalidationMode?: InvalidationMode;
  status: RecommendationStatus;
  outcome: RecommendationOutcome;
  createdCandleTime: number;
  createdAt: number;
  triggeredAt?: number;
  tp1HitAt?: number;
  tp2HitAt?: number;
  tp3HitAt?: number;
  rationale?: string;
  confidence?: number;
}

export interface TrackerCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Evaluation {
  status: RecommendationStatus;
  outcome: RecommendationOutcome;
  triggered: boolean;
  ambiguous: boolean;
  effectiveEntry?: number;
  triggeredAt?: number;
  tp1HitAt?: number;
  tp2HitAt?: number;
  tp3HitAt?: number;
  slHitAt?: number;
  missedWithoutFill?: boolean;
  changed: boolean;
}

const WIN_BY_TP: Record<1 | 2 | 3, RecommendationOutcome> = {
  1: "win_tp1",
  2: "win_tp2",
  3: "win_tp3",
};
const STATUS_BY_TP: Record<1 | 2 | 3, RecommendationStatus> = {
  1: "tp1_hit",
  2: "tp2_hit",
  3: "tp3_hit",
};

export function isTerminal(outcome: RecommendationOutcome): boolean {
  return outcome !== "pending";
}

function targetHit(direction: Direction, candle: TrackerCandle, target: number): boolean {
  return direction === "buy" ? candle.high >= target : candle.low <= target;
}

function stopHit(
  direction: Direction,
  candle: TrackerCandle,
  stop: number,
  mode: InvalidationMode,
): boolean {
  if (mode === "close") {
    return direction === "buy" ? candle.close <= stop : candle.close >= stop;
  }
  return direction === "buy" ? candle.low <= stop : candle.high >= stop;
}

function filled(
  plan: RecommendationPlan,
  candle: TrackerCandle,
): { filled: boolean; price?: number } {
  if (plan.entryType === "market") {
    return { filled: true, price: plan.effectiveEntry ?? plan.entry };
  }
  if (plan.entryType === "limit_touch") {
    const touched =
      plan.direction === "buy" ? candle.low <= plan.entry : candle.high >= plan.entry;
    return touched ? { filled: true, price: plan.entry } : { filled: false };
  }
  const confirmed =
    plan.direction === "buy" ? candle.close >= plan.entry : candle.close <= plan.entry;
  return confirmed ? { filled: true, price: candle.close } : { filled: false };
}

export function evaluateRecommendation(
  plan: RecommendationPlan,
  candles: TrackerCandle[],
): Evaluation {
  const base: Evaluation = {
    status: plan.status,
    outcome: plan.outcome,
    triggered: Boolean(plan.triggeredAt) || plan.entryType === "market",
    ambiguous: false,
    effectiveEntry: plan.effectiveEntry,
    triggeredAt: plan.triggeredAt,
    tp1HitAt: plan.tp1HitAt,
    tp2HitAt: plan.tp2HitAt,
    tp3HitAt: plan.tp3HitAt,
    changed: false,
  };
  if (isTerminal(plan.outcome)) {
    return base;
  }
  const mode = plan.invalidationMode ?? (plan.entryType === "market" ? "touch" : "close");
  const targets = plan.targets.slice(0, 3);
  const future = candles
    .filter((candle) => candle.time > plan.createdCandleTime)
    .sort((left, right) => left.time - right.time);
  let triggered = base.triggered;
  let effectiveEntry = plan.effectiveEntry ?? plan.entry;
  let triggeredAt = plan.triggeredAt ?? (plan.entryType === "market" ? plan.createdAt : undefined);
  let highest: 0 | 1 | 2 | 3 =
    (plan.tp3HitAt && 3) || (plan.tp2HitAt && 2) || (plan.tp1HitAt && 1) || 0;
  const tpAt: Record<1 | 2 | 3, number | undefined> = {
    1: plan.tp1HitAt,
    2: plan.tp2HitAt,
    3: plan.tp3HitAt,
  };
  let slHitAt: number | undefined;
  let ambiguous = false;
  let missedWithoutFill = false;

  const finish = (
    status: RecommendationStatus,
    outcome: RecommendationOutcome,
  ): Evaluation => ({
    status,
    outcome,
    triggered,
    ambiguous,
    effectiveEntry: triggered ? effectiveEntry : undefined,
    triggeredAt,
    tp1HitAt: tpAt[1],
    tp2HitAt: tpAt[2],
    tp3HitAt: tpAt[3],
    slHitAt,
    missedWithoutFill: missedWithoutFill || undefined,
    changed: true,
  });

  for (const candle of future) {
    if (!triggered) {
      if (targets[0] != null && targetHit(plan.direction, candle, targets[0])) {
        missedWithoutFill = true;
        return finish("expired", "expired");
      }
      const fill = filled(plan, candle);
      if (!fill.filled) {
        continue;
      }
      triggered = true;
      triggeredAt = candle.time;
      effectiveEntry = fill.price ?? plan.entry;
    }
    const stopped = stopHit(plan.direction, candle, plan.stopLoss, mode);
    let reachedNow = 0;
    for (let index = highest; index < targets.length; index += 1) {
      const target = targets[index];
      if (target == null || !targetHit(plan.direction, candle, target)) {
        break;
      }
      reachedNow = index + 1;
    }
    if (stopped && reachedNow > 0 && highest === 0) {
      ambiguous = true;
      slHitAt = candle.time;
      return finish("sl_hit", "loss");
    }
    if (reachedNow > highest) {
      for (let level = highest + 1; level <= reachedNow; level += 1) {
        tpAt[level as 1 | 2 | 3] = candle.time;
      }
      highest = reachedNow as 1 | 2 | 3;
    }
    if (stopped) {
      slHitAt = candle.time;
      if (highest === 1 || highest === 2 || highest === 3) {
        return finish(STATUS_BY_TP[highest], WIN_BY_TP[highest]);
      }
      return finish("sl_hit", "loss");
    }
    if (highest === 3) {
      return finish("tp3_hit", "win_tp3");
    }
  }
  if (!triggered) {
    return {
      ...base,
      status: "pending_entry",
      missedWithoutFill: missedWithoutFill || undefined,
      changed: plan.status !== "pending_entry",
    };
  }
  const status = highest === 0 ? "triggered" : STATUS_BY_TP[highest];
  return {
    status,
    outcome: "pending",
    triggered: true,
    ambiguous,
    effectiveEntry,
    triggeredAt,
    tp1HitAt: tpAt[1],
    tp2HitAt: tpAt[2],
    tp3HitAt: tpAt[3],
    changed: status !== plan.status || effectiveEntry !== plan.effectiveEntry,
  };
}
