/**
 * Structured activation rules. A conditional plan fills only when this rule
 * says the stated condition is satisfied. A malformed rule stays inert.
 * Ported from Boty's pure evaluator. No database and no network.
 */
import type { OwnerLanguage } from "./owner.js";

export interface ActivationCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ActivationDirection = "above" | "below";

type RuleBase = {
  timeframe?: string;
  expiresAt?: number;
  tolerance?: number;
};

export type PriceTouchRule = RuleBase & {
  kind: "price_touch";
  level: number;
  direction?: ActivationDirection;
};

export type CloseRule = RuleBase & {
  kind: "candle_close_above" | "candle_close_below";
  level: number;
  closes?: number;
};

export type BreakoutRule = RuleBase & {
  kind: "breakout_confirmed";
  level: number;
  direction: ActivationDirection;
  closes?: number;
};

export type RetestRule = RuleBase & {
  kind: "retest_confirmed";
  level: number;
  direction: ActivationDirection;
  retestZone: { low: number; high: number };
  closes?: number;
};

export type RejectionRule = RuleBase & {
  kind: "rejection_confirmed";
  level: number;
  direction: ActivationDirection;
};

export type LeafActivationRule =
  | PriceTouchRule
  | CloseRule
  | BreakoutRule
  | RetestRule
  | RejectionRule;

export type CompositeRule = {
  kind: "composite";
  operator: "all" | "any";
  rules: LeafActivationRule[];
  expiresAt?: number;
};

export type ActivationRule = LeafActivationRule | CompositeRule;

export interface ActivationEvidence {
  kind: ActivationRule["kind"];
  at: number;
  close: number;
  high: number;
  low: number;
  detail: string;
}

export interface ActivationObservation {
  activated: boolean;
  evidence?: ActivationEvidence;
}

const KINDS = new Set([
  "price_touch",
  "candle_close_above",
  "candle_close_below",
  "breakout_confirmed",
  "retest_confirmed",
  "rejection_confirmed",
  "composite",
]);

export function parseActivationRule(raw: unknown): ActivationRule | null {
  if (raw == null) {
    return null;
  }
  let candidate = raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return null;
    }
    try {
      candidate = JSON.parse(trimmed) as unknown;
    } catch {
      return null;
    }
  }
  return parseRule(candidate);
}

export function serializeActivationRule(rule: ActivationRule): string {
  return JSON.stringify(rule);
}

export function normalizeActivationRule(
  rule: ActivationRule,
  planTimeframe: string,
  instrumentTolerance?: number | null,
): ActivationRule {
  const timeframe = planTimeframe.trim();
  const tolerance =
    typeof instrumentTolerance === "number" &&
    Number.isFinite(instrumentTolerance) &&
    instrumentTolerance > 0
      ? instrumentTolerance
      : null;
  const fill = <T extends LeafActivationRule>(leaf: T): T => {
    const withTimeframe = leaf.timeframe ? leaf : { ...leaf, timeframe };
    return tolerance != null && withTimeframe.tolerance == null
      ? { ...withTimeframe, tolerance }
      : withTimeframe;
  };
  if (rule.kind === "composite") {
    return { ...rule, rules: rule.rules.map(fill) };
  }
  return fill(rule);
}

export function activationRuleTimeframe(rule: ActivationRule): string | null {
  if (rule.kind !== "composite") {
    return rule.timeframe ?? null;
  }
  const frames = new Set(rule.rules.map((leaf) => (leaf.timeframe ?? "").trim()).filter(Boolean));
  return frames.size === 1 ? [...frames][0]! : null;
}

export function activationRequiresClose(rule: ActivationRule): boolean {
  const leaves = rule.kind === "composite" ? rule.rules : [rule];
  return leaves.some(
    (leaf) =>
      leaf.kind === "candle_close_above" ||
      leaf.kind === "candle_close_below" ||
      leaf.kind === "breakout_confirmed" ||
      leaf.kind === "rejection_confirmed",
  );
}

function closedBeyond(
  candle: ActivationCandle,
  level: number,
  direction: ActivationDirection,
  tolerance: number,
): boolean {
  return direction === "above"
    ? candle.close > level + tolerance
    : candle.close < level - tolerance;
}

function touched(
  candle: ActivationCandle,
  level: number,
  direction: ActivationDirection,
  tolerance: number,
): boolean {
  return direction === "above" ? candle.high >= level - tolerance : candle.low <= level + tolerance;
}

interface LeafState {
  streak: number;
  broke: boolean;
  returned: boolean;
  satisfied: boolean;
  evidence?: ActivationEvidence;
}

function observeLeaf(
  rule: LeafActivationRule,
  state: LeafState,
  candle: ActivationCandle,
  language: OwnerLanguage,
): void {
  if (state.satisfied) {
    return;
  }
  const tolerance = rule.tolerance ?? 0;
  const required = "closes" in rule ? (rule.closes ?? 1) : 1;
  const satisfy = (detail: string) => {
    state.satisfied = true;
    state.evidence = {
      kind: rule.kind,
      at: candle.time,
      close: candle.close,
      high: candle.high,
      low: candle.low,
      detail,
    };
  };

  switch (rule.kind) {
    case "price_touch": {
      const hit = rule.direction
        ? touched(candle, rule.level, rule.direction, tolerance)
        : candle.low <= rule.level + tolerance && candle.high >= rule.level - tolerance;
      if (hit) {
        satisfy(touchDetail(language, rule.level, rule.direction));
      }
      return;
    }
    case "candle_close_above":
    case "candle_close_below": {
      const direction: ActivationDirection = rule.kind === "candle_close_above" ? "above" : "below";
      if (closedBeyond(candle, rule.level, direction, tolerance)) {
        state.streak += 1;
        if (state.streak >= required) {
          satisfy(closeDetail(language, state.streak, direction, rule.level, rule.timeframe));
        }
      } else {
        state.streak = 0;
      }
      return;
    }
    case "breakout_confirmed": {
      if (closedBeyond(candle, rule.level, rule.direction, tolerance)) {
        state.streak += 1;
        if (state.streak >= required) {
          satisfy(
            breakoutDetail(language, state.streak, rule.direction, rule.level, rule.timeframe),
          );
        }
      } else {
        state.streak = 0;
      }
      return;
    }
    case "retest_confirmed": {
      if (!state.broke) {
        if (closedBeyond(candle, rule.level, rule.direction, tolerance)) {
          state.broke = true;
        }
        return;
      }
      if (!state.returned) {
        const zone = rule.retestZone;
        if (
          (candle.low >= zone.low && candle.low <= zone.high) ||
          (candle.high >= zone.low && candle.high <= zone.high)
        ) {
          state.returned = true;
        }
        return;
      }
      if (closedBeyond(candle, rule.level, rule.direction, tolerance)) {
        state.streak += 1;
        if (state.streak >= required) {
          satisfy(retestDetail(language, rule.level, rule.direction));
        }
      } else {
        state.streak = 0;
      }
      return;
    }
    case "rejection_confirmed": {
      const pierced =
        rule.direction === "above"
          ? candle.low <= rule.level + tolerance
          : candle.high >= rule.level - tolerance;
      const closedBack = closedBeyond(candle, rule.level, rule.direction, tolerance);
      if (pierced && closedBack) {
        satisfy(rejectionDetail(language, rule.level, rule.direction));
      }
    }
  }
}

export interface ActivationEvaluator {
  observe(candle: ActivationCandle): ActivationObservation;
  readonly activated: boolean;
  readonly evidence?: ActivationEvidence;
}

export function createActivationEvaluator(
  rule: ActivationRule,
  language: OwnerLanguage = "en",
): ActivationEvaluator {
  const leaves = rule.kind === "composite" ? [...rule.rules] : [rule];
  const states = leaves.map(() => ({
    streak: 0,
    broke: false,
    returned: false,
    satisfied: false,
  }));
  let activated = false;
  let evidence: ActivationEvidence | undefined;
  const expiresAt = rule.expiresAt;

  return {
    observe(candle) {
      if (activated) {
        return { activated: true, evidence };
      }
      if (expiresAt != null && candle.time > expiresAt) {
        return { activated: false };
      }
      for (let index = 0; index < leaves.length; index += 1) {
        observeLeaf(leaves[index]!, states[index]!, candle, language);
      }
      const satisfiedCount = states.filter((state) => state.satisfied).length;
      const done =
        rule.kind === "composite"
          ? rule.operator === "all"
            ? satisfiedCount === leaves.length
            : satisfiedCount > 0
          : satisfiedCount === 1;
      if (!done) {
        return { activated: false };
      }
      activated = true;
      const source = states.find((state) => state.satisfied)?.evidence;
      evidence =
        rule.kind === "composite" && source
          ? {
              ...source,
              kind: "composite",
              detail: compositeDetail(
                language,
                rule.operator,
                states.flatMap((state) => (state.evidence ? [state.evidence.detail] : [])),
              ),
            }
          : source;
      return { activated: true, evidence };
    },
    get activated() {
      return activated;
    },
    get evidence() {
      return evidence;
    },
  };
}

export function evaluateActivationRule(
  rule: ActivationRule,
  candles: readonly ActivationCandle[],
  language: OwnerLanguage = "en",
): ActivationObservation {
  const evaluator = createActivationEvaluator(rule, language);
  for (const candle of candles) {
    const observation = evaluator.observe(candle);
    if (observation.activated) {
      return observation;
    }
  }
  return { activated: false };
}

export function explainActivationRuleIncoherence(input: {
  rule: ActivationRule;
  direction: "buy" | "sell";
  currentPrice: number;
  tolerance?: number;
}): string | null {
  const { rule, direction, currentPrice } = input;
  const tolerance = Math.max(input.tolerance ?? 0, 0);
  const leaves = rule.kind === "composite" ? rule.rules : [rule];
  for (const leaf of leaves) {
    const leafTolerance = "tolerance" in leaf ? (leaf.tolerance ?? 0) : 0;
    switch (leaf.kind) {
      case "candle_close_above":
        if (currentPrice > leaf.level + leafTolerance + tolerance) {
          return `activationRule candle_close_above(${formatPrice(leaf.level)}) is already satisfied — current price ${formatPrice(currentPrice)} is above the level, so the plan would activate on the next candle with no real condition. Either raise the level to a future trigger or use an immediate plan.`;
        }
        break;
      case "candle_close_below":
        if (currentPrice < leaf.level - leafTolerance - tolerance) {
          return `activationRule candle_close_below(${formatPrice(leaf.level)}) is already satisfied — current price ${formatPrice(currentPrice)} is below the level, so the plan would activate on the next candle with no real condition. Either lower the level to a future trigger or use an immediate plan.`;
        }
        break;
      case "breakout_confirmed": {
        const required = direction === "buy" ? "above" : "below";
        if (leaf.direction !== required) {
          return `activationRule breakout_confirmed.direction:"${leaf.direction}" contradicts a ${direction} plan — a breakout arming a ${direction} must be direction:"${required}".`;
        }
        const satisfied =
          leaf.direction === "above"
            ? currentPrice > leaf.level + leafTolerance + tolerance
            : currentPrice < leaf.level - leafTolerance - tolerance;
        if (satisfied) {
          return `activationRule breakout_confirmed(${formatPrice(leaf.level)}, ${leaf.direction}) is already satisfied at current price ${formatPrice(currentPrice)} — pick a future level or use an immediate plan.`;
        }
        break;
      }
      case "rejection_confirmed": {
        const wrongSide =
          leaf.direction === "below"
            ? currentPrice > leaf.level + leafTolerance + tolerance
            : currentPrice < leaf.level - leafTolerance - tolerance;
        if (wrongSide) {
          return `activationRule rejection_confirmed(${formatPrice(leaf.level)}, close ${leaf.direction}) expects price to approach the level from the "${leaf.direction}" side, but current price ${formatPrice(currentPrice)} is already beyond it — the stored rule would grade a plain break, not the rejection. Move the level or restate the condition as a close.`;
        }
        break;
      }
      case "retest_confirmed": {
        const alreadyBroken =
          leaf.direction === "above"
            ? currentPrice > leaf.level + leafTolerance + tolerance
            : currentPrice < leaf.level - leafTolerance - tolerance;
        if (
          alreadyBroken &&
          (leaf.direction === "above"
            ? leaf.retestZone.low > currentPrice
            : leaf.retestZone.high < currentPrice)
        ) {
          return `activationRule retest_confirmed(${formatPrice(leaf.level)}) has a retestZone price cannot return to from ${formatPrice(currentPrice)} — the zone must sit between the current price and the broken level.`;
        }
        break;
      }
      default:
        break;
    }
  }
  return null;
}

export function describeActivationRule(
  rule: ActivationRule,
  language: OwnerLanguage = "en",
): string {
  if (rule.kind === "composite") {
    const joiner =
      language === "ar"
        ? rule.operator === "all"
          ? " و"
          : " أو"
        : rule.operator === "all"
          ? " and "
          : " or ";
    return rule.rules.map((leaf) => describeActivationRule(leaf, language)).join(joiner);
  }
  const level = formatPrice(rule.level);
  const timeframe = rule.timeframe ?? (language === "ar" ? "الإطار المعتمد" : "the plan timeframe");
  switch (rule.kind) {
    case "price_touch":
      return language === "ar" ? `لمس السعر مستوى ${level}` : `Price touches ${level}`;
    case "candle_close_above":
      return closeSentence(language, rule.closes, "above", level, timeframe);
    case "candle_close_below":
      return closeSentence(language, rule.closes, "below", level, timeframe);
    case "breakout_confirmed":
      return language === "ar"
        ? `اختراق مستوى ${level} ${rule.direction === "above" ? "صعوداً" : "هبوطاً"} مع ${closeSentence(language, rule.closes, rule.direction, level, timeframe)}`
        : `Break ${level} ${rule.direction}, then ${closeSentence(language, rule.closes, rule.direction, level, timeframe)}`;
    case "retest_confirmed":
      return language === "ar"
        ? `اختراق مستوى ${level} ثم عودة السعر لإعادة اختباره بين ${formatPrice(rule.retestZone.low)} و${formatPrice(rule.retestZone.high)} ثم إغلاق شمعة ${timeframe} ${rule.direction === "above" ? "فوق" : "تحت"} المستوى`
        : `Break ${level}, return between ${formatPrice(rule.retestZone.low)} and ${formatPrice(rule.retestZone.high)}, then close ${rule.direction} it on ${timeframe}`;
    case "rejection_confirmed":
      return language === "ar"
        ? `وصول السعر إلى مستوى ${level} ثم رفضه: اختراق المستوى بالذيل وإغلاق شمعة ${timeframe} ${rule.direction === "above" ? "فوقه" : "تحته"}`
        : `Price reaches ${level} and rejects: a wick through the level and a ${timeframe} close ${rule.direction} it`;
  }
}

function parseRule(value: unknown): ActivationRule | null {
  if (!isRecord(value) || typeof value.kind !== "string" || !KINDS.has(value.kind)) {
    return null;
  }
  if (value.kind === "composite") {
    return parseComposite(value);
  }
  return parseLeaf(value);
}

function parseComposite(value: Record<string, unknown>): CompositeRule | null {
  if (value.operator !== "all" && value.operator !== "any") {
    return null;
  }
  if (!Array.isArray(value.rules) || value.rules.length < 2 || value.rules.length > 4) {
    return null;
  }
  const rules: LeafActivationRule[] = [];
  for (const item of value.rules) {
    const leaf = parseLeaf(item);
    if (!leaf) {
      return null;
    }
    rules.push(leaf);
  }
  const expiresAt = optionalExpiry(value.expiresAt);
  if (expiresAt === "invalid") {
    return null;
  }
  return {
    kind: "composite",
    operator: value.operator,
    rules,
    ...(expiresAt ? { expiresAt } : {}),
  };
}

function parseLeaf(value: unknown): LeafActivationRule | null {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return null;
  }
  const level = positive(value.level);
  const base = optionalBase(value);
  if (level == null || !base) {
    return null;
  }
  const direction = value.direction;
  const hasDirection = direction === "above" || direction === "below";
  switch (value.kind) {
    case "price_touch":
      if (direction != null && !hasDirection) {
        return null;
      }
      return { kind: "price_touch", level, ...base, ...(hasDirection ? { direction } : {}) };
    case "candle_close_above":
    case "candle_close_below":
      return { kind: value.kind, level, ...base, ...optionalCloses(value.closes) };
    case "breakout_confirmed":
      return hasDirection
        ? { kind: "breakout_confirmed", level, direction, ...base, ...optionalCloses(value.closes) }
        : null;
    case "rejection_confirmed":
      return hasDirection ? { kind: "rejection_confirmed", level, direction, ...base } : null;
    case "retest_confirmed": {
      const zone = parseZone(value.retestZone);
      return hasDirection && zone
        ? {
            kind: "retest_confirmed",
            level,
            direction,
            retestZone: zone,
            ...base,
            ...optionalCloses(value.closes),
          }
        : null;
    }
    default:
      return null;
  }
}

function optionalBase(value: Record<string, unknown>): RuleBase | null {
  const timeframe = optionalTimeframe(value.timeframe);
  const tolerance = optionalTolerance(value.tolerance);
  const expiresAt = optionalExpiry(value.expiresAt);
  const closes = value.closes == null ? null : optionalCloses(value.closes);
  if (!timeframe || tolerance === "invalid" || expiresAt === "invalid" || closes === "invalid") {
    return null;
  }
  return {
    ...(timeframe === "absent" ? {} : { timeframe }),
    ...(tolerance == null ? {} : { tolerance }),
    ...(expiresAt == null ? {} : { expiresAt }),
  };
}

function optionalCloses(value: unknown): { closes?: number } | "invalid" {
  if (value == null) {
    return {};
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10) {
    return "invalid";
  }
  return { closes: value };
}

function optionalTimeframe(value: unknown): string | "absent" | null {
  if (value == null) {
    return "absent";
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 8 ? trimmed : null;
}

function optionalTolerance(value: unknown): number | null | "invalid" {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "invalid";
  }
  return value;
}

function optionalExpiry(value: unknown): number | null | "invalid" {
  if (value == null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return "invalid";
  }
  return value;
}

function parseZone(value: unknown): { low: number; high: number } | null {
  if (!isRecord(value)) {
    return null;
  }
  const low = positive(value.low);
  const high = positive(value.high);
  return low != null && high != null && high >= low ? { low, high } : null;
}

function positive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function formatPrice(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(5).replace(/0+$/, "");
}

function sideWord(language: OwnerLanguage, direction: ActivationDirection): string {
  if (language === "ar") {
    return direction === "above" ? "فوق" : "تحت";
  }
  return direction;
}

function touchDetail(
  language: OwnerLanguage,
  level: number,
  direction?: ActivationDirection,
): string {
  const price = formatPrice(level);
  if (language === "ar") {
    return direction ? `لمس السعر ${price} (${direction})` : `لمس السعر ${price}`;
  }
  return direction ? `Price touched ${price} (${direction})` : `Price touched ${price}`;
}

function closeDetail(
  language: OwnerLanguage,
  streak: number,
  direction: ActivationDirection,
  level: number,
  timeframe?: string,
): string {
  const price = formatPrice(level);
  const frame = timeframe ?? "";
  if (language === "ar") {
    return `${streak} إغلاق ${sideWord(language, direction)} ${price} على ${frame}`;
  }
  return `${streak} close ${sideWord(language, direction)} ${price} on ${frame}`;
}

function breakoutDetail(
  language: OwnerLanguage,
  streak: number,
  direction: ActivationDirection,
  level: number,
  timeframe?: string,
): string {
  const price = formatPrice(level);
  if (language === "ar") {
    return `كسر مؤكد بإغلاق ${streak} شمعة ${sideWord(language, direction)} ${price} على ${timeframe ?? ""}`;
  }
  return `Confirmed break: ${streak} candle close ${direction} ${price} on ${timeframe ?? ""}`;
}

function retestDetail(
  language: OwnerLanguage,
  level: number,
  direction: ActivationDirection,
): string {
  const price = formatPrice(level);
  if (language === "ar") {
    return `إعادة اختبار مؤكدة: كسر ${price} ثم عودة إلى النطاق ثم إغلاق ${sideWord(language, direction)} المستوى`;
  }
  return `Confirmed retest: broke ${price}, returned to the zone, then closed ${direction} the level`;
}

function rejectionDetail(
  language: OwnerLanguage,
  level: number,
  direction: ActivationDirection,
): string {
  const price = formatPrice(level);
  if (language === "ar") {
    return `ارتداد مؤكد عن ${price}: اخترق الفتيل وأغلق ${direction === "above" ? "فوقه" : "تحته"}`;
  }
  return `Confirmed rejection of ${price}: the wick pierced and the candle closed ${direction} it`;
}

function compositeDetail(
  language: OwnerLanguage,
  operator: "all" | "any",
  details: string[],
): string {
  if (language === "ar") {
    return `شرط مركّب (${operator}): ${details.join(" + ")}`;
  }
  return `Composite (${operator}): ${details.join(" + ")}`;
}

function closeSentence(
  language: OwnerLanguage,
  closes: number | undefined,
  direction: ActivationDirection,
  level: string,
  timeframe: string,
): string {
  const count = closes ?? 1;
  if (language === "ar") {
    return count <= 1
      ? `إغلاق شمعة ${timeframe} ${sideWord(language, direction)} ${level}`
      : `إغلاق ${count} شموع ${timeframe} متتالية ${sideWord(language, direction)} ${level}`;
  }
  return count <= 1
    ? `a ${timeframe} close ${direction} ${level}`
    : `${count} consecutive ${timeframe} closes ${direction} ${level}`;
}
