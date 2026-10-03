/**
 * Layered market monitor. Layer 1 is deterministic. Unchanged gold does not
 * request specialist work. Notifications are deduped and cooled down.
 */

export interface Observation {
  candleTime: number | null;
  price: number | null;
  session: string;
  marketOpen: boolean;
  atr: number | null;
  structureEventKey: string | null;
  /** Latest closed-candle sweep. Absent on observations stored before sweeps. */
  sweepKey?: string | null;
  /** Nearest high-impact calendar key. Absent on observations stored before the calendar. */
  macroEventKey?: string | null;
  /** Latest gold-headline set. Null means the feed is unknown, not quiet. */
  headlineKey?: string | null;
  recommendationFingerprint: string;
}

export interface MonitorDecision {
  material: boolean;
  reasons: string[];
  deepAnalysis: boolean;
  notificationKeys: string[];
}

const PRICE_MOVE_FRACTION = 0.0015;

export function decideMonitorAction(
  previous: Observation | null,
  next: Observation,
): MonitorDecision {
  if (!next.marketOpen) {
    const sessionChanged = previous != null && previous.session !== next.session;
    const macro = macroAlert(previous, next);
    const headlines = headlineAlert(previous, next);
    const reasons = [
      ...(sessionChanged ? ["session_transition_while_closed"] : []),
      ...(macro ? ["macro_event"] : []),
      ...(headlines ? ["headline_change"] : []),
    ];
    return {
      material: reasons.length > 0,
      reasons: reasons.length > 0 ? reasons : ["market_closed"],
      deepAnalysis: macro || headlines,
      notificationKeys: [
        ...(sessionChanged ? [`session:${next.session}:closed`] : []),
        ...(macro ? [`macro_event:${next.macroEventKey}`] : []),
        ...(headlines ? [`headline:${next.headlineKey}`] : []),
      ],
    };
  }
  if (!previous) {
    const macro = macroAlert(null, next);
    const headlines = headlineAlert(null, next);
    const reasons = [
      "baseline",
      ...(macro ? ["macro_event"] : []),
      ...(headlines ? ["headline_change"] : []),
    ];
    return {
      material: macro || headlines,
      reasons,
      deepAnalysis: macro || headlines,
      notificationKeys: [
        ...(macro ? [`macro_event:${next.macroEventKey}`] : []),
        ...(headlines ? [`headline:${next.headlineKey}`] : []),
      ],
    };
  }
  const reasons: string[] = [];
  if (next.candleTime != null && next.candleTime !== previous.candleTime) {
    reasons.push("new_candle");
  }
  if (
    previous.price != null &&
    next.price != null &&
    previous.price > 0 &&
    Math.abs(next.price - previous.price) / previous.price >= PRICE_MOVE_FRACTION
  ) {
    reasons.push("price_move");
  }
  if (previous.session !== next.session) {
    reasons.push("session_transition");
  }
  if (
    previous.atr != null &&
    next.atr != null &&
    previous.atr > 0 &&
    next.atr / previous.atr >= 1.5
  ) {
    reasons.push("volatility_change");
  }
  if (next.structureEventKey && next.structureEventKey !== previous.structureEventKey) {
    reasons.push("structure_change");
  }
  const nextSweep = next.sweepKey ?? null;
  if (nextSweep && nextSweep !== "none" && nextSweep !== (previous.sweepKey ?? null)) {
    reasons.push("liquidity_sweep");
  }
  if (next.recommendationFingerprint !== previous.recommendationFingerprint) {
    reasons.push("recommendation_change");
  }
  if (macroAlert(previous, next)) {
    reasons.push("macro_event");
  }
  if (headlineAlert(previous, next)) {
    reasons.push("headline_change");
  }
  const meaningful = reasons.some((reason) =>
    [
      "price_move",
      "session_transition",
      "volatility_change",
      "structure_change",
      "recommendation_change",
      "liquidity_sweep",
      "macro_event",
      "headline_change",
    ].includes(reason),
  );
  const deepAnalysis = reasons.some((reason) =>
    [
      "structure_change",
      "recommendation_change",
      "volatility_change",
      "liquidity_sweep",
      "macro_event",
      "headline_change",
    ].includes(reason),
  );
  return {
    material: meaningful,
    reasons: reasons.length > 0 ? reasons : ["unchanged"],
    deepAnalysis,
    notificationKeys: meaningful
      ? reasons.map((reason) =>
          reason === "macro_event"
            ? `macro_event:${next.macroEventKey}`
            : reason === "headline_change"
              ? `headline:${next.headlineKey}`
              : `${reason}:${next.candleTime ?? "none"}:${next.structureEventKey ?? ""}`,
        )
      : [],
  };
}

function macroAlert(previous: Observation | null, next: Observation): boolean {
  const key = next.macroEventKey ?? null;
  if (!key || key === "none") {
    return false;
  }
  return key !== (previous?.macroEventKey ?? null);
}

function headlineAlert(previous: Observation | null, next: Observation): boolean {
  const key = next.headlineKey ?? null;
  if (!key || key === "none") {
    return false;
  }
  return key !== (previous?.headlineKey ?? null);
}

export interface NoticeRecord {
  key: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastAttemptAt: number | null;
  cooldownUntil: number;
}

export function shouldNotify(record: NoticeRecord | null, now: number): boolean {
  if (!record) {
    return true;
  }
  if (now < record.cooldownUntil) {
    return false;
  }
  if (
    record.status === "pending" &&
    record.lastAttemptAt != null &&
    now - record.lastAttemptAt < 60_000
  ) {
    return false;
  }
  return record.status !== "delivered" || now >= record.cooldownUntil;
}

export function nextNotice(
  record: NoticeRecord | null,
  key: string,
  now: number,
  delivered: boolean,
  cooldownMs = 15 * 60_000,
): NoticeRecord {
  const attempts = (record?.attempts ?? 0) + 1;
  const retryMs = Math.min(cooldownMs, 60_000 * attempts);
  return {
    key,
    status: delivered ? "delivered" : "failed",
    attempts,
    lastAttemptAt: now,
    cooldownUntil: delivered ? now + cooldownMs : now + retryMs,
  };
}
