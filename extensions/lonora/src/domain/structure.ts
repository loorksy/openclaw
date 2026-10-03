/**
 * BOS / CHoCH / MSS detection. A break requires a close beyond the swing.
 * A wick-only poke is a sweep, not a break. Uncertain series emit nothing.
 */
import { calculateAtr, type Candle, type Swing } from "./candles.js";

export interface StructureEvent {
  type: "BOS" | "CHoCH" | "MSS";
  direction: "bullish" | "bearish";
  brokenLevel: number;
  breakCandleTime: number;
  confirmationClose: number;
  strength: number;
}

export function detectStructureEvents(
  candles: Candle[],
  swings: Swing[],
  atr: number | null,
): StructureEvent[] {
  if (candles.length < 10 || swings.length < 1) {
    return [];
  }
  const effectiveAtr = atr && atr > 0 ? atr : approximateAtr(candles);
  if (!effectiveAtr) {
    return [];
  }
  const events: StructureEvent[] = [];
  let trend: 1 | -1 | 0 = 0;
  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  const ordered = [...swings].sort((left, right) => left.time - right.time);
  let swingIndex = 0;
  for (let index = 0; index < candles.length; index += 1) {
    const candle = candles[index]!;
    while (swingIndex < ordered.length && ordered[swingIndex]!.time <= candle.time) {
      const swing = ordered[swingIndex]!;
      if (swing.type === "high") {
        lastHigh = swing;
      } else {
        lastLow = swing;
      }
      swingIndex += 1;
    }
    if (lastHigh && candle.close > lastHigh.price && candle.time > lastHigh.time) {
      const event = classifyBreak({
        direction: "bullish",
        trend,
        level: lastHigh.price,
        candle,
        next: candles[index + 1],
        atr: effectiveAtr,
      });
      if (event) {
        events.push(event);
        trend = 1;
      }
      lastHigh = null;
    }
    if (lastLow && candle.close < lastLow.price && candle.time > lastLow.time) {
      const event = classifyBreak({
        direction: "bearish",
        trend,
        level: lastLow.price,
        candle,
        next: candles[index + 1],
        atr: effectiveAtr,
      });
      if (event) {
        events.push(event);
        trend = -1;
      }
      lastLow = null;
    }
  }
  return events.slice(-20);
}

export function latestStructureEvent(events: StructureEvent[]): StructureEvent | null {
  return events.at(-1) ?? null;
}

function classifyBreak(input: {
  direction: "bullish" | "bearish";
  trend: 1 | -1 | 0;
  level: number;
  candle: Candle;
  next: Candle | undefined;
  atr: number;
}): StructureEvent | null {
  const directionSign = input.direction === "bullish" ? 1 : -1;
  const displacementAtr = Math.abs(input.candle.close - input.level) / input.atr;
  const bodyAtr = Math.abs(input.candle.close - input.candle.open) / input.atr;
  const followThrough =
    input.next != null && Math.sign(input.next.close - input.next.open) === directionSign;
  let strength = Math.min(40, Math.round(displacementAtr * 40));
  strength += Math.min(30, Math.round(bodyAtr * 20));
  if (followThrough) {
    strength += 20;
  }
  strength = Math.max(5, Math.min(100, strength));
  const withTrend =
    input.trend === 0 ||
    (input.direction === "bullish" ? input.trend === 1 : input.trend === -1);
  const type: StructureEvent["type"] = withTrend
    ? "BOS"
    : bodyAtr >= 1.5 || (displacementAtr >= 1 && followThrough)
      ? "MSS"
      : "CHoCH";
  return {
    type,
    direction: input.direction,
    brokenLevel: input.level,
    breakCandleTime: input.candle.time,
    confirmationClose: input.candle.close,
    strength,
  };
}

function approximateAtr(candles: Candle[]): number | null {
  const ranges = candles
    .slice(-14)
    .map((candle) => candle.high - candle.low)
    .filter((range) => range > 0);
  if (ranges.length === 0) {
    return null;
  }
  return ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
}

export { calculateAtr };
