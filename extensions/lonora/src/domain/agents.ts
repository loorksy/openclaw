import { describeCalendarEvents, type EconomicEvent } from "./calendar.js";
/**
 * Specialist analysts. Each one runs the deterministic detector for its job
 * and returns a structured result or an explicit failure. None of them echo
 * a canned "reviewed" sentence.
 */
import {
  biasFromCandles,
  calculateAtr,
  detectMajorLevels,
  detectSwings,
  detectTrend,
  type Candle,
} from "./candles.js";
import { describeCandleShape, latestCandleShape } from "./candlesticks.js";
import { copy } from "./copy.js";
import { describeHeadlines, type NewsHeadline } from "./headlines.js";
import { describeRestingLiquidity, restingLiquidity } from "./liquidity-sweeps.js";
import { priorGoldDay } from "./market.js";
import type { OwnerLanguage } from "./owner.js";
import { classifySwingRange, describePattern } from "./patterns.js";
import { describeNearestZones, nearestGoldZones } from "./plan.js";
import { computeRangePosition, describeRange } from "./range-position.js";
import {
  describeStructureBreak,
  describeTrend,
  detectStructureEvents,
  latestStructureEvent,
} from "./structure.js";

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

export const MAX_CHILD_RUNS = 4;

export interface GuardianFacts {
  childCount: number;
  maxChildren: number;
  modelTradeBlocked: boolean;
  ownerBrokerCalled: boolean;
  codingBlocked: boolean;
}

export function assertDelegation(input: DelegationLimits & { requested: number }): void {
  if (input.depth >= 2) {
    throw new Error("Delegation depth exceeded. Specialists cannot spawn further agents.");
  }
  if (input.childCount + input.requested > MAX_CHILD_RUNS) {
    throw new Error("Child agent limit exceeded.");
  }
  if (input.tokenBudget <= 0) {
    throw new Error("Specialist token budget is exhausted.");
  }
  if (input.timeoutMs <= 0) {
    throw new Error("Specialist timeout must be positive.");
  }
}

export function runStructureAnalyst(
  candles: Candle[],
  language: OwnerLanguage = "en",
): SpecialistResult {
  if (candles.length < 10) {
    return {
      agent: "structure-analyst",
      ok: false,
      summary: copy(language, "structure.short"),
      data: { candles: candles.length },
      failure: "insufficient_candles",
    };
  }
  const swings = detectSwings(candles);
  const trend = detectTrend(swings);
  const atr = calculateAtr(candles);
  const events = detectStructureEvents(candles, swings, atr);
  const latest = latestStructureEvent(events);
  const priorDay = priorGoldDay(candles);
  const levels = detectMajorLevels(
    candles,
    priorDay
      ? [
          {
            time: priorDay.highTime,
            open: priorDay.low,
            high: priorDay.high,
            low: priorDay.low,
            close: priorDay.low,
          },
        ]
      : [],
  );
  const pattern = classifySwingRange(candles);
  const patternText = describePattern(pattern, language);
  const candleShape = latestCandleShape(candles);
  const candleText = candleShape ? ` ${describeCandleShape(candleShape, language)}` : "";
  const range = computeRangePosition(candles, candles.at(-1)?.close ?? null);
  const rangeText = range ? ` ${describeRange(language, range)}.` : "";
  const priorText = priorDay
    ? ` ${copy(language, "structure.prior")} ${priorDay.low}–${priorDay.high}.`
    : "";
  return {
    agent: "structure-analyst",
    ok: true,
    summary: `${describeTrend(language, trend)}. ${describeStructureBreak(language, latest)} ${patternText}${candleText}${rangeText}${priorText}`,
    data: { trend, swings, events, latest, levels, atr, pattern, candleShape },
  };
}

export function runLiquidityAnalyst(
  candles: Candle[],
  language: OwnerLanguage = "en",
): SpecialistResult {
  if (candles.length < 5) {
    return {
      agent: "liquidity-analyst",
      ok: false,
      summary: copy(language, "liquidity.short"),
      data: {},
      failure: "insufficient_candles",
    };
  }
  const resting = restingLiquidity(candles);
  return {
    agent: "liquidity-analyst",
    ok: true,
    summary: describeRestingLiquidity(language, resting, candles.length),
    data: {
      buySide: resting.buySide,
      sellSide: resting.sellSide,
      latest: resting.sweep,
    },
  };
}

export function runSupplyDemandAnalyst(
  candles: Candle[],
  language: OwnerLanguage = "en",
): SpecialistResult {
  if (candles.length < 6) {
    return {
      agent: "supply-demand-analyst",
      ok: false,
      summary: copy(language, "zones.short"),
      data: {},
      failure: "insufficient_candles",
    };
  }
  const zones = nearestGoldZones(candles);
  return {
    agent: "supply-demand-analyst",
    ok: true,
    summary: describeNearestZones(language, zones, candles.length),
    data: { demand: zones.demand, supply: zones.supply },
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

export function describeGuardian(facts: GuardianFacts, language: OwnerLanguage): string {
  if (!facts.modelTradeBlocked || facts.ownerBrokerCalled || !facts.codingBlocked) {
    return copy(language, "guardian.failed");
  }
  return [
    `${copy(language, "guardian.runs")} ${facts.childCount}.`,
    `${copy(language, "guardian.cap")} ${facts.maxChildren}.`,
    copy(language, "guardian.tradeBlocked"),
    copy(language, "guardian.broker"),
    copy(language, "guardian.coding"),
  ].join(" ");
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
    events?: EconomicEvent[];
    calendarKnown?: boolean;
    headlines?: NewsHeadline[];
    headlinesKnown?: boolean;
    language?: OwnerLanguage;
    guardian?: GuardianFacts;
  },
): SpecialistResult {
  switch (id) {
    case "structure-analyst":
    case "market-watcher":
      return {
        ...runStructureAnalyst(input.candles ?? [], input.language ?? "en"),
        agent: id,
      };
    case "liquidity-analyst":
      return runLiquidityAnalyst(input.candles ?? [], input.language ?? "en");
    case "supply-demand-analyst":
      return runSupplyDemandAnalyst(input.candles ?? [], input.language ?? "en");
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
    case "macro-news-analyst": {
      const language = input.language ?? "en";
      const calendarKnown = input.calendarKnown === true;
      const headlinesKnown = input.headlinesKnown === true;
      if (!calendarKnown && !headlinesKnown) {
        return {
          agent: id,
          ok: false,
          summary: `${copy(language, "calendar.unavailable")} ${copy(language, "headlines.unavailable")}`,
          data: { calendarKnown: false, headlinesKnown: false },
          failure: "no_macro_context",
        };
      }
      const summary = [
        calendarKnown
          ? describeCalendarEvents(input.events ?? [], language)
          : copy(language, "calendar.unavailable"),
        headlinesKnown
          ? describeHeadlines(input.headlines ?? [], language)
          : copy(language, "headlines.unavailable"),
      ].join(" ");
      return {
        agent: id,
        ok: true,
        summary,
        data: {
          calendarKnown,
          headlinesKnown,
          count: (input.events ?? []).length,
          headlines: (input.headlines ?? []).length,
        },
      };
    }
    case "research-agent": {
      const language = input.language ?? "en";
      const report = input.note?.trim() ?? "";
      if (!report) {
        return {
          agent: id,
          ok: false,
          summary: copy(language, "cases.insufficient"),
          data: {},
          failure: "insufficient_history",
        };
      }
      return {
        agent: id,
        ok: true,
        summary: report,
        data: { report },
      };
    }
    case "memory-curator": {
      const lesson = (input.note ?? "").replace(/\s+/g, " ").trim().slice(0, 240).trim();
      const language = input.language ?? "en";
      return {
        agent: id,
        ok: true,
        summary: lesson ? lesson : copy(language, "memory.none"),
        data: { lesson: lesson || null },
      };
    }
    case "system-guardian": {
      const language = input.language ?? "en";
      const facts = input.guardian;
      if (!facts) {
        return {
          agent: id,
          ok: false,
          summary: copy(language, "guardian.unchecked"),
          data: {},
          failure: "unchecked",
        };
      }
      const intact =
        facts.modelTradeBlocked &&
        !facts.ownerBrokerCalled &&
        facts.codingBlocked &&
        facts.childCount < facts.maxChildren;
      return {
        agent: id,
        ok: intact,
        summary: describeGuardian(facts, language),
        data: { ...facts },
        ...(intact ? {} : { failure: "boundary" }),
      };
    }
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
