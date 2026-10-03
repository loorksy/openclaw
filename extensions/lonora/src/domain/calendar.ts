/**
 * Gold economic calendar. A failed or disabled feed stays unknown.
 * An empty successful feed is a quiet window, not a fabricated one.
 * The cache stores event times and is discarded after two hours.
 */
import { copy } from "./copy.js";
import type { OwnerLanguage } from "./owner.js";

export type CalendarImpact = "low" | "medium" | "high";

export interface EconomicEvent {
  title: string;
  time: string;
  impact: CalendarImpact;
  currency?: string;
}

export interface CalendarRead {
  ok: boolean;
  events: EconomicEvent[];
  invented: false;
  stale: boolean;
  error?: string;
}

const FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const FMP_URL = "https://financialmodelingprep.com/api/v3/economic_calendar";
const FETCH_PAST_MS = 12 * 60 * 60_000;
const FETCH_FUTURE_MS = 48 * 60 * 60_000;
const DEFAULT_TTL_MS = 15 * 60_000;
const NEAR_TTL_MS = 2 * 60_000;
const NEAR_HORIZON_MS = 2 * 60 * 60_000;
const MAX_STALE_MS = 2 * 60 * 60_000;
const ALERT_HORIZON_MS = NEAR_HORIZON_MS;

/** Gold-relevant titles beyond a plain USD print. Shared by every source. */
export const GOLD_RELEVANT_TERMS =
  /fed|fomc|cpi|nfp|non[- ]?farm|payroll|inflation|interest rate|yield|treasury|powell|pce/i;

const COUNTRY_CURRENCY: Record<string, string> = {
  US: "USD",
  USA: "USD",
  "UNITED STATES": "USD",
  EU: "EUR",
  EMU: "EUR",
  EUROZONE: "EUR",
  "EURO AREA": "EUR",
  DE: "EUR",
  GERMANY: "EUR",
  FR: "EUR",
  FRANCE: "EUR",
  GB: "GBP",
  UK: "GBP",
  "UNITED KINGDOM": "GBP",
  JP: "JPY",
  JAPAN: "JPY",
  CH: "CHF",
  SWITZERLAND: "CHF",
  CA: "CAD",
  CANADA: "CAD",
  AU: "AUD",
  AUSTRALIA: "AUD",
  NZ: "NZD",
  "NEW ZEALAND": "NZD",
};

interface CacheEntry {
  fetchedAt: number;
  events: EconomicEvent[];
}

let cache: CacheEntry | null = null;
let flight: Promise<EconomicEvent[]> | null = null;

export function resetCalendarCacheForTests(): void {
  cache = null;
  flight = null;
}

export function eventMatchesRequest(
  event: EconomicEvent,
  input: { currencies: string[]; from: Date; to: Date },
): boolean {
  const time = Date.parse(event.time);
  if (!Number.isFinite(time) || time < input.from.getTime() || time > input.to.getTime()) {
    return false;
  }
  const wanted = new Set(input.currencies.map((currency) => currency.toUpperCase()));
  if (event.currency && wanted.has(event.currency)) {
    return true;
  }
  if (wanted.has("XAU")) {
    if (event.currency === "USD") {
      return true;
    }
    if (GOLD_RELEVANT_TERMS.test(event.title)) {
      return true;
    }
  }
  return false;
}

export function eventKey(event: EconomicEvent): string {
  const minute = Math.floor(Date.parse(event.time) / 60_000);
  const title = event.title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `${event.currency ?? "?"}:${minute}:${title}`;
}

/** Nearest high-impact print inside the alert horizon, or "none". */
export function upcomingHighImpactKey(
  events: EconomicEvent[],
  now: number,
  horizonMs = ALERT_HORIZON_MS,
): string {
  const upcoming = events
    .filter((event) => event.impact === "high")
    .map((event) => ({ event, time: Date.parse(event.time) }))
    .filter((row) => Number.isFinite(row.time) && row.time >= now && row.time - now <= horizonMs)
    .sort((a, b) => a.time - b.time);
  const first = upcoming[0];
  return first ? eventKey(first.event) : "none";
}

export function describeCalendarEvents(events: EconomicEvent[], language: OwnerLanguage): string {
  const listed = events
    .filter((event) => event.impact === "high" || event.impact === "medium")
    .slice()
    .sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
    .slice(0, 8);
  if (listed.length === 0) {
    return copy(language, "calendar.empty");
  }
  const labels = {
    en: { high: "High", medium: "Medium", at: "at" },
    ar: { high: "عالي", medium: "متوسط", at: "في" },
  }[language];
  return listed
    .map((event) => {
      const currency = event.currency ? ` (${event.currency})` : "";
      return `${labels[event.impact]}: ${event.title}${currency} ${labels.at} ${event.time}.`;
    })
    .join(" ");
}

export function parseForexFactoryRows(rows: unknown): EconomicEvent[] {
  if (!Array.isArray(rows)) {
    throw new Error("Economic calendar returned an unexpected shape.");
  }
  const events: EconomicEvent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const record = row as Record<string, unknown>;
    if (typeof record.title !== "string" || !record.title.trim()) {
      continue;
    }
    if (typeof record.date !== "string") {
      continue;
    }
    const time = new Date(record.date);
    if (!Number.isFinite(time.getTime())) {
      continue;
    }
    const currency =
      typeof record.country === "string" && record.country.trim().length === 3
        ? record.country.trim().toUpperCase()
        : undefined;
    events.push({
      title: record.title.trim(),
      time: time.toISOString(),
      impact: mapImpact(record.impact),
      currency,
    });
  }
  return events;
}

export function parseFmpRows(rows: unknown): EconomicEvent[] {
  if (!Array.isArray(rows)) {
    throw new Error("Economic calendar returned an unexpected shape.");
  }
  const events: EconomicEvent[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const record = row as Record<string, unknown>;
    if (typeof record.event !== "string" || !record.event.trim()) {
      continue;
    }
    if (typeof record.date !== "string") {
      continue;
    }
    const time = new Date(record.date);
    if (!Number.isFinite(time.getTime())) {
      continue;
    }
    events.push({
      title: record.event.trim(),
      time: time.toISOString(),
      impact: mapImpact(record.impact),
      currency: fmpCurrency(record),
    });
  }
  return events;
}

export async function readGoldCalendar(options?: {
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<CalendarRead> {
  const now = options?.now ?? Date.now();
  const sources = liveSources(options?.fetchImpl);
  if (!sources.ff && !sources.fmpKey) {
    return {
      ok: false,
      events: [],
      invented: false,
      stale: false,
      error: "Economic calendar is not configured.",
    };
  }
  const from = now - FETCH_PAST_MS;
  const to = now + FETCH_FUTURE_MS;
  if (cache && now - cache.fetchedAt < ttlFor(cache, now)) {
    return present(cache.events, from, to, false);
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  if (!flight) {
    const pending = loadEvents(now, fetchImpl, sources)
      .then((events) => {
        cache = { fetchedAt: now, events };
        return events;
      })
      .finally(() => {
        if (flight === pending) {
          flight = null;
        }
      });
    flight = pending;
  }
  try {
    const events = await flight;
    return present(events, from, to, false);
  } catch (error) {
    if (cache && now - cache.fetchedAt < MAX_STALE_MS) {
      return present(cache.events, from, to, true);
    }
    return {
      ok: false,
      events: [],
      invented: false,
      stale: false,
      error: redact(
        error instanceof Error ? error.message : "Economic calendar is unavailable.",
        sources.fmpKey,
      ),
    };
  }
}

function present(events: EconomicEvent[], from: number, to: number, stale: boolean): CalendarRead {
  return {
    ok: true,
    events: events.filter((event) => {
      const time = Date.parse(event.time);
      return time >= from && time <= to;
    }),
    invented: false,
    stale,
  };
}

function ttlFor(entry: CacheEntry, now: number): number {
  const near = entry.events.some((event) => {
    if (event.impact !== "high") {
      return false;
    }
    const delta = Date.parse(event.time) - now;
    return delta >= 0 && delta <= NEAR_HORIZON_MS;
  });
  return near ? NEAR_TTL_MS : DEFAULT_TTL_MS;
}

function liveSources(fetchImpl?: typeof fetch): { ff: boolean; fmpKey?: string } {
  if (process.env.LONORA_CALENDAR === "off") {
    return { ff: false };
  }
  if (process.env.VITEST && !fetchImpl) {
    return { ff: false };
  }
  const fmpKey = [
    process.env.FMP_API_KEY,
    process.env.NEWS_API_KEY,
    process.env.ECONOMIC_CALENDAR_API_KEY,
  ]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
  return { ff: true, fmpKey };
}

async function loadEvents(
  now: number,
  fetchImpl: typeof fetch,
  sources: { ff: boolean; fmpKey?: string },
): Promise<EconomicEvent[]> {
  const input = {
    currencies: ["XAU"],
    from: new Date(now - FETCH_PAST_MS),
    to: new Date(now + FETCH_FUTURE_MS),
  };
  const jobs: Promise<EconomicEvent[]>[] = [];
  if (sources.ff) {
    jobs.push(loadForexFactory(fetchImpl, input));
  }
  if (sources.fmpKey) {
    jobs.push(loadFmp(fetchImpl, sources.fmpKey, input));
  }
  const settled = await Promise.allSettled(jobs);
  const fulfilled = settled.filter(
    (item): item is PromiseFulfilledResult<EconomicEvent[]> => item.status === "fulfilled",
  );
  if (fulfilled.length === 0) {
    const first = settled.find((item) => item.status === "rejected") as
      | PromiseRejectedResult
      | undefined;
    throw first?.reason instanceof Error
      ? first.reason
      : new Error("Economic calendar is unavailable.");
  }
  return dedupe(fulfilled.flatMap((item) => item.value));
}

async function loadForexFactory(
  fetchImpl: typeof fetch,
  input: { currencies: string[]; from: Date; to: Date },
): Promise<EconomicEvent[]> {
  const response = await fetchImpl(FEED_URL, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Economic calendar request failed (${response.status}).`);
  }
  const rows = (await response.json()) as unknown;
  return parseForexFactoryRows(rows).filter((event) => eventMatchesRequest(event, input));
}

async function loadFmp(
  fetchImpl: typeof fetch,
  apiKey: string,
  input: { currencies: string[]; from: Date; to: Date },
): Promise<EconomicEvent[]> {
  const from = input.from.toISOString().slice(0, 10);
  const to = input.to.toISOString().slice(0, 10);
  const url = `${FMP_URL}?from=${from}&to=${to}&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Economic calendar request failed (${response.status}).`);
  }
  const rows = (await response.json()) as unknown;
  return parseFmpRows(rows).filter((event) => eventMatchesRequest(event, input));
}

function dedupe(events: EconomicEvent[]): EconomicEvent[] {
  const seen = new Set<string>();
  const merged: EconomicEvent[] = [];
  for (const event of events) {
    const key = eventKey(event);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(event);
  }
  return merged.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

function mapImpact(raw: unknown): CalendarImpact {
  const value = String(raw ?? "").toLowerCase();
  if (value.includes("high") || value === "3") {
    return "high";
  }
  if (value.includes("medium") || value.includes("moderate") || value === "2") {
    return "medium";
  }
  return "low";
}

function fmpCurrency(record: Record<string, unknown>): string | undefined {
  if (typeof record.currency === "string" && record.currency.trim().length === 3) {
    return record.currency.trim().toUpperCase();
  }
  if (typeof record.country !== "string") {
    return undefined;
  }
  return COUNTRY_CURRENCY[record.country.toUpperCase().trim()];
}

function redact(message: string, secret?: string): string {
  const compact = message.replace(/\s+/g, " ").slice(0, 180);
  return secret ? compact.split(secret).join("[redacted]") : compact;
}
