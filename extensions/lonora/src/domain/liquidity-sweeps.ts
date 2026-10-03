/**
 * A liquidity sweep is a wick through a resting pool and a close back inside.
 * A close beyond the level is a structure break, not a sweep. Pure candle math.
 */
import {
  calculateAtr,
  detectLiquidity,
  detectSwings,
  type Candle,
  type PriceLevel,
} from "./candles.js";
import { detectStructureEvents, type StructureEvent } from "./structure.js";

export type LiquiditySweep = {
  side: "buy_side" | "sell_side";
  sweptLevel: number;
  candleTime: number;
  wickExtreme: number;
  closeBackInside: boolean;
  strength: number;
  followedByStructureShift: boolean;
};

export function detectLiquiditySweeps(input: {
  candles: Candle[];
  equalHighs: PriceLevel[];
  equalLows: PriceLevel[];
  structureEvents?: StructureEvent[];
  atr?: number | null;
}): LiquiditySweep[] {
  const { candles, equalHighs, equalLows } = input;
  if (candles.length < 5) {
    return [];
  }
  const atr = input.atr && input.atr > 0 ? input.atr : approximateAtr(candles);
  if (!atr) {
    return [];
  }
  const sweeps: LiquiditySweep[] = [];
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index]!;
    for (const pool of equalHighs) {
      if (pool.time >= candle.time) {
        continue;
      }
      if (candle.high > pool.price && candle.close < pool.price) {
        sweeps.push(
          buildSweep({
            side: "buy_side",
            level: pool.price,
            candle,
            atr,
            structureEvents: input.structureEvents ?? [],
          }),
        );
        break;
      }
    }
    for (const pool of equalLows) {
      if (pool.time >= candle.time) {
        continue;
      }
      if (candle.low < pool.price && candle.close > pool.price) {
        sweeps.push(
          buildSweep({
            side: "sell_side",
            level: pool.price,
            candle,
            atr,
            structureEvents: input.structureEvents ?? [],
          }),
        );
        break;
      }
    }
  }
  const seen = new Set<string>();
  const unique = sweeps.filter((sweep) => {
    const key = `${sweep.side}:${sweep.sweptLevel.toFixed(6)}:${sweep.candleTime}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  return unique.slice(-10);
}

export function latestLiquiditySweep(sweeps: LiquiditySweep[]): LiquiditySweep | null {
  return sweeps.at(-1) ?? null;
}

export function enrichSweepsWithStructure(
  sweeps: LiquiditySweep[],
  structureEvents: StructureEvent[],
): LiquiditySweep[] {
  if (structureEvents.length === 0) {
    return sweeps;
  }
  return sweeps.map((sweep) => {
    const wanted = sweep.side === "buy_side" ? "bearish" : "bullish";
    const followed = structureEvents.some(
      (event) =>
        (event.type === "CHoCH" || event.type === "MSS") &&
        event.direction === wanted &&
        event.breakCandleTime >= sweep.candleTime,
    );
    if (followed === sweep.followedByStructureShift) {
      return sweep;
    }
    return {
      ...sweep,
      followedByStructureShift: followed,
      strength: Math.max(5, Math.min(100, sweep.strength + (followed ? 30 : -30))),
    };
  });
}

export function analyzeLiquidity(candles: Candle[]) {
  const pools = detectLiquidity(candles);
  const atr = calculateAtr(candles);
  const events = detectStructureEvents(candles, detectSwings(candles), atr);
  const sweeps = enrichSweepsWithStructure(
    detectLiquiditySweeps({
      candles,
      equalHighs: pools.equalHighs,
      equalLows: pools.equalLows,
      atr,
    }),
    events,
  );
  return { ...pools, sweeps, latest: latestLiquiditySweep(sweeps), atr };
}

export function sweepKey(sweep: LiquiditySweep | null): string {
  return sweep ? `${sweep.side}:${sweep.candleTime}:${sweep.sweptLevel}` : "none";
}

function buildSweep(input: {
  side: "buy_side" | "sell_side";
  level: number;
  candle: Candle;
  atr: number;
  structureEvents: StructureEvent[];
}): LiquiditySweep {
  const { side, level, candle, atr } = input;
  const wickExtreme = side === "buy_side" ? candle.high : candle.low;
  const penetration = Math.abs(wickExtreme - level);
  const rejection = Math.abs(candle.close - wickExtreme);
  const wantedDirection = side === "buy_side" ? "bearish" : "bullish";
  const followedByStructureShift = input.structureEvents.some(
    (event) =>
      (event.type === "CHoCH" || event.type === "MSS") &&
      event.direction === wantedDirection &&
      event.breakCandleTime >= candle.time,
  );
  let strength = 0;
  strength += Math.min(35, Math.round((penetration / atr) * 35));
  strength += Math.min(35, Math.round((rejection / atr) * 25));
  if (followedByStructureShift) {
    strength += 30;
  }
  strength = Math.max(5, Math.min(100, strength));
  return {
    side,
    sweptLevel: level,
    candleTime: candle.time,
    wickExtreme,
    closeBackInside: true,
    strength,
    followedByStructureShift,
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
  return ranges.reduce((sum, range) => sum + range, 0) / ranges.length;
}
