/**
 * Gold headlines. A missing key, a disabled feed, or a failed read stays
 * unknown. An empty list is honest only after a source succeeds.
 */
import { GOLD_RELEVANT_TERMS } from "./calendar.js";
import { copy } from "./copy.js";
import type { OwnerLanguage } from "./owner.js";

export interface NewsHeadline {
  title: string;
  source: string;
  publishedAt: string;
  url?: string;
}

export interface HeadlineRead {
  ok: boolean;
  headlines: NewsHeadline[];
  invented: false;
  stale: boolean;
  error?: string;
}

const FEED_URL = "https://financialmodelingprep.com/api/v4/forex_news";
const WINDOW_MS = 48 * 60 * 60_000;
const TTL_MS = 15 * 60_000;
const MAX_STALE_MS = 2 * 60 * 60_000;

interface CacheEntry {
  fetchedAt: number;
  headlines: NewsHeadline[];
}

let cache: CacheEntry | null = null;
let flight: Promise<NewsHeadline[]> | null = null;

export function resetHeadlineCacheForTests(): void {
  cache = null;
  flight = null;
}

export function parseFmpHeadlines(rows: unknown): NewsHeadline[] {
  if (!Array.isArray(rows)) {
    throw new Error("Gold headlines returned an unexpected shape.");
  }
  const headlines: NewsHeadline[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const record = row as Record<string, unknown>;
    if (typeof record.title !== "string" || !record.title.trim()) {
      continue;
    }
    if (typeof record.publishedDate !== "string") {
      continue;
    }
    const published = parsePublished(record.publishedDate);
    if (!Number.isFinite(published)) {
      continue;
    }
    const symbol = typeof record.symbol === "string" ? record.symbol : undefined;
    const title = record.title.trim();
    if (!headlineRelevant(title, symbol)) {
      continue;
    }
    const source =
      typeof record.site === "string" && record.site.trim() ? record.site.trim() : "FMP";
    const url = safeUrl(record.url);
    headlines.push({
      title,
      source,
      publishedAt: new Date(published).toISOString(),
      ...(url ? { url } : {}),
    });
  }
  return headlines;
}

export function headlineSetKey(headlines: readonly NewsHeadline[]): string {
  if (headlines.length === 0) {
    return "none";
  }
  return headlines
    .slice()
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, 5)
    .map((item) => {
      const minute = Math.floor(Date.parse(item.publishedAt) / 60_000);
      const title = item.title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      return `${minute}:${title}`;
    })
    .join("|");
}

export function describeHeadlines(
  headlines: readonly NewsHeadline[],
  language: OwnerLanguage,
): string {
  if (headlines.length === 0) {
    return copy(language, "headlines.empty");
  }
  const labels = {
    en: { from: "from", at: "at" },
    ar: { from: "من", at: "في" },
  }[language];
  return headlines
    .slice()
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, 5)
    .map((item) => `${item.title} ${labels.from} ${item.source} ${labels.at} ${item.publishedAt}.`)
    .join(" ");
}

export async function readGoldHeadlines(options?: {
  now?: number;
  fetchImpl?: typeof fetch;
}): Promise<HeadlineRead> {
  const now = options?.now ?? Date.now();
  const apiKey = headlineKey(options?.fetchImpl);
  if (!apiKey) {
    return {
      ok: false,
      headlines: [],
      invented: false,
      stale: false,
      error: "Gold headlines are not configured.",
    };
  }
  if (cache && now - cache.fetchedAt < TTL_MS) {
    return present(cache.headlines, now, false);
  }
  const fetchImpl = options?.fetchImpl ?? fetch;
  if (!flight) {
    const pending = loadHeadlines(fetchImpl, apiKey)
      .then((headlines) => {
        cache = { fetchedAt: now, headlines };
        return headlines;
      })
      .finally(() => {
        if (flight === pending) {
          flight = null;
        }
      });
    flight = pending;
  }
  try {
    const headlines = await flight;
    return present(headlines, now, false);
  } catch (error) {
    if (cache && now - cache.fetchedAt < MAX_STALE_MS) {
      return present(cache.headlines, now, true);
    }
    return {
      ok: false,
      headlines: [],
      invented: false,
      stale: false,
      error: redact(
        error instanceof Error ? error.message : "Gold headlines are unavailable.",
        apiKey,
      ),
    };
  }
}

function present(headlines: NewsHeadline[], now: number, stale: boolean): HeadlineRead {
  return {
    ok: true,
    headlines: headlines.filter((item) => {
      const published = Date.parse(item.publishedAt);
      return published <= now + 5 * 60_000 && now - published <= WINDOW_MS;
    }),
    invented: false,
    stale,
  };
}

function headlineKey(fetchImpl?: typeof fetch): string | undefined {
  if (process.env.LONORA_HEADLINES === "off") {
    return undefined;
  }
  if (process.env.VITEST && !fetchImpl) {
    return undefined;
  }
  return [process.env.FMP_API_KEY, process.env.NEWS_API_KEY, process.env.ECONOMIC_CALENDAR_API_KEY]
    .map((value) => value?.trim())
    .find((value): value is string => Boolean(value));
}

async function loadHeadlines(fetchImpl: typeof fetch, apiKey: string): Promise<NewsHeadline[]> {
  const url = `${FEED_URL}?page=0&apikey=${encodeURIComponent(apiKey)}`;
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    throw new Error(`Gold headlines request failed (${response.status}).`);
  }
  const rows = (await response.json()) as unknown;
  if (rows && typeof rows === "object" && !Array.isArray(rows)) {
    throw new Error("Gold headlines were rejected.");
  }
  return parseFmpHeadlines(rows);
}

function headlineRelevant(title: string, symbol?: string): boolean {
  if (symbol && /xau|gold/i.test(symbol)) {
    return true;
  }
  if (/gold|\bxau\b/i.test(title)) {
    return true;
  }
  return GOLD_RELEVANT_TERMS.test(title);
}

function parsePublished(raw: string): number {
  const trimmed = raw.trim();
  const zoned = /(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(trimmed);
  return Date.parse(zoned ? trimmed : `${trimmed.replace(" ", "T")}Z`);
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value) || /apikey=/i.test(value)) {
    return undefined;
  }
  return value;
}

function redact(message: string, secret: string): string {
  return message.replace(/\s+/g, " ").split(secret).join("[redacted]").slice(0, 180);
}
