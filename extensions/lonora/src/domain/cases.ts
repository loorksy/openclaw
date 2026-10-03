/**
 * Historical gold cases. The fingerprint uses candles at or before the moment.
 * The outcome uses only later candles. A small sample does not become a rate.
 */
import type { Candle } from "./candles.js";
import { copy } from "./copy.js";
import { sessionOf } from "./market.js";
import type { OwnerLanguage } from "./owner.js";

export const CASE_LOOKBACK = 60;
export const CASE_FORWARD = 40;
export const CASE_STRIDE = 4;
export const MIN_CASE_SIMILARITY = 0.82;
export const MIN_CASE_SAMPLE = 8;

export type CaseRegime = "trend" | "range" | "volatile";
export type CaseTrend = "up" | "down" | "flat";
export type CaseRangeZone = "near_low" | "discount" | "mid" | "premium" | "near_high";
export type CaseResolution = "target_first" | "stop_first" | "unresolved";

export interface CaseFingerprint {
  regime: CaseRegime;
  trend: CaseTrend;
  rangeZone: CaseRangeZone;
  pullbackDepth: number;
  impulseAtr: number;
  volatility: number;
  session: "asia" | "london" | "newyork";
  structureRun: number;
}

export interface ForwardOutcome {
  resolution: CaseResolution;
  bars: number;
  maxFavourableAtr: number;
  maxAdverseAtr: number;
  netR: number;
}

export interface HistoricalCase {
  caseTime: number;
  direction: "buy" | "sell";
  fingerprint: CaseFingerprint;
  outcome: ForwardOutcome;
}

const WEIGHTS = [1.0, 1.4, 1.0, 0.8, 0.8, 0.7, 0.4, 0.6];

export function fingerprintVector(fingerprint: CaseFingerprint): number[] {
  const regime = { trend: 1, range: 0, volatile: 0.5 }[fingerprint.regime];
  const trend = { up: 1, down: -1, flat: 0 }[fingerprint.trend];
  const zone = { near_low: 0, discount: 0.25, mid: 0.5, premium: 0.75, near_high: 1 }[
    fingerprint.rangeZone
  ];
  const session = { asia: 0, london: 0.5, newyork: 1 }[fingerprint.session];
  return [
    regime,
    trend,
    zone,
    Math.max(0, Math.min(1, fingerprint.pullbackDepth)),
    Math.max(0, Math.min(1, fingerprint.impulseAtr / 5)),
    Math.max(0, Math.min(1, fingerprint.volatility * 200)),
    session,
    Math.max(0, Math.min(1, fingerprint.structureRun / 6)),
  ];
}

export function fingerprintSimilarity(left: CaseFingerprint, right: CaseFingerprint): number {
  const a = fingerprintVector(left);
  const b = fingerprintVector(right);
  let weighted = 0;
  let total = 0;
  for (let index = 0; index < a.length; index += 1) {
    const weight = WEIGHTS[index] ?? 1;
    weighted += weight * Math.abs(a[index]! - b[index]!);
    total += weight;
  }
  return Math.max(0, 1 - weighted / total);
}

export function fingerprintAt(candles: readonly Candle[]): CaseFingerprint | null {
  if (candles.length < 30) {
    return null;
  }
  const last = candles.at(-1)!;
  const atr = atrOf(candles);
  if (!(atr > 0) || !(last.close > 0)) {
    return null;
  }
  const window = candles.slice(-60);
  const highs = window.map((candle) => candle.high);
  const lows = window.map((candle) => candle.low);
  const rangeHigh = Math.max(...highs);
  const rangeLow = Math.min(...lows);
  const span = Math.max(rangeHigh - rangeLow, Number.EPSILON);
  const position = (last.close - rangeLow) / span;
  const rangeZone: CaseRangeZone =
    position >= 0.95
      ? "near_high"
      : position >= 0.62
        ? "premium"
        : position <= 0.05
          ? "near_low"
          : position <= 0.38
            ? "discount"
            : "mid";
  const netMove = last.close - window[0]!.close;
  const trend: CaseTrend = netMove > atr * 1.5 ? "up" : netMove < -atr * 1.5 ? "down" : "flat";
  const rangeAtr = span / atr;
  const recentAtr = atrOf(candles.slice(-15), 14);
  const volatilityRatio = atr > 0 ? recentAtr / atr : 1;
  const regime: CaseRegime =
    volatilityRatio > 1.5 ? "volatile" : rangeAtr > 6 && trend !== "flat" ? "trend" : "range";
  const extremeIndex = trend === "down" ? lows.indexOf(rangeLow) : highs.indexOf(rangeHigh);
  const impulseStart = window[Math.max(0, extremeIndex - 10)]!.close;
  const impulseEnd = trend === "down" ? rangeLow : rangeHigh;
  const impulse = Math.abs(impulseEnd - impulseStart);
  const retraced = Math.abs(last.close - impulseEnd);
  const pullbackDepth = impulse > 0 ? Math.min(1, retraced / impulse) : 0;
  let structureRun = 0;
  for (let index = window.length - 1; index > 0; index -= 1) {
    const current = window[index]!;
    const previous = window[index - 1]!;
    const extendsRun = trend === "down" ? current.low < previous.low : current.high > previous.high;
    if (!extendsRun) {
      break;
    }
    structureRun += 1;
  }
  return {
    regime,
    trend,
    rangeZone,
    pullbackDepth: Number(pullbackDepth.toFixed(3)),
    impulseAtr: Number((impulse / atr).toFixed(2)),
    volatility: Number((atr / last.close).toFixed(5)),
    session: sessionOf(last.time),
    structureRun,
  };
}

export function resolveForwardOutcome(input: {
  direction: "buy" | "sell";
  entry: number;
  atr: number;
  future: readonly Candle[];
  horizon?: number;
}): ForwardOutcome {
  const horizon = Math.min(input.horizon ?? CASE_FORWARD, input.future.length);
  const long = input.direction === "buy";
  const stop = long ? input.entry - input.atr : input.entry + input.atr;
  const target = long ? input.entry + input.atr * 2 : input.entry - input.atr * 2;
  let maxFavourable = 0;
  let maxAdverse = 0;
  for (let index = 0; index < horizon; index += 1) {
    const bar = input.future[index]!;
    maxFavourable = Math.max(maxFavourable, long ? bar.high - input.entry : input.entry - bar.low);
    maxAdverse = Math.max(maxAdverse, long ? input.entry - bar.low : bar.high - input.entry);
    const hitStop = long ? bar.low <= stop : bar.high >= stop;
    const hitTarget = long ? bar.high >= target : bar.low <= target;
    if (hitStop) {
      return {
        resolution: "stop_first",
        bars: index + 1,
        maxFavourableAtr: round(maxFavourable / input.atr),
        maxAdverseAtr: round(maxAdverse / input.atr),
        netR: -1,
      };
    }
    if (hitTarget) {
      return {
        resolution: "target_first",
        bars: index + 1,
        maxFavourableAtr: round(maxFavourable / input.atr),
        maxAdverseAtr: round(maxAdverse / input.atr),
        netR: 2,
      };
    }
  }
  return {
    resolution: "unresolved",
    bars: horizon,
    maxFavourableAtr: round(maxFavourable / input.atr),
    maxAdverseAtr: round(maxAdverse / input.atr),
    netR: 0,
  };
}

/** Index moments that still have a full forward window. The last bars stay unindexed. */
export function indexCandleCases(candles: readonly Candle[]): HistoricalCase[] {
  if (candles.length < CASE_LOOKBACK + CASE_FORWARD + 1) {
    return [];
  }
  const cases: HistoricalCase[] = [];
  for (let index = CASE_LOOKBACK - 1; index < candles.length - CASE_FORWARD; index += CASE_STRIDE) {
    const past = candles.slice(index - CASE_LOOKBACK + 1, index + 1);
    const future = candles.slice(index + 1, index + 1 + CASE_FORWARD);
    if (future[0]!.time <= past.at(-1)!.time) {
      continue;
    }
    const fingerprint = fingerprintAt(past);
    const entry = past.at(-1)!.close;
    const atr = fingerprint ? fingerprint.volatility * entry : 0;
    if (!fingerprint || !(atr > 0)) {
      continue;
    }
    for (const direction of ["buy", "sell"] as const) {
      cases.push({
        caseTime: past.at(-1)!.time,
        direction,
        fingerprint,
        outcome: resolveForwardOutcome({ direction, entry, atr, future }),
      });
    }
  }
  return cases;
}

export function findSimilarCases(
  candles: readonly Candle[],
  cases: readonly HistoricalCase[],
  language: OwnerLanguage = "en",
): {
  matches: number;
  resolved: number;
  winRate: number | null;
  text: string;
} {
  const query = fingerprintAt(candles.slice(-CASE_LOOKBACK));
  const latest = candles.at(-1)?.time ?? 0;
  if (!query || !(latest > 0)) {
    return { matches: 0, resolved: 0, winRate: null, text: copy(language, "cases.insufficient") };
  }
  const matches = cases.filter(
    (item) =>
      item.caseTime < latest &&
      fingerprintSimilarity(query, item.fingerprint) >= MIN_CASE_SIMILARITY,
  );
  const resolved = matches.filter((item) => item.outcome.resolution !== "unresolved");
  if (matches.length === 0) {
    return { matches: 0, resolved: 0, winRate: null, text: copy(language, "cases.none") };
  }
  const buy = directionSample(matches, "buy");
  const sell = directionSample(matches, "sell");
  const rated = [buy, sell].filter((side) => side.resolved >= MIN_CASE_SAMPLE);
  if (rated.length === 0) {
    return {
      matches: matches.length,
      resolved: resolved.length,
      winRate: null,
      text: `${copy(language, "cases.counts")} ${matches.length}/${resolved.length}.`,
    };
  }
  const single = rated.length === 1 && buy.matches + sell.matches === rated[0]!.matches;
  return {
    matches: matches.length,
    resolved: resolved.length,
    winRate: single ? rated[0]!.wins / rated[0]!.resolved : null,
    text: `${copy(language, "cases.rate")}: ${[buy, sell]
      .filter((side) => side.matches > 0)
      .map((side) => directionSentence(language, side))
      .join(" ")}`,
  };
}

function directionSample(matches: readonly HistoricalCase[], direction: "buy" | "sell") {
  const rows = matches.filter((item) => item.direction === direction);
  const resolved = rows.filter((item) => item.outcome.resolution !== "unresolved");
  const wins = resolved.filter((item) => item.outcome.resolution === "target_first").length;
  return { direction, matches: rows.length, resolved: resolved.length, wins };
}

function directionSentence(
  language: OwnerLanguage,
  side: { direction: "buy" | "sell"; matches: number; resolved: number; wins: number },
): string {
  const label = copy(language, side.direction === "buy" ? "label.buy" : "label.sell");
  if (side.resolved >= MIN_CASE_SAMPLE) {
    return `${label} ${side.resolved}, ${Math.round((side.wins / side.resolved) * 100)}%.`;
  }
  return `${label} ${side.matches}/${side.resolved}.`;
}

function atrOf(candles: readonly Candle[], period = 14): number {
  const window = candles.slice(-period - 1);
  if (window.length < 2) {
    return 0;
  }
  let sum = 0;
  for (let index = 1; index < window.length; index += 1) {
    const previous = window[index - 1]!;
    const current = window[index]!;
    sum += Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    );
  }
  return sum / (window.length - 1);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
