import { randomUUID } from "node:crypto";
import { describeActivationRule, parseActivationRule } from "./domain/activation-rule.js";
import {
  assertDelegation,
  runSpecialist,
  runStructureAnalyst,
  SPECIALISTS,
  type SpecialistId,
} from "./domain/agents.js";
import {
  describeCalendarEvents,
  readGoldCalendar,
  upcomingHighImpactKey,
  type CalendarRead,
  type EconomicEvent,
} from "./domain/calendar.js";
import { calculateAtr, isGoldSymbol, isSaneCandle, type Candle } from "./domain/candles.js";
import { indexCandleCases, findSimilarCases } from "./domain/cases.js";
import { copy, marketReasonCopy } from "./domain/copy.js";
import {
  describeHeadlines,
  headlineSetKey,
  readGoldHeadlines,
  type HeadlineRead,
  type NewsHeadline,
} from "./domain/headlines.js";
import { analyzeLiquidity, sweepKey } from "./domain/liquidity-sweeps.js";
import { GOLD_BAR_MS, readGoldCandles } from "./domain/market-data.js";
import { candlesVisibleAt, readMarketClock } from "./domain/market.js";
import {
  decideMonitorAction,
  nextNotice,
  shouldNotify,
  type Observation,
} from "./domain/monitor.js";
import { bindTelegram, type OwnerLanguage } from "./domain/owner.js";
import { assertPermission, authorizeTrade } from "./domain/permissions.js";
import { prepareGoldPlan } from "./domain/plan.js";
import { isLonoraProvider, probeProvider, type LonoraProviderId } from "./domain/providers.js";
import { evaluateRecommendation, type RecommendationPlan } from "./domain/recommendations.js";
import { checkResponsibility } from "./domain/responsibilities.js";
import { summarizeScenario } from "./domain/scenario.js";
import {
  classifyFeature,
  dailyBudgetAllows,
  rollupUsage,
  type UsageEvent,
} from "./domain/usage.js";
import { LonoraStore, type MemoryKind, type ResponsibilityRow } from "./store.js";

const DELEGATION_WINDOW_MS = 60_000;

export class LonoraService {
  dailyBudgetUsd: number | null = null;
  private lastDataStatus = "unknown";
  private lastAssessment: string | null = null;
  private lastDataError: string | null = null;
  private lastCalendar: { known: boolean; summary: string | null } = {
    known: false,
    summary: null,
  };
  private lastHeadlines: { known: boolean; summary: string | null } = {
    known: false,
    summary: null,
  };
  private activeMonitor: Promise<unknown> | null = null;
  private deliverNotice:
    | ((input: { chatId: string; text: string; key: string }) => Promise<boolean>)
    | null = null;

  setNoticeDelivery(
    deliver: (input: { chatId: string; text: string; key: string }) => Promise<boolean>,
  ) {
    this.deliverNotice = deliver;
  }

  constructor(readonly store: LonoraStore) {}

  ownerStatus() {
    const owner = this.store.ensureLocalOwner();
    return {
      id: owner.id,
      label: owner.label,
      language: owner.language,
      telegramBound: Boolean(owner.telegramChatId),
      running: true,
    };
  }

  bindTelegram(chatId: string) {
    const owner = this.store.ensureLocalOwner();
    const bound = bindTelegram(owner, chatId);
    if (!bound.ok) {
      return bound;
    }
    this.store.insertOwner(bound.owner);
    return { ok: true as const };
  }

  marketSnapshot(now = Date.now()) {
    const owner = this.store.ensureLocalOwner();
    const clock = readMarketClock(now);
    const observation = this.store.getObservation<Observation>();
    return {
      symbol: "XAUUSD",
      clock,
      message: marketReasonCopy(owner.language, clock.reason),
      lastPrice: observation?.price ?? null,
      stale:
        !clock.isOpen || this.lastDataStatus === "stale" || this.lastDataStatus === "unavailable",
      invented: false,
      dataStatus: clock.isOpen ? this.lastDataStatus : "closed",
      dataError: this.lastDataError,
      assessment: this.lastAssessment,
      calendar: this.lastCalendar,
      headlines: this.lastHeadlines,
      recommendations: this.store
        .listRecommendations()
        .filter((plan) => plan.outcome === "pending"),
      responsibilities: this.store.listResponsibilities().filter((row) => row.status === "running"),
    };
  }

  observe(next: Observation) {
    const previous = this.store.getObservation<Observation>();
    const decision = decideMonitorAction(previous, next);
    if (!next.marketOpen) {
      this.store.saveObservation({ ...next, price: previous?.price ?? next.price });
    } else {
      this.store.saveObservation(next);
    }
    const owner = this.store.ensureLocalOwner();
    return {
      decision,
      message: decision.material
        ? decision.reasons.join(", ")
        : copy(owner.language, "notify.unchanged"),
    };
  }

  async publishNotices(
    decision: { notificationKeys: string[]; reasons: string[]; material: boolean },
    now = Date.now(),
  ) {
    const owner = this.store.ensureLocalOwner();
    const text = decision.material
      ? decision.reasons.join(", ")
      : copy(owner.language, "notify.unchanged");
    const notices = [];
    for (const key of decision.notificationKeys) {
      const existing = this.store.getNotice(key);
      if (!shouldNotify(existing, now)) {
        continue;
      }
      let delivered = false;
      let payload = text;
      if (!owner.telegramChatId) {
        payload = copy(owner.language, "notify.telegramMissing");
      } else if (!this.deliverNotice) {
        payload = copy(owner.language, "notify.deliveryFailed");
      } else {
        try {
          delivered = await this.deliverNotice({
            chatId: owner.telegramChatId,
            text,
            key,
          });
          if (!delivered) {
            payload = copy(owner.language, "notify.deliveryFailed");
          }
        } catch (error) {
          payload =
            error instanceof Error
              ? error.message.slice(0, 180)
              : copy(owner.language, "notify.deliveryFailed");
        }
      }
      const notice = nextNotice(
        existing
          ? {
              key,
              status: existing.status,
              attempts: existing.attempts,
              lastAttemptAt: existing.lastAttemptAt,
              cooldownUntil: existing.cooldownUntil,
            }
          : null,
        key,
        now,
        delivered,
      );
      this.store.saveNotice({ ...notice, payload });
      notices.push(notice);
    }
    return notices;
  }

  readCandles(count?: number) {
    return readGoldCandles(count);
  }

  async readHeadlines(now = Date.now()): Promise<HeadlineRead & { summary: string }> {
    const language = this.store.ensureLocalOwner().language;
    try {
      const read = await readGoldHeadlines({ now });
      const summary = read.ok
        ? describeHeadlines(read.headlines, language)
        : copy(language, "headlines.unavailable");
      this.lastHeadlines = { known: read.ok, summary };
      return { ...read, summary };
    } catch (error) {
      const summary = copy(language, "headlines.unavailable");
      this.lastHeadlines = { known: false, summary };
      return {
        ok: false,
        headlines: [],
        invented: false,
        stale: false,
        summary,
        error: error instanceof Error ? error.message.slice(0, 180) : summary,
      };
    }
  }

  async readCalendar(now = Date.now()): Promise<CalendarRead & { summary: string }> {
    const language = this.store.ensureLocalOwner().language;
    try {
      const read = await readGoldCalendar({ now });
      const summary = calendarSummary(read, language);
      this.lastCalendar = { known: read.ok, summary };
      return { ...read, summary };
    } catch (error) {
      const summary = copy(language, "calendar.unavailable");
      this.lastCalendar = { known: false, summary };
      return {
        ok: false,
        events: [],
        invented: false,
        stale: false,
        summary,
        error: error instanceof Error ? error.message.slice(0, 180) : summary,
      };
    }
  }

  async readVisibleCandles(now = Date.now()) {
    const read = await this.readCandles(48);
    if (!read.ok) {
      return {
        ok: false as const,
        candles: [] as Candle[],
        invented: false as const,
        stale: true,
        error: read.error ?? "Market data is unavailable.",
      };
    }
    const visible = candlesVisibleAt(
      read.candles.filter((candle) => isSaneCandle(candle)),
      now,
      GOLD_BAR_MS,
    );
    const liquidity = analyzeLiquidity(visible.candles);
    return {
      ok: visible.candles.length > 0,
      candles: visible.candles,
      latestSweep: liquidity.latest,
      invented: false as const,
      stale: visible.stale,
      error: visible.candles.length > 0 ? null : "No closed candles are visible.",
    };
  }

  startMonitor(now = Date.now()): Promise<unknown> {
    if (this.activeMonitor) {
      return this.activeMonitor;
    }
    let run!: Promise<unknown>;
    run = this.monitorOnce(now).finally(() => {
      if (this.activeMonitor === run) {
        this.activeMonitor = null;
      }
    });
    this.activeMonitor = run;
    return run;
  }

  get monitorSettled(): Promise<void> {
    return this.activeMonitor?.then(() => undefined) ?? Promise.resolve();
  }

  async monitorOnce(now = Date.now()) {
    const clock = readMarketClock(now);
    const previous = this.store.getObservation<Observation>();
    const [calendar, headlines] = await Promise.all([
      this.readCalendar(now),
      this.readHeadlines(now),
    ]);
    const macroEventKey = calendar.ok
      ? upcomingHighImpactKey(calendar.events, now)
      : (previous?.macroEventKey ?? null);
    const headlineKey = headlines.ok
      ? headlineSetKey(headlines.headlines)
      : (previous?.headlineKey ?? null);
    let price = previous?.price ?? null;
    let candleTime = previous?.candleTime ?? null;
    let atr = previous?.atr ?? null;
    let structureEventKey = previous?.structureEventKey ?? null;
    let sweep = previous?.sweepKey ?? null;
    let candles: Candle[] = [];
    if (!clock.isOpen) {
      this.lastDataStatus = "closed";
      this.lastDataError = null;
    } else {
      const read = await this.readCandles();
      if (!read.ok) {
        this.lastDataStatus = "unavailable";
        this.lastDataError = read.error ?? "Market data is unavailable.";
      } else {
        const visible = candlesVisibleAt(read.candles, now, GOLD_BAR_MS);
        candles = visible.candles as Candle[];
        this.lastDataStatus = visible.stale ? "stale" : "ok";
        this.lastDataError = visible.stale ? "Candle data is stale." : null;
        price = candles.at(-1)?.close ?? null;
        candleTime = candles.at(-1)?.time ?? null;
        atr = calculateAtr(candles);
        const structure = runStructureAnalyst(candles);
        const latest = structure.data.latest as { type?: string; breakCandleTime?: number } | null;
        structureEventKey =
          latest?.type && latest.breakCandleTime
            ? `${latest.type}:${latest.breakCandleTime}`
            : "none";
        sweep = sweepKey(analyzeLiquidity(candles).latest);
        this.gradeRecommendations(candles);
      }
    }
    const observed = this.observe({
      candleTime,
      price,
      session: clock.session,
      marketOpen: clock.isOpen,
      atr,
      structureEventKey,
      sweepKey: sweep,
      macroEventKey,
      headlineKey,
      recommendationFingerprint: this.store
        .listRecommendations()
        .map((plan) => `${plan.id}:${plan.status}:${plan.outcome}`)
        .join("|"),
    });
    await this.publishNotices(observed.decision, now);
    if (observed.decision.deepAnalysis && this.withinBudget(now)) {
      const priceDeep = observed.decision.reasons.some((reason) =>
        [
          "structure_change",
          "recommendation_change",
          "volatility_change",
          "liquidity_sweep",
        ].includes(reason),
      );
      if (priceDeep && candles.length > 0) {
        const agent =
          observed.decision.reasons.includes("liquidity_sweep") &&
          !observed.decision.reasons.includes("structure_change")
            ? "liquidity-analyst"
            : "structure-analyst";
        const result = this.delegate({ agent, candles });
        this.lastAssessment = "summary" in result ? result.summary : null;
      }
      const macroDeep =
        (observed.decision.reasons.includes("macro_event") && calendar.ok) ||
        (observed.decision.reasons.includes("headline_change") && headlines.ok);
      if (macroDeep) {
        const result = this.delegate({
          agent: "macro-news-analyst",
          events: calendar.events,
          calendarKnown: calendar.ok,
          headlines: headlines.headlines,
          headlinesKnown: headlines.ok,
        });
        this.lastAssessment = "summary" in result ? result.summary : this.lastAssessment;
      }
    }
    const language = this.store.getOwner()?.language ?? "en";
    for (const row of this.store.listResponsibilities()) {
      if (row.status !== "running" && row.status !== "scheduled") {
        continue;
      }
      const check = checkResponsibility(row.instruction, observed.decision, clock.isOpen);
      if (row.status === "scheduled" && check.waiting) {
        this.store.saveResponsibility({ ...row, lastCheckAt: now });
        continue;
      }
      const lastEvent = check.closed
        ? copy(language, "tasks.waitingClosed")
        : check.matched.length > 0
          ? `${copy(language, "tasks.matched")} ${check.matched.join(", ")}`
          : copy(language, "tasks.waiting");
      this.store.saveResponsibility({
        ...row,
        lastCheckAt: now,
        nextCheckAt: check.closed ? null : now + 60_000,
        lastEvent,
      });
    }
    return { ...observed, dataStatus: this.lastDataStatus, assessment: this.lastAssessment };
  }

  private withinBudget(now: number) {
    return dailyBudgetAllows({
      budgetUsd: this.dailyBudgetUsd,
      events: this.store.listUsage(),
      now,
    });
  }

  recordMonitorFailure(error: unknown) {
    const message = error instanceof Error ? error.message : "Market monitor failed.";
    this.lastDataStatus = "failed";
    this.lastDataError = message.slice(0, 180);
  }

  listRecommendations() {
    const language = this.store.ensureLocalOwner().language;
    return this.store.listRecommendations().map((plan) => ({
      ...plan,
      activationSummary: activationSummary(plan, language),
    }));
  }

  async prepareRecommendation(now = Date.now()) {
    const language = this.store.ensureLocalOwner().language;
    const read = await this.readVisibleCandles(now);
    if (!read.ok) {
      return {
        ok: false as const,
        reason: "market_unavailable" as const,
        message: read.error ?? "Market data is unavailable.",
        invented: false as const,
        brokerCalled: false as const,
      };
    }
    const prepared = prepareGoldPlan(read.candles, language, now);
    if (!prepared.ok) {
      return prepared;
    }
    this.store.saveRecommendation(prepared.plan);
    return prepared;
  }

  saveRecommendation(plan: RecommendationPlan) {
    if (!isGoldSymbol(plan.symbol)) {
      throw new Error("Lonora recommendations are for XAUUSD.");
    }
    this.store.saveRecommendation(plan);
    return plan;
  }

  async gradeLiveRecommendations(now = Date.now()) {
    const read = await this.readCandles();
    if (!read.ok) {
      return {
        ok: false as const,
        updated: [] as RecommendationPlan[],
        error: read.error ?? "Market data is unavailable.",
      };
    }
    const visible = candlesVisibleAt(read.candles, now, GOLD_BAR_MS);
    const sane = visible.candles.filter((candle) => isSaneCandle(candle));
    return {
      ok: true as const,
      updated: this.gradeRecommendations(sane),
      stale: visible.stale,
    };
  }

  gradeRecommendations(
    candles: { time: number; open: number; high: number; low: number; close: number }[],
  ) {
    const updated = [];
    for (const plan of this.store.listRecommendations()) {
      const evaluation = evaluateRecommendation(plan, candles);
      if (!evaluation.changed && evaluation.outcome === plan.outcome) {
        continue;
      }
      const next: RecommendationPlan = {
        ...plan,
        status: evaluation.status,
        outcome: evaluation.outcome,
        effectiveEntry: evaluation.effectiveEntry,
        triggeredAt: evaluation.triggeredAt,
        tp1HitAt: evaluation.tp1HitAt,
        tp2HitAt: evaluation.tp2HitAt,
        tp3HitAt: evaluation.tp3HitAt,
        activationEvidence: evaluation.activationEvidence ?? plan.activationEvidence,
      };
      this.store.saveRecommendation(next);
      updated.push(next);
    }
    this.refreshScenarioMemory();
    return updated;
  }

  refreshScenarioMemory() {
    const owner = this.store.ensureLocalOwner();
    const summary = summarizeScenario(this.store.listRecommendations(), owner.language);
    this.store.replaceMemory("scenario", "XAUUSD", summary.writable ? summary.text : null);
    return summary;
  }

  async similarHistory(now = Date.now()) {
    const language = this.store.ensureLocalOwner().language;
    const read = await this.readCandles(500);
    if (!read.ok) {
      return {
        ok: false as const,
        indexed: 0,
        matches: 0,
        resolved: 0,
        winRate: null,
        invented: false as const,
        text: read.error ?? copy(language, "cases.insufficient"),
      };
    }
    const visible = candlesVisibleAt(read.candles, now, GOLD_BAR_MS);
    const added = this.store.insertCases(indexCandleCases(visible.candles));
    const report = findSimilarCases(visible.candles, this.store.listCases(), language);
    return { ok: true as const, indexed: added, invented: false as const, ...report };
  }

  async compareSimilarHistory(input?: { enforceDelegation?: boolean; now?: number }) {
    if (input?.enforceDelegation) {
      try {
        assertDelegation({
          depth: 1,
          childCount: this.store.countAgentRunsSince(Date.now() - DELEGATION_WINDOW_MS),
          requested: 1,
          timeoutMs: 20_000,
          tokenBudget: 4_000,
        });
      } catch (error) {
        const text = error instanceof Error ? error.message : "Delegation refused.";
        this.store.recordAgentRun({ agent: "research-agent", status: "failed", summary: text });
        return {
          ok: false as const,
          indexed: 0,
          matches: 0,
          resolved: 0,
          winRate: null,
          invented: false as const,
          brokerCalled: false as const,
          text,
          failure: "delegation_limit" as const,
        };
      }
    }
    const language = this.store.ensureLocalOwner().language;
    const history = await this.similarHistory(input?.now ?? Date.now());
    const scenario = this.refreshScenarioMemory();
    const safe =
      history.winRate != null && history.resolved < 8
        ? {
            matches: history.matches,
            resolved: history.resolved,
            winRate: null,
            text: `${copy(language, "cases.counts")} ${history.matches}/${history.resolved}.`,
          }
        : history;
    const text = [scenario.writable ? scenario.text : "", safe.text]
      .filter((part) => part.trim().length > 0)
      .join(" ");
    const summary = text || copy(language, "cases.insufficient");
    this.store.recordAgentRun({
      agent: "research-agent",
      status: history.ok ? "ok" : "failed",
      summary,
    });
    return {
      ok: history.ok,
      indexed: history.indexed,
      matches: safe.matches,
      resolved: safe.resolved,
      winRate: safe.winRate,
      invented: false as const,
      brokerCalled: false as const,
      text: summary,
    };
  }

  notifyOwner(_key: string, _message: string): never {
    assertPermission({ permission: "NOTIFY", caller: "model", ownerConfirmed: false });
    throw new Error("Model notifications require an owner path outside the model tool.");
  }

  remember(kind: MemoryKind, content: string, symbol?: string) {
    return this.store.addMemory({ kind, content, symbol });
  }

  recall(query: string, kind?: MemoryKind) {
    return this.store.searchMemory(query, kind);
  }

  upsertResponsibility(input: {
    id?: string;
    title: string;
    instruction: string;
    status?: ResponsibilityRow["status"];
    lastEvent?: string | null;
  }): ResponsibilityRow {
    const existing = input.id
      ? this.store.listResponsibilities().find((row) => row.id === input.id)
      : undefined;
    const row: ResponsibilityRow = {
      id: existing?.id ?? input.id ?? randomUUID(),
      title: input.title,
      instruction: input.instruction,
      status: input.status ?? existing?.status ?? "running",
      lastCheckAt: existing?.lastCheckAt ?? null,
      nextCheckAt: existing?.nextCheckAt ?? null,
      lastEvent: input.lastEvent ?? existing?.lastEvent ?? null,
    };
    this.store.saveResponsibility(row);
    return row;
  }

  setResponsibilityStatus(id: string, status: ResponsibilityRow["status"]) {
    const existing = this.store.listResponsibilities().find((row) => row.id === id);
    if (!existing) {
      throw new Error(`No responsibility ${id}.`);
    }
    const next = { ...existing, status };
    this.store.saveResponsibility(next);
    return next;
  }

  delegate(input: {
    agent: SpecialistId;
    candles?: Candle[];
    higher?: Candle[];
    entry?: number;
    stopLoss?: number;
    targets?: number[];
    note?: string;
    events?: EconomicEvent[];
    calendarKnown?: boolean;
    headlines?: NewsHeadline[];
    headlinesKnown?: boolean;
    depth?: number;
    childCount?: number;
    parentRunId?: string;
  }) {
    try {
      assertDelegation({
        depth: input.depth ?? 1,
        childCount:
          input.childCount ?? this.store.countAgentRunsSince(Date.now() - DELEGATION_WINDOW_MS),
        requested: 1,
        timeoutMs: 20_000,
        tokenBudget: 4_000,
      });
    } catch (error) {
      const summary = error instanceof Error ? error.message : "Delegation refused.";
      this.store.recordAgentRun({
        agent: input.agent,
        parentRunId: input.parentRunId,
        status: "failed",
        summary,
      });
      return { ok: false as const, agent: input.agent, summary, failure: "delegation_limit" };
    }
    const scenario = input.agent === "research-agent" ? this.refreshScenarioMemory().text : "";
    const note =
      input.agent === "research-agent"
        ? [scenario, input.note].filter((part) => part && part.trim().length > 0).join(" ")
        : input.note;
    const result = runSpecialist(input.agent, {
      ...input,
      note,
      language: this.store.ensureLocalOwner().language,
    });
    this.store.recordAgentRun({
      agent: input.agent,
      parentRunId: input.parentRunId,
      status: result.ok ? "ok" : "failed",
      summary: result.summary,
    });
    return result;
  }

  agentsView() {
    const runs = this.store.listAgentRuns();
    return SPECIALISTS.map((agent) => {
      const latest = runs.find((run) => run.agent === agent);
      const alwaysOn = agent === "market-watcher" || agent === "system-guardian";
      return {
        agent,
        state: alwaysOn ? "running" : "on_demand",
        purpose: purposeFor(agent),
        lastRunAt: latest?.startedAt ?? null,
        lastResult: latest?.summary ?? null,
        tokens: (latest?.inputTokens ?? 0) + (latest?.outputTokens ?? 0),
      };
    });
  }

  recordModelUsage(input: {
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    sessionKey?: string;
    jobId?: string;
    agent?: string;
  }): UsageEvent {
    const event: UsageEvent = {
      id: randomUUID(),
      at: Date.now(),
      provider: input.provider,
      model: input.model,
      feature: classifyFeature(input),
      agent: input.agent ?? "lonora",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      estimated: true,
    };
    this.store.addUsage(event);
    return event;
  }

  usageSummary(now = Date.now()) {
    return rollupUsage(this.store.listUsage(), now);
  }

  async connectProvider(input: { provider: string; apiKey: string; fetchImpl?: typeof fetch }) {
    if (!isLonoraProvider(input.provider)) {
      return {
        ok: false as const,
        error: "Lonora only connects Anthropic, OpenAI, Z.AI, and OpenRouter.",
      };
    }
    const probe = await probeProvider({
      provider: input.provider as LonoraProviderId,
      apiKey: input.apiKey,
      fetchImpl: input.fetchImpl,
    });
    this.store.saveProviderSecret({
      provider: probe.provider,
      apiKey: input.apiKey,
      defaultModel: probe.defaultModel,
      status: probe.connected ? "connected" : input.apiKey.trim() ? "invalid" : "not_connected",
      lastError: probe.error,
    });
    return {
      ok: probe.connected,
      provider: probe.provider,
      connected: probe.connected,
      defaultModel: probe.defaultModel,
      models: probe.models,
      error: probe.error,
    };
  }

  providerSettings() {
    const known = new Set(this.store.listProviderStatus().map((row) => row.provider));
    const stored = this.store.listProviderStatus();
    return (["anthropic", "openai", "zai", "openrouter"] as const).map((provider) => {
      const row = stored.find((item) => item.provider === provider);
      return {
        provider,
        connected: row?.connected ?? false,
        defaultModel: row?.defaultModel ?? null,
        status: row?.status ?? "not_connected",
        lastError: row?.lastError ?? null,
        configured: known.has(provider),
      };
    });
  }

  confirmTrade(input: {
    caller: "owner" | "monitor" | "schedule" | "subagent" | "model" | "chat";
    ownerConfirmed?: boolean;
  }) {
    const decision = authorizeTrade(input);
    if (!decision.ok) {
      return { ok: false as const, code: decision.code, brokerCalled: false };
    }
    return { ok: false as const, code: "not_linked" as const, brokerCalled: false };
  }
}

function calendarSummary(read: CalendarRead, language: OwnerLanguage): string {
  return read.ok
    ? describeCalendarEvents(read.events, language)
    : copy(language, "calendar.unavailable");
}

function activationSummary(plan: RecommendationPlan, language: "en" | "ar"): string | null {
  if (plan.activationUnreadable) {
    return copy(language, "recommendations.unreadable");
  }
  const rule = plan.activationRule ? parseActivationRule(plan.activationRule) : null;
  return rule ? describeActivationRule(rule, language) : null;
}

function purposeFor(agent: SpecialistId): string {
  switch (agent) {
    case "market-watcher":
      return "Watch gold for material changes without calling a model every candle.";
    case "structure-analyst":
      return "Read swings, trend, and structure breaks from closed candles.";
    case "liquidity-analyst":
      return "Locate equal highs and lows where stops are likely resting.";
    case "supply-demand-analyst":
      return "Mark impulse supply and demand zones.";
    case "multi-timeframe-analyst":
      return "Compare the working timeframe with the higher timeframe bias.";
    case "macro-news-analyst":
      return "Read the economic calendar and gold headlines. A failed feed stays unknown.";
    case "risk-reviewer":
      return "Grade reward against stop distance.";
    case "research-agent":
      return "Compare earlier closed gold moments. A small sample does not become a rate.";
    case "memory-curator":
      return "Compact a lesson so later responsibilities stay small.";
    case "system-guardian":
      return "Keep delegation limits and the manual trade boundary intact.";
  }
}
