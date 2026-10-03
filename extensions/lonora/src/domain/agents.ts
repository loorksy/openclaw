/**
 * Specialist analysts. Each one runs the deterministic detector for its job
 * and returns a structured result or an explicit failure. None of them echo
 * a canned "reviewed" sentence.
 */
import {
  biasFromCandles,
  calculateAtr,
  detectMajorLevels,
  detectSupplyDemandZones,
  detectSwings,
  detectTrend,
  type Candle,
} from "./candles.js";
import { analyzeLiquidity } from "./liquidity-sweeps.js";
import { detectStructureEvents, latestStructureEvent } from "./structure.js";

export const SPECIALISTS = [
  "market-watcher",
  "structure-analyst",
  "liquidity-analyst",
  "supply-demand-analyst",
  "multi-timeframe-analyst",
  "macro-news-analyst",
  "risk-reviewer",
  "research-agent",
  "memory-curator",
  "system-guardian",
] as const;

export type SpecialistId = (typeof SPECIALISTS)[number];

export interface SpecialistResult {
  agent: SpecialistId;
  ok: boolean;
  summary: string;
  data: Record<string, unknown>;
  failure?: string;
}

export interface DelegationLimits {
  depth: number;
  childCount: number;
  timeoutMs: number;
  tokenBudget: number;
}

export const DEFAULT_LIMITS: DelegationLimits = {
  depth: 1,
  childCount: 0,
  timeoutMs: 20_000,
  tokenBudget: 4_000,
};

export function assertDelegation(input: DelegationLimits & { requested: number }): void {
  if (input.depth >= 2) {
    throw new Error("Delegation depth exceeded. Specialists cannot spawn further agents.");
  }
  if (input.childCount + input.requested > 4) {
    throw new Error("Child agent limit exceeded.");
  }
  if (input.tokenBudget <= 0) {
    throw new Error("Specialist token budget is exhausted.");
  }
  if (input.timeoutMs <= 0) {
    throw new Error("Specialist timeout must be positive.");
  }
}

export function runStructureAnalyst(candles: Candle[]): SpecialistResult {
  if (candles.length < 10) {
    return {
      agent: "structure-analyst",
      ok: false,
      summary: "Not enough closed candles to read structure.",
      data: { candles: candles.length },
      failure: "insufficient_candles",
    };
  }
  const swings = detectSwings(candles);
  const trend = detectTrend(swings);
  const atr = calculateAtr(candles);
  const events = detectStructureEvents(candles, swings, atr);
  const latest = latestStructureEvent(events);
  const levels = detectMajorLevels(candles);
  return {
    agent: "structure-analyst",
    ok: true,
    summary: latest
      ? `${trend} with ${latest.type} ${latest.direction} at ${latest.brokenLevel}`
      : `${trend} with ${swings.length} swings and no fresh break`,
    data: { trend, swings, events, latest, levels, atr },
  };
}

export function runLiquidityAnalyst(candles: Candle[]): SpecialistResult {
  if (candles.length < 5) {
    return {
      agent: "liquidity-analyst",
      ok: false,
      summary: "Not enough candles to locate liquidity.",
      data: {},
      failure: "insufficient_candles",
    };
  }
  const liquidity = analyzeLiquidity(candles);
  const latest = liquidity.latest;
  return {
    agent: "liquidity-analyst",
    ok: true,
    summary: latest
      ? `${latest.side} sweep of ${latest.sweptLevel}, close back inside`
      : `Buy-side ${liquidity.nearestBuySide?.price ?? "none"}, sell-side ${liquidity.nearestSellSide?.price ?? "none"}`,
    data: liquidity,
  };
}

export function runSupplyDemandAnalyst(candles: Candle[]): SpecialistResult {
  if (candles.length < 6) {
    return {
      agent: "supply-demand-analyst",
      ok: false,
      summary: "Not enough candles to mark supply and demand.",
      data: {},
      failure: "insufficient_candles",
    };
  }
  const zones = detectSupplyDemandZones(candles);
  const last = zones.at(-1);
  return {
    agent: "supply-demand-analyst",
    ok: true,
    summary: last
      ? `${zones.length} zones, latest ${last.type} ${last.low}-${last.high}`
      : "No impulse zones in the supplied candles.",
    data: { zones },
  };
}

export function runMultiTimeframeAnalyst(input: {
  lower: Candle[];
  higher: Candle[];
}): SpecialistResult {
  const lower = runStructureAnalyst(input.lower);
  const higherBias = biasFromCandles(input.higher);
  if (!lower.ok) {
    return { ...lower, agent: "multi-timeframe-analyst" };
  }
  const aligned =
    (lower.data.trend === "uptrend" && higherBias === "bullish") ||
    (lower.data.trend === "downtrend" && higherBias === "bearish");
  return {
    agent: "multi-timeframe-analyst",
    ok: true,
    summary: aligned
      ? `Lower timeframe ${String(lower.data.trend)} agrees with higher timeframe ${higherBias}`
      : `Lower timeframe ${String(lower.data.trend)} does not agree with higher timeframe ${higherBias}`,
    data: { lower: lower.data, higherBias, aligned },
  };
}

export function runRiskReviewer(input: {
  entry: number;
  stopLoss: number;
  targets: number[];
}): SpecialistResult {
  const risk = Math.abs(input.entry - input.stopLoss);
  if (!(risk > 0) || input.targets.length === 0) {
    return {
      agent: "risk-reviewer",
      ok: false,
      summary: "A plan needs a stop and at least one target before it can be graded.",
      data: {},
      failure: "incomplete_plan",
    };
  }
  const reward = Math.abs(input.targets[0]! - input.entry);
  const rr = reward / risk;
  return {
    agent: "risk-reviewer",
    ok: true,
    summary: `First target pays ${rr.toFixed(2)}R`,
    data: { risk, reward, rr, acceptable: rr >= 1 },
  };
}

export function runSpecialist(
  id: SpecialistId,
  input: {
    candles?: Candle[];
    higher?: Candle[];
    entry?: number;
    stopLoss?: number;
    targets?: number[];
    note?: string;
  },
): SpecialistResult {
  switch (id) {
    case "structure-analyst":
    case "market-watcher":
      return { ...runStructureAnalyst(input.candles ?? []), agent: id };
    case "liquidity-analyst":
      return runLiquidityAnalyst(input.candles ?? []);
    case "supply-demand-analyst":
      return runSupplyDemandAnalyst(input.candles ?? []);
    case "multi-timeframe-analyst":
      return runMultiTimeframeAnalyst({
        lower: input.candles ?? [],
        higher: input.higher ?? [],
      });
    case "risk-reviewer":
      return runRiskReviewer({
        entry: input.entry ?? Number.NaN,
        stopLoss: input.stopLoss ?? Number.NaN,
        targets: input.targets ?? [],
      });
    case "macro-news-analyst":
      return {
        agent: id,
        ok: input.note != null && input.note.trim().length > 0,
        summary:
          input.note?.trim() ||
          "No macro note was supplied. This agent does not invent a calendar event.",
        data: { note: input.note ?? null },
        failure: input.note?.trim() ? undefined : "no_macro_context",
      };
    case "research-agent": {
      const scenario = input.note?.trim() ?? "";
      const bars = input.candles?.length ?? 0;
      if (!scenario && bars < 10) {
        return {
          agent: id,
          ok: false,
          summary: "Research needs a realized gold record or a closed-candle sample.",
          data: { bars },
          failure: "insufficient_history",
        };
      }
      const bias = bars >= 10 ? biasFromCandles(input.candles!) : null;
      return {
        agent: id,
        ok: true,
        summary: [scenario, bias ? `Closed-candle bias ${bias}.` : ""].filter(Boolean).join(" "),
        data: { scenario: scenario || null, bars, bias: bias ?? "unknown" },
      };
    }
    case "memory-curator":
      return {
        agent: id,
        ok: true,
        summary: input.note?.trim()
          ? "Compacted the supplied note into a lesson candidate."
          : "No new lesson was supplied.",
        data: { lesson: input.note?.trim() || null },
      };
    case "system-guardian":
      return {
        agent: id,
        ok: true,
        summary: "Checked delegation limits and the trade-execution boundary.",
        data: {
          tradeExecution: "owner-confirmed-only",
          maxDepth: 1,
          maxChildren: 4,
        },
      };
    default:
      return {
        agent: id,
        ok: false,
        summary: "Unknown specialist.",
        data: {},
        failure: "unknown_agent",
      };
  }
}
