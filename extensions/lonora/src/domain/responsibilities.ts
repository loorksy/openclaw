/**
 * Deterministic responsibility checks. A scheduled phrase becomes a cron
 * expression. Everything else waits for a matching market reason.
 */
import type { MonitorDecision } from "./monitor.js";

const TOPIC_RULES: { pattern: RegExp; reasons: string[] }[] = [
  { pattern: /structure|bos|choch|swing|هيكل/i, reasons: ["structure_change"] },
  { pattern: /liquid|sweep|سيولة/i, reasons: ["liquidity_sweep"] },
  { pattern: /recommend|توصية/i, reasons: ["recommendation_change"] },
  {
    pattern: /session|new york|london|جلسة|نيويورك|لندن/i,
    reasons: ["session_transition", "session_transition_while_closed"],
  },
  { pattern: /price|volatil|سعر|تذبذب/i, reasons: ["price_move", "volatility_change"] },
];

export function cronForResponsibility(
  instruction: string,
): { expr: string; tz: "America/New_York" } | null {
  if (/every morning|each morning|daily briefing|كل صباح|إحاطة صباحية/i.test(instruction)) {
    return { expr: "0 8 * * 1-5", tz: "America/New_York" };
  }
  return null;
}

export function checkResponsibility(
  instruction: string,
  decision: Pick<MonitorDecision, "reasons">,
  marketOpen: boolean,
): { matched: string[]; waiting: boolean; closed: boolean } {
  const watched = TOPIC_RULES.filter((rule) => rule.pattern.test(instruction)).flatMap(
    (rule) => rule.reasons,
  );
  const matched = watched.filter((reason) => decision.reasons.includes(reason));
  if (!marketOpen && matched.length === 0) {
    return { matched: [], waiting: true, closed: true };
  }
  if (watched.length === 0 || matched.length === 0) {
    return { matched: [], waiting: true, closed: false };
  }
  return { matched, waiting: false, closed: false };
}
