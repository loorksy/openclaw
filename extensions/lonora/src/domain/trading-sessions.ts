/**
 * Which major center is inside its own trading day.
 * Windows follow each city's wall clock, including DST. This is separate
 * from the coarse UTC bucket used for case fingerprints, and from the gold
 * open/closed book. It does not describe how price will move.
 */
import { copy } from "./copy.js";
import type { OwnerLanguage } from "./owner.js";

export type CenterName = "sydney" | "tokyo" | "london" | "newyork";

export type CenterOverlap = "sydney_tokyo" | "tokyo_london" | "london_newyork";

export interface TradingSessionInfo {
  atMs: number;
  active: CenterName[];
  primary: CenterName | null;
  overlap: CenterOverlap | null;
  nextOpen: { session: CenterName; inMs: number } | null;
}

const WINDOWS: Record<CenterName, { timeZone: string; openHour: number; closeHour: number }> = {
  sydney: { timeZone: "Australia/Sydney", openHour: 7, closeHour: 16 },
  tokyo: { timeZone: "Asia/Tokyo", openHour: 9, closeHour: 18 },
  london: { timeZone: "Europe/London", openHour: 8, closeHour: 17 },
  newyork: { timeZone: "America/New_York", openHour: 8, closeHour: 17 },
};

const ORDER: CenterName[] = ["sydney", "tokyo", "london", "newyork"];
const PRIMARY: CenterName[] = ["newyork", "london", "tokyo", "sydney"];
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

function wallClock(
  timeZone: string,
  atMs: number,
): { weekday: number; hour: number; minute: number } {
  const parts = formatterFor(timeZone).formatToParts(new Date(atMs));
  let weekday = 0;
  let hour = 0;
  let minute = 0;
  for (const part of parts) {
    if (part.type === "weekday") {
      weekday = WEEKDAY_INDEX[part.value] ?? 0;
    } else if (part.type === "hour") {
      hour = Number(part.value) % 24;
    } else if (part.type === "minute") {
      minute = Number(part.value);
    }
  }
  return { weekday, hour, minute };
}

export function isCenterOpen(session: CenterName, atMs: number): boolean {
  const window = WINDOWS[session];
  const { weekday, hour, minute } = wallClock(window.timeZone, atMs);
  if (weekday === 0 || weekday === 6) {
    return false;
  }
  const minuteOfDay = hour * 60 + minute;
  return minuteOfDay >= window.openHour * 60 && minuteOfDay < window.closeHour * 60;
}

function overlapOf(active: CenterName[]): CenterOverlap | null {
  const has = (session: CenterName) => active.includes(session);
  if (has("london") && has("newyork")) {
    return "london_newyork";
  }
  if (has("tokyo") && has("london")) {
    return "tokyo_london";
  }
  if (has("sydney") && has("tokyo")) {
    return "sydney_tokyo";
  }
  return null;
}

const SCAN_STEP_MS = 15 * 60_000;
const SCAN_LIMIT_MS = 8 * 24 * 60 * 60_000;

function findNextOpen(atMs: number): { session: CenterName; inMs: number } | null {
  for (let offset = SCAN_STEP_MS; offset <= SCAN_LIMIT_MS; offset += SCAN_STEP_MS) {
    for (const session of ORDER) {
      if (isCenterOpen(session, atMs + offset)) {
        return { session, inMs: offset };
      }
    }
  }
  return null;
}

export function getTradingSessionInfo(nowMs: number): TradingSessionInfo {
  const active = ORDER.filter((session) => isCenterOpen(session, nowMs));
  return {
    atMs: nowMs,
    active,
    primary: PRIMARY.find((session) => active.includes(session)) ?? null,
    overlap: overlapOf(active),
    nextOpen: active.length === 0 ? findNextOpen(nowMs) : null,
  };
}

function overlapKey(overlap: CenterOverlap) {
  switch (overlap) {
    case "sydney_tokyo":
      return "session.overlap.sydney_tokyo" as const;
    case "tokyo_london":
      return "session.overlap.tokyo_london" as const;
    case "london_newyork":
      return "session.overlap.london_newyork" as const;
  }
}

function centerKey(session: CenterName) {
  switch (session) {
    case "sydney":
      return "session.center.sydney" as const;
    case "tokyo":
      return "session.center.tokyo" as const;
    case "london":
      return "session.center.london" as const;
    case "newyork":
      return "session.center.newyork" as const;
  }
}

function joinNames(names: string[], language: OwnerLanguage): string {
  if (names.length <= 1) {
    return names[0] ?? "";
  }
  if (language === "ar") {
    return names.join(" و");
  }
  if (names.length === 2) {
    return `${names[0]} and ${names[1]}`;
  }
  return `${names.slice(0, -1).join(", ")}, and ${names.at(-1)}`;
}

function durationLabel(ms: number, language: OwnerLanguage): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (language === "ar") {
    if (hours <= 0) {
      return `${minutes} د`;
    }
    return minutes > 0 ? `${hours} س ${minutes} د` : `${hours} س`;
  }
  if (hours <= 0) {
    return `${minutes}m`;
  }
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Owner sentence. Names only centers the clock supports. */
export function describeTradingCenters(info: TradingSessionInfo, language: OwnerLanguage): string {
  if (info.active.length === 0) {
    const next = info.nextOpen
      ? ` ${copy(language, "session.centersNext")} ${copy(language, centerKey(info.nextOpen.session))} ${durationLabel(info.nextOpen.inMs, language)}.`
      : "";
    return `${copy(language, "session.centersNone")}${next}`;
  }
  const names = joinNames(
    info.active.map((session) => copy(language, centerKey(session))),
    language,
  );
  const open = copy(
    language,
    info.active.length === 1
      ? "session.oneOpen"
      : info.active.length === 2
        ? "session.manyOpen"
        : "session.severalOpen",
  );
  const overlap = info.overlap ? ` ${copy(language, overlapKey(info.overlap))}` : "";
  return `${names} ${open}${overlap}`;
}
