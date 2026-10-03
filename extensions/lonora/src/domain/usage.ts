/** Estimated provider prices in USD per million tokens. Estimates are labeled. */
const PRICE_PER_MILLION: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4-5": { input: 3, output: 15 },
  "anthropic/claude-opus-4-1": { input: 15, output: 75 },
  "openai/gpt-5": { input: 5, output: 15 },
  "openai/gpt-4.1": { input: 2, output: 8 },
  "zai/glm-4.5": { input: 0.6, output: 2.2 },
  "openrouter/auto": { input: 1, output: 3 },
};

export type UsageFeature =
  | "conversation"
  | "market_monitoring"
  | "research"
  | "deep_analysis"
  | "subagent";

export interface UsageEvent {
  id: string;
  at: number;
  provider: string;
  model: string;
  feature: UsageFeature;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
}

export function estimateCostUsd(event: Pick<UsageEvent, "provider" | "model" | "inputTokens" | "outputTokens">): {
  usd: number | null;
  estimated: boolean;
} {
  const key = `${event.provider}/${event.model}`;
  const price =
    PRICE_PER_MILLION[key] ??
    PRICE_PER_MILLION[`${event.provider}/auto`] ??
    null;
  if (!price) {
    return { usd: null, estimated: true };
  }
  const usd = (event.inputTokens * price.input + event.outputTokens * price.output) / 1_000_000;
  return { usd, estimated: true };
}

export interface UsageRollup {
  costTodayUsd: number | null;
  costMonthUsd: number | null;
  tokensToday: number;
  tokensMonth: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  byFeature: Record<string, number>;
  byAgent: Record<string, number>;
  unpricedEvents: number;
  estimated: true;
}

export function rollupUsage(events: UsageEvent[], now: number): UsageRollup {
  const dayStart = startOfUtcDay(now);
  const monthStart = startOfUtcMonth(now);
  const rollup: UsageRollup = {
    costTodayUsd: 0,
    costMonthUsd: 0,
    tokensToday: 0,
    tokensMonth: 0,
    byProvider: {},
    byModel: {},
    byFeature: {},
    byAgent: {},
    unpricedEvents: 0,
    estimated: true,
  };
  for (const event of events) {
    const tokens = event.inputTokens + event.outputTokens;
    const cost = estimateCostUsd(event);
    if (event.at >= monthStart) {
      rollup.tokensMonth += tokens;
      if (cost.usd == null) {
        rollup.unpricedEvents += 1;
        rollup.costMonthUsd = rollup.costMonthUsd;
      } else {
        rollup.costMonthUsd = (rollup.costMonthUsd ?? 0) + cost.usd;
      }
      add(rollup.byProvider, event.provider, cost.usd ?? 0);
      add(rollup.byModel, event.model, cost.usd ?? 0);
      add(rollup.byFeature, event.feature, cost.usd ?? 0);
      add(rollup.byAgent, event.agent, cost.usd ?? 0);
    }
    if (event.at >= dayStart) {
      rollup.tokensToday += tokens;
      if (cost.usd != null) {
        rollup.costTodayUsd = (rollup.costTodayUsd ?? 0) + cost.usd;
      }
    }
  }
  return rollup;
}

export function classifyFeature(input: { sessionKey?: string; jobId?: string }): UsageFeature {
  const key = input.sessionKey ?? "";
  if (input.jobId || key.includes(":cron:")) {
    return "market_monitoring";
  }
  if (key.includes(":subagent:")) {
    return "subagent";
  }
  if (key.includes(":research:")) {
    return "research";
  }
  return "conversation";
}

function add(bucket: Record<string, number>, key: string, amount: number) {
  bucket[key] = (bucket[key] ?? 0) + amount;
}

function startOfUtcDay(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function startOfUtcMonth(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
}

export function featureFromText(text: string): UsageFeature {
  const value = text.toLowerCase();
  if (value.includes("research")) {
    return "research";
  }
  if (value.includes("deep")) {
    return "deep_analysis";
  }
  return "conversation";
}
