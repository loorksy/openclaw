/**
 * Read-only XAUUSD candles from OANDA. Missing credentials and failed
 * requests stay unavailable. This module never synthesizes a quote.
 */
import { OANDA_INSTRUMENT, type Candle } from "./candles.js";

const BAR_MS = 60 * 60 * 1000;

export interface CandleRead {
  ok: boolean;
  candles: Candle[];
  price: number | null;
  stale: boolean;
  invented: false;
  error?: string;
}

function oandaToken(): string | undefined {
  const token = process.env.OANDA_API_TOKEN?.trim();
  return token ? token : undefined;
}

function oandaBaseUrl(): string {
  return process.env.OANDA_ENV?.toLowerCase() === "live"
    ? "https://api-fxtrade.oanda.com"
    : "https://api-fxpractice.oanda.com";
}

export function marketDataConfigured(): boolean {
  return Boolean(oandaToken());
}

export async function readGoldCandles(
  count = 120,
  fetchImpl: typeof fetch = fetch,
): Promise<CandleRead> {
  const token = oandaToken();
  if (!token) {
    return {
      ok: false,
      candles: [],
      price: null,
      stale: true,
      invented: false,
      error: "Market data is not configured.",
    };
  }
  const url = `${oandaBaseUrl()}/v3/instruments/${OANDA_INSTRUMENT}/candles?granularity=H1&count=${Math.min(Math.max(count, 1), 500)}&price=M`;
  try {
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      return {
        ok: false,
        candles: [],
        price: null,
        stale: true,
        invented: false,
        error: `Market data request failed (${response.status}).`,
      };
    }
    const body = (await response.json()) as {
      candles?: {
        time?: string;
        complete?: boolean;
        volume?: number;
        mid?: { o?: string; h?: string; l?: string; c?: string };
      }[];
    };
    const candles: Candle[] = [];
    for (const row of body.candles ?? []) {
      if (row.complete === false || !row.mid || !row.time) {
        continue;
      }
      const candle = {
        time: Date.parse(row.time),
        open: Number(row.mid.o),
        high: Number(row.mid.h),
        low: Number(row.mid.l),
        close: Number(row.mid.c),
        volume: row.volume,
      };
      if (
        Number.isFinite(candle.time) &&
        [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
      ) {
        candles.push(candle);
      }
    }
    candles.sort((left, right) => left.time - right.time);
    const price = candles.at(-1)?.close ?? null;
    return {
      ok: candles.length > 0,
      candles,
      price,
      stale: candles.length === 0,
      invented: false,
      error: candles.length > 0 ? undefined : "Market data returned no closed candles.",
    };
  } catch {
    return {
      ok: false,
      candles: [],
      price: null,
      stale: true,
      invented: false,
      error: "Market data is unavailable.",
    };
  }
}

export const GOLD_BAR_MS = BAR_MS;
