/**
 * Pure candle math ported from Boty's market-context detectors.
 * No I/O and no model calls. Gold is the only instrument these helpers grade.
 */

export const LONORA_SYMBOL = "XAUUSD" as const;
export const OANDA_INSTRUMENT = "XAU_USD" as const;

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export type TrendLabel = "uptrend" | "downtrend" | "range" | "unknown";
export type Bias = "bullish" | "bearish" | "neutral" | "unknown";

export interface Swing {
  type: "high" | "low";
  time: number;
  price: number;
}

export interface PriceLevel {
  price: number;
  time: number;
}

export interface SupplyDemandZone {
  type: "supply" | "demand";
  low: number;
  high: number;
  time: number;
}

export function isGoldSymbol(symbol: string): boolean {
  const normalized = symbol.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalized === "XAUUSD" || normalized === "GOLD";
}

export function isSaneCandle(candle: Candle): boolean {
  const { open, high, low, close, time } = candle;
  if (![open, high, low, close].every((value) => Number.isFinite(value) && value > 0)) {
    return false;
  }
  if (!Number.isSafeInteger(time) || time <= 0) {
    return false;
  }
  if (high < low || open > high || open < low || close > high || close < low) {
    return false;
  }
  return true;
}

export function calculateAtr(candles: Candle[]): number | null {
  if (candles.length < 15) {
    return null;
  }
  const trueRanges: number[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const current = candles[index]!;
    const previous = candles[index - 1]!;
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previous.close),
        Math.abs(current.low - previous.close),
      ),
    );
  }
  const last = trueRanges.slice(-14);
  return last.reduce((sum, value) => sum + value, 0) / last.length;
}

/** Fractal swings, two bars each side. Equal plateaus register on the first bar. */
export function detectSwings(candles: Candle[]): Swing[] {
  const swings: Swing[] = [];
  for (let index = 2; index < candles.length - 2; index += 1) {
    const candle = candles[index]!;
    const isHigh =
      candle.high > candles[index - 1]!.high &&
      candle.high > candles[index - 2]!.high &&
      candle.high >= candles[index + 1]!.high &&
      candle.high >= candles[index + 2]!.high;
    const isLow =
      candle.low < candles[index - 1]!.low &&
      candle.low < candles[index - 2]!.low &&
      candle.low <= candles[index + 1]!.low &&
      candle.low <= candles[index + 2]!.low;
    if (isHigh) {
      swings.push({ type: "high", time: candle.time, price: candle.high });
    }
    if (isLow) {
      swings.push({ type: "low", time: candle.time, price: candle.low });
    }
  }
  return swings.slice(-80);
}

export function detectTrend(swings: Swing[]): TrendLabel {
  const highs = swings.filter((swing) => swing.type === "high").slice(-3);
  const lows = swings.filter((swing) => swing.type === "low").slice(-3);
  if (highs.length < 2 || lows.length < 2) {
    return "unknown";
  }
  const higherHighs = highs.at(-1)!.price > highs[0]!.price;
  const higherLows = lows.at(-1)!.price > lows[0]!.price;
  const lowerHighs = highs.at(-1)!.price < highs[0]!.price;
  const lowerLows = lows.at(-1)!.price < lows[0]!.price;
  if (higherHighs && higherLows) {
    return "uptrend";
  }
  if (lowerHighs && lowerLows) {
    return "downtrend";
  }
  return "range";
}

export function detectMajorLevels(
  candles: Candle[],
  daily: Candle[] = [],
): { support: PriceLevel[]; resistance: PriceLevel[] } {
  const swings = detectSwings(candles);
  const last = candles.at(-1)?.close ?? 0;
  const support: PriceLevel[] = [];
  const resistance: PriceLevel[] = [];
  for (const swing of swings) {
    if (swing.type === "low" && swing.price <= last) {
      support.push({ price: swing.price, time: swing.time });
    }
    if (swing.type === "high" && swing.price >= last) {
      resistance.push({ price: swing.price, time: swing.time });
    }
  }
  if (daily.length > 0) {
    const dailyHigh = Math.max(...daily.map((candle) => candle.high));
    const dailyLow = Math.min(...daily.map((candle) => candle.low));
    const highTime = daily.find((candle) => candle.high === dailyHigh)?.time ?? last;
    const lowTime = daily.find((candle) => candle.low === dailyLow)?.time ?? last;
    if (dailyHigh >= last) {
      resistance.push({ price: dailyHigh, time: highTime });
    }
    if (dailyLow <= last) {
      support.push({ price: dailyLow, time: lowTime });
    }
  }
  const nearest = (levels: PriceLevel[], descending: boolean) =>
    levels
      .sort((left, right) => Math.abs(last - left.price) - Math.abs(last - right.price))
      .slice(0, 5)
      .sort((left, right) => (descending ? right.price - left.price : left.price - right.price));
  return { support: nearest(support, true), resistance: nearest(resistance, false) };
}

export function detectLiquidity(candles: Candle[]): {
  equalHighs: PriceLevel[];
  equalLows: PriceLevel[];
  nearestBuySide: PriceLevel | null;
  nearestSellSide: PriceLevel | null;
} {
  const last = candles.at(-1)?.close ?? 1;
  const tolerance = last * 0.0005;
  const equalHighs: PriceLevel[] = [];
  const equalLows: PriceLevel[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1]!;
    const current = candles[index]!;
    if (Math.abs(previous.high - current.high) <= tolerance) {
      equalHighs.push({ price: (previous.high + current.high) / 2, time: current.time });
    }
    if (Math.abs(previous.low - current.low) <= tolerance) {
      equalLows.push({ price: (previous.low + current.low) / 2, time: current.time });
    }
  }
  const highs = equalHighs.slice(-20);
  const lows = equalLows.slice(-20);
  return {
    equalHighs: highs,
    equalLows: lows,
    nearestBuySide: highs.filter((level) => level.price > last).at(0) ?? highs.at(-1) ?? null,
    nearestSellSide: lows.filter((level) => level.price < last).at(-1) ?? lows.at(-1) ?? null,
  };
}

export function detectSupplyDemandZones(candles: Candle[]): SupplyDemandZone[] {
  const zones: SupplyDemandZone[] = [];
  for (let index = 3; index < candles.length - 1; index += 1) {
    const candle = candles[index]!;
    const next = candles[index + 1]!;
    if (next.close > next.open && next.close > candle.high) {
      zones.push({
        type: "demand",
        low: Math.min(candle.open, candle.close, candle.low),
        high: Math.max(candle.open, candle.close),
        time: candle.time,
      });
    }
    if (next.close < next.open && next.close < candle.low) {
      zones.push({
        type: "supply",
        low: Math.min(candle.open, candle.close),
        high: Math.max(candle.open, candle.close, candle.high),
        time: candle.time,
      });
    }
  }
  return zones.slice(-30);
}

export function biasFromCandles(
  candles: Candle[],
  params?: { lookbackBars?: number; changeThreshold?: number },
): Bias {
  const lookbackBars = params?.lookbackBars ?? 20;
  const changeThreshold = params?.changeThreshold ?? 0.004;
  if (candles.length < lookbackBars) {
    return "unknown";
  }
  const recent = candles.slice(-lookbackBars);
  const first = recent[0]!.close;
  const last = recent.at(-1)!.close;
  if (first <= 0) {
    return "unknown";
  }
  const change = (last - first) / first;
  if (change > changeThreshold) {
    return "bullish";
  }
  if (change < -changeThreshold) {
    return "bearish";
  }
  return "neutral";
}
