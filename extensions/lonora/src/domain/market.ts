/**
 * Gold session clock. Metals open Sunday 18:00 America/New_York and close
 * Friday 17:00, with a daily halt at 17:00 New York. Closed markets never
 * synthesize a new candle.
 */

export type TradingSessionName = "asia" | "london" | "newyork";

export interface MarketClock {
  isOpen: boolean;
  session: TradingSessionName;
  reason: "open" | "saturday" | "friday_close" | "sunday" | "maintenance";
  nextOpenAt: number;
}

const NY_TIMEZONE = "America/New_York";
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatter = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TIMEZONE,
  weekday: "short",
  hour: "2-digit",
  hourCycle: "h23",
});

const wallHourCache = new Map<number, { weekday: number; hour: number }>();

export function nyWallHour(ms: number): { weekday: number; hour: number } {
  const bucket = Math.floor(ms / 3_600_000);
  const cached = wallHourCache.get(bucket);
  if (cached) {
    return cached;
  }
  const parts = formatter.formatToParts(bucket * 3_600_000);
  let weekday = 0;
  let hour = 0;
  for (const part of parts) {
    if (part.type === "weekday") {
      weekday = WEEKDAY_INDEX[part.value] ?? 0;
    } else if (part.type === "hour") {
      hour = Number(part.value) % 24;
    }
  }
  const wall = { weekday, hour };
  if (wallHourCache.size > 20_000) {
    wallHourCache.clear();
  }
  wallHourCache.set(bucket, wall);
  return wall;
}

export function isGoldMarketOpenAt(ms: number): boolean {
  const { weekday, hour } = nyWallHour(ms);
  if (weekday === 6) {
    return false;
  }
  if (weekday === 5 && hour >= 17) {
    return false;
  }
  if (weekday === 0 && hour < 18) {
    return false;
  }
  if (hour === 17 && weekday !== 0 && weekday !== 6) {
    return false;
  }
  return true;
}

export function sessionOf(ms: number): TradingSessionName {
  const hour = new Date(ms).getUTCHours();
  if (hour >= 7 && hour < 12) {
    return "london";
  }
  if (hour >= 12 && hour < 21) {
    return "newyork";
  }
  return "asia";
}

export function nextGoldOpenAt(nowMs: number): number {
  if (isGoldMarketOpenAt(nowMs)) {
    return nowMs;
  }
  const hour = 3_600_000;
  let boundary = Math.ceil(nowMs / hour) * hour;
  const limit = nowMs + 14 * 24 * hour;
  while (boundary <= limit) {
    if (isGoldMarketOpenAt(boundary)) {
      return boundary;
    }
    boundary += hour;
  }
  throw new Error("nextGoldOpenAt: no open instant within 14 days");
}

export function readMarketClock(nowMs: number): MarketClock {
  const { weekday, hour } = nyWallHour(nowMs);
  const isOpen = isGoldMarketOpenAt(nowMs);
  let reason: MarketClock["reason"] = "open";
  if (!isOpen) {
    if (weekday === 6) {
      reason = "saturday";
    } else if (weekday === 5 && hour >= 17) {
      reason = "friday_close";
    } else if (weekday === 0) {
      reason = "sunday";
    } else {
      reason = "maintenance";
    }
  }
  return {
    isOpen,
    session: sessionOf(nowMs),
    reason,
    nextOpenAt: nextGoldOpenAt(nowMs),
  };
}

/** Closed markets may expose the last completed bar. They may not invent a newer one. */
export function candlesVisibleAt<T extends { time: number }>(
  candles: T[],
  nowMs: number,
  barMs: number,
): {
  candles: T[];
  stale: boolean;
  invented: false;
} {
  const closed = candles.filter((candle) => candle.time + barMs <= nowMs);
  const last = closed.at(-1);
  const stale =
    !isGoldMarketOpenAt(nowMs) || (last != null && nowMs - (last.time + barMs) > barMs * 3);
  return { candles: closed, stale, invented: false };
}
