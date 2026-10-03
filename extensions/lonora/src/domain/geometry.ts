/**
 * Gold stop placement, ported from Boty's scalp geometry.
 * The stop is pushed beyond the structural level. It is never pulled closer.
 */

export type TradeSpanStyle = "scalp" | "intraday" | "swing";

export const TRADE_SPAN: Record<
  TradeSpanStyle,
  { minTp1Atr: number; minTp2Atr: number; stopBufferAtr: number; minStopAtr: number }
> = {
  scalp: { minTp1Atr: 3.5, minTp2Atr: 6, stopBufferAtr: 0.5, minStopAtr: 2 },
  intraday: { minTp1Atr: 4.5, minTp2Atr: 7.5, stopBufferAtr: 0.6, minStopAtr: 1.5 },
  swing: { minTp1Atr: 6, minTp2Atr: 10, stopBufferAtr: 0.75, minStopAtr: 1.2 },
};

const MIN_TICK_MULTIPLIER = 8;

export interface SymbolGeometryMeta {
  tickSize?: number | null;
  digits?: number | null;
  spread?: number | null;
}

export function spanStyleForInterval(interval?: string | null): TradeSpanStyle {
  const raw = (interval ?? "").trim().toLowerCase();
  if (raw === "1m" || raw === "5m" || raw === "1" || raw === "5") {
    return "scalp";
  }
  if (
    raw === "15m" ||
    raw === "30m" ||
    raw === "15" ||
    raw === "30" ||
    raw === "45m" ||
    raw === "45"
  ) {
    return "intraday";
  }
  return raw ? "swing" : "intraday";
}

export function tradeSpanFor(interval?: string | null) {
  return TRADE_SPAN[spanStyleForInterval(interval)];
}

export function inferTickSize(price: number, meta?: SymbolGeometryMeta | null): number {
  const fromMeta = Number(meta?.tickSize);
  if (Number.isFinite(fromMeta) && fromMeta > 0) {
    return fromMeta;
  }
  if (price > 100) {
    return 0.01;
  }
  if (price > 10) {
    return 0.001;
  }
  if (price > 2) {
    return 0.0001;
  }
  return 0.00001;
}

export function roundToTick(price: number, meta?: SymbolGeometryMeta | null): number {
  const tick = inferTickSize(price, meta);
  const digits =
    Number.isFinite(Number(meta?.digits)) && Number(meta?.digits) >= 0
      ? Number(meta?.digits)
      : Math.max(0, Math.round(-Math.log10(tick)));
  const stepped = Math.round(price / tick) * tick;
  const scale = 10 ** digits;
  return Math.round(stepped * scale) / scale;
}

export function minStopDistance(input: {
  atr?: number | null;
  spread?: number | null;
  interval?: string | null;
  price: number;
  meta?: SymbolGeometryMeta | null;
}): number {
  const span = tradeSpanFor(input.interval);
  const atr = Number(input.atr);
  const spread = Number(input.spread ?? input.meta?.spread);
  const tick = inferTickSize(input.price, input.meta);
  return Math.max(
    Number.isFinite(atr) && atr > 0 ? atr * span.minStopAtr : 0,
    Number.isFinite(spread) && spread > 0 ? spread * 4 : 0,
    tick * 20,
  );
}

/** Push a stop out to the minimum distance. Never pulls a stop in. */
export function applyStopDistanceFloor(input: {
  action: "buy" | "sell";
  entry: number;
  stop: number;
  atr?: number | null;
  spread?: number | null;
  interval?: string | null;
  meta?: SymbolGeometryMeta | null;
}): { stop: number; floor: number; widened: boolean } {
  const floor = minStopDistance({
    atr: input.atr,
    spread: input.spread,
    interval: input.interval,
    price: input.entry,
    meta: input.meta,
  });
  if (!(input.entry > 0) || !(input.stop > 0) || !(floor > 0)) {
    return { stop: input.stop, floor, widened: false };
  }
  const distance = Math.abs(input.entry - input.stop);
  if (distance + 1e-9 >= floor) {
    return { stop: input.stop, floor, widened: false };
  }
  const widened = roundToTick(
    input.action === "buy" ? input.entry - floor : input.entry + floor,
    input.meta,
  );
  return { stop: widened, floor, widened: true };
}

/** Preferred net reward after a quoted spread. A missing spread is not treated as zero. */
export const MIN_NET_TP1_R = 2.5;
const SLIPPAGE_SPREAD_MULT = 0.5;

export function executionCost(spread?: number | null): number | null {
  if (spread == null || !(spread > 0)) {
    return null;
  }
  return spread * (1 + SLIPPAGE_SPREAD_MULT);
}

/** Net reward after spread and slippage. An unread spread stays unread. */
export function computeNetR(input: {
  entry: number;
  stop: number;
  target: number;
  spread?: number | null;
}): { netR: number; spreadKnown: boolean } {
  const cost = executionCost(input.spread);
  const applied = cost ?? 0;
  const risk = Math.abs(input.entry - input.stop) + applied;
  if (!(risk > 0)) {
    return { netR: 0, spreadKnown: cost != null };
  }
  const reward = Math.max(0, Math.abs(input.target - input.entry) - applied);
  return { netR: reward / risk, spreadKnown: cost != null };
}

/** Distance beyond the structural invalidation. The stop never sits on that level. */
export function stopBuffer(input: {
  symbolPrice: number;
  spread?: number | null;
  atr?: number | null;
  meta?: SymbolGeometryMeta | null;
  interval?: string | null;
}): number {
  const minTick = inferTickSize(input.symbolPrice, input.meta);
  const span = tradeSpanFor(input.interval);
  const spread = Number(input.spread);
  const atr = Number(input.atr);
  return Math.max(
    Number.isFinite(spread) && spread > 0 ? spread * 2 : 0,
    Number.isFinite(atr) && atr > 0 ? atr * span.stopBufferAtr : 0,
    minTick * MIN_TICK_MULTIPLIER,
  );
}

export function placeProtectedStop(input: {
  action: "buy" | "sell";
  entry: number;
  structuralStop: number;
  atr?: number | null;
  spread?: number | null;
  interval?: string | null;
  meta?: SymbolGeometryMeta | null;
}): { stop: number; structuralStop: number; buffer: number; widened: boolean } | null {
  if (!(input.entry > 0) || !(input.structuralStop > 0)) {
    return null;
  }
  if (input.action === "buy" && !(input.structuralStop < input.entry)) {
    return null;
  }
  if (input.action === "sell" && !(input.structuralStop > input.entry)) {
    return null;
  }
  const buffer = stopBuffer({
    symbolPrice: input.entry,
    spread: input.spread,
    atr: input.atr,
    meta: input.meta,
    interval: input.interval,
  });
  const raw = roundToTick(
    input.action === "buy" ? input.structuralStop - buffer : input.structuralStop + buffer,
    input.meta,
  );
  const floored = applyStopDistanceFloor({
    action: input.action,
    entry: input.entry,
    stop: raw,
    atr: input.atr,
    spread: input.spread,
    interval: input.interval,
    meta: input.meta,
  });
  return {
    stop: floored.stop,
    structuralStop: roundToTick(input.structuralStop, input.meta),
    buffer,
    widened: floored.widened,
  };
}
