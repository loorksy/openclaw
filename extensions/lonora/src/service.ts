import { randomUUID } from "node:crypto";
import { describeActivationRule, parseActivationRule } from "./domain/activation-rule.js";
import {
  assertDelegation,
  MAX_CHILD_RUNS,
  describeHigherTimeframe,
  runRiskReviewer,
  runSpecialist,
  runStructureAnalyst,
  SPECIALISTS,
  type GuardianFacts,
  type SpecialistId,
} from "./domain/agents.js";
import {
  describeCalendarEvents,
  readGoldCalendar,
  upcomingHighImpactKey,
  type CalendarRead,
  type EconomicEvent,
} from "./domain/calendar.js";
import {
  calculateAtr,
  detectSwings,
  isGoldSymbol,
  isSaneCandle,
  type Candle,
} from "./domain/candles.js";
import { describeCandleShape, latestCandleShape } from "./domain/candlesticks.js";
import { indexCandleCases, findSimilarCases } from "./domain/cases.js";
import { latestOwnerText } from "./domain/conversation.js";
import { copy, describeNotice, marketReasonCopy, type CopyKey } from "./domain/copy.js";
import { tradableRetestBand } from "./domain/fill.js";
import {
  describeHeadlines,
  headlineSetKey,
  readGoldHeadlines,
  type HeadlineRead,
  type NewsHeadline,
} from "./domain/headlines.js";
import {
  analyzeLiquidity,
  describeRestingLiquidity,
  restingLiquidity,
  sweepKey,
} from "./domain/liquidity-sweeps.js";
import { GOLD_BAR_MS, readGoldCandles } from "./domain/market-data.js";
import { candlesVisibleAt, priorGoldDay, readMarketClock } from "./domain/market.js";
import {
  decideMonitorAction,
  nextNotice,
  shouldNotify,
  type Observation,
} from "./domain/monitor.js";
import { bindTelegram, type OwnerLanguage } from "./domain/owner.js";
import { classifySwingRange, describePattern } from "./domain/patterns.js";
import { assertPermission, authorizeTrade, blockReasonForTool } from "./domain/permissions.js";
import { describeNearestZones, nearestGoldZones, prepareGoldPlan } from "./domain/plan.js";
import { isLonoraProvider, probeProvider, type LonoraProviderId } from "./domain/providers.js";
import { computeRangePosition, describeRange } from "./domain/range-position.js";
import {
  evaluateRecommendation,
  type RecommendationOutcome,
  type RecommendationPlan,
  type RecommendationStatus,
} from "./domain/recommendations.js";
import { checkResponsibility, responsibilityEventText } from "./domain/responsibilities.js";
import { summarizeScenario } from "./domain/scenario.js";
import {
  describeStructureBreak,
  detectStructureEvents,
  latestStructureEvent,
} from "./domain/structure.js";
import { describeTradingCenters, getTradingSessionInfo } from "./domain/trading-sessions.js";
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
      centers: this.sessionSentence(now),
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
        .filter((plan) => plan.outcome === "pending")
        .map((plan) => ({ ...plan, ...recommendationLabels(plan, owner.language) })),
      responsibilities: this.store.listResponsibilities().filter((row) => row.status === "running"),
    };
  }

  observe(next: Observation, now = Date.now()) {
    const previous = this.store.getObservation<Observation>();
    const decision = decideMonitorAction(previous, next);
    if (!next.marketOpen) {
      this.store.saveObservation({ ...next, price: previous?.price ?? next.price });
    } else {
      this.store.saveObservation(next);
    }
    const owner = this.store.ensureLocalOwner();
    const message = decision.material
      ? decision.notificationKeys.map((key) => this.noticeText(owner.language, key, now)).join(" ")
      : copy(owner.language, "notify.unchanged");
    if (decision.material && message.trim()) {
      this.store.replaceMemory("market_observation", "XAUUSD", message.slice(0, 240));
    }
    return { decision, message };
  }

  async publishNotices(
    decision: { notificationKeys: string[]; reasons: string[]; material: boolean },
    now = Date.now(),
  ) {
    const owner = this.store.ensureLocalOwner();
    const notices = [];
    for (const key of decision.notificationKeys) {
      const text = this.noticeText(owner.language, key, now);
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
        pattern: null,
        candleShape: null,
        range: null,
        priorDay: null,
        latestSweep: null,
        buySide: null,
        sellSide: null,
        demand: null,
        supply: null,
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
    const resting = this.noteLiquidity(visible.candles);
    const zones = this.noteZones(visible.candles);
    this.noteStructure(visible.candles);
    this.noteTimeframe(visible.candles);
    return {
      ok: visible.candles.length > 0,
      candles: visible.candles,
      latestSweep: resting.sweep,
      buySide: resting.buySide,
      sellSide: resting.sellSide,
      demand: zones.demand,
      supply: zones.supply,
      pattern: visible.candles.length > 0 ? classifySwingRange(visible.candles) : null,
      candleShape: visible.candles.length > 0 ? latestCandleShape(visible.candles) : null,
      range:
        visible.candles.length > 0
          ? computeRangePosition(visible.candles, visible.candles.at(-1)?.close ?? null)
          : null,
      priorDay: visible.candles.length > 0 ? priorGoldDay(visible.candles) : null,
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
        this.noteStructure(candles);
        this.noteLiquidity(candles);
        this.noteZones(candles);
        this.noteTimeframe(candles);
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
    const observed = this.observe(
      {
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
      },
      now,
    );
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
      const lastEvent = responsibilityEventText(language, check);
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
      ...recommendationLabels(plan, language),
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
    const clock = readMarketClock(now);
    const prepared = prepareGoldPlan(
      read.candles,
      language,
      now,
      undefined,
      clock.isOpen ? null : { nextOpenAt: clock.nextOpenAt },
    );
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
    const summary = this.recommendationRecord();
    this.store.replaceMemory("scenario", "XAUUSD", summary.writable ? summary.text : null);
    return summary;
  }

  recommendationRecord() {
    const owner = this.store.ensureLocalOwner();
    const summary = summarizeScenario(this.store.listRecommendations(), owner.language);
    return { ...summary, invented: false as const };
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

  async compareTimeframes(now = Date.now()) {
    const read = await this.readCandles(120);
    if (!read.ok) {
      return this.delegate({
        agent: "multi-timeframe-analyst",
        marketKnown: false,
      });
    }
    const visible = candlesVisibleAt(read.candles, now, GOLD_BAR_MS);
    const candles = visible.candles.filter((candle) => isSaneCandle(candle));
    this.noteTimeframe(candles);
    return this.delegate({
      agent: "multi-timeframe-analyst",
      candles,
    });
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
    if (
      kind === "structure_read" ||
      kind === "liquidity_read" ||
      kind === "zone_read" ||
      kind === "timeframe_read"
    ) {
      return null;
    }
    return this.store.addMemory({ kind, content, symbol });
  }

  /**
   * One structure sentence from closed candles. A later read replaces it.
   * An empty or failed read leaves the previous sentence in place.
   */
  private noteStructure(candles: Candle[]): void {
    if (candles.length === 0) {
      return;
    }
    const language = this.store.ensureLocalOwner().language;
    const close = candles.at(-1)?.close ?? null;
    const prior = priorGoldDay(candles);
    const shape = latestCandleShape(candles);
    const range = computeRangePosition(candles, close);
    const breakText =
      candles.length >= 10
        ? describeStructureBreak(
            language,
            latestStructureEvent(
              detectStructureEvents(candles, detectSwings(candles), calculateAtr(candles)),
            ),
          )
        : "";
    const text = [
      breakText,
      range ? describeRange(language, range) : "",
      prior ? `${copy(language, "structure.prior")} ${prior.low}–${prior.high}` : "",
      describePattern(classifySwingRange(candles), language),
      shape ? describeCandleShape(shape, language) : "",
    ]
      .filter((part) => part.length > 0)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    if (!text) {
      return;
    }
    this.store.replaceMemory("structure_read", "XAUUSD", text);
  }

  /**
   * One liquidity sentence from the same closed candles. The next read replaces it.
   * An empty or failed read leaves the previous sentence in place.
   */
  private noteLiquidity(candles: Candle[]) {
    const resting = restingLiquidity(candles);
    if (candles.length === 0) {
      return resting;
    }
    const language = this.store.ensureLocalOwner().language;
    const text = describeRestingLiquidity(language, resting, candles.length)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    if (text) {
      this.store.replaceMemory("liquidity_read", "XAUUSD", text);
    }
    return resting;
  }

  /**
   * One supply and demand sentence from the same closed candles.
   * The next read replaces it. A grade is not a trade.
   */
  private noteZones(candles: Candle[]) {
    const zones = nearestGoldZones(candles);
    if (candles.length === 0) {
      return zones;
    }
    const language = this.store.ensureLocalOwner().language;
    const text = describeNearestZones(language, zones, candles.length)
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    if (text) {
      this.store.replaceMemory("zone_read", "XAUUSD", text);
    }
    return zones;
  }

  /**
   * One four-hour sentence from the same closed candles.
   * The next read replaces it. An empty or failed read leaves the previous sentence.
   */
  private noteTimeframe(candles: Candle[]): void {
    if (candles.length === 0) {
      return;
    }
    const language = this.store.ensureLocalOwner().language;
    const text = describeHigherTimeframe(candles, language)
      .summary.replace(/\s+/g, " ")
      .trim()
      .slice(0, 240);
    if (text) {
      this.store.replaceMemory("timeframe_read", "XAUUSD", text);
    }
  }

  /** One rolling owner request. Assistant text and an empty turn are not stored. */
  noteConversation(messages: readonly unknown[]): string | null {
    const text = latestOwnerText(messages);
    if (!text) {
      return null;
    }
    this.store.replaceMemory("conversation", "XAUUSD", text);
    return text;
  }

  recall(query: string, kind?: MemoryKind) {
    return this.store.searchMemory(query, kind);
  }

  /** Centers open on their own clocks. Does not describe how price will move. */
  sessionSentence(now = Date.now()): string {
    return describeTradingCenters(
      getTradingSessionInfo(now),
      this.store.ensureLocalOwner().language,
    );
  }

  /** One gold brief for every door. An empty store does not invent a rate. */
  ownerBrief(): string {
    const language = this.store.ensureLocalOwner().language;
    const scenario = this.store.listRecentMemory("scenario", 1);
    const lessons = this.store.listRecentMemory("lesson", 3);
    const observation = this.store.listRecentMemory("market_observation", 1);
    const structure = this.store.listRecentMemory("structure_read", 1);
    const liquidity = this.store.listRecentMemory("liquidity_read", 1);
    const zones = this.store.listRecentMemory("zone_read", 1);
    const timeframe = this.store.listRecentMemory("timeframe_read", 1);
    const conversation = this.store.listRecentMemory("conversation", 1);
    const plans = this.store
      .listRecommendations()
      .filter((plan) => plan.outcome === "pending")
      .slice(0, 2);
    const tasks = this.store
      .listResponsibilities()
      .filter((row) => row.status === "running" || row.status === "scheduled")
      .slice(0, 5);
    if (
      scenario.length === 0 &&
      lessons.length === 0 &&
      observation.length === 0 &&
      structure.length === 0 &&
      liquidity.length === 0 &&
      zones.length === 0 &&
      timeframe.length === 0 &&
      conversation.length === 0 &&
      plans.length === 0 &&
      tasks.length === 0
    ) {
      return copy(language, "memory.empty");
    }
    const lines = [copy(language, "memory.lead")];
    if (scenario[0]) {
      lines.push(`${copy(language, "memory.scenario")} ${scenario[0].content}`);
    }
    if (observation[0]) {
      lines.push(`${copy(language, "memory.observation")} ${observation[0].content}`);
    }
    if (structure[0]) {
      lines.push(`${copy(language, "memory.structure")} ${structure[0].content}`);
    }
    if (liquidity[0]) {
      lines.push(`${copy(language, "memory.liquidity")} ${liquidity[0].content}`);
    }
    if (zones[0]) {
      lines.push(`${copy(language, "memory.zones")} ${zones[0].content}`);
    }
    if (timeframe[0]) {
      lines.push(`${copy(language, "memory.timeframe")} ${timeframe[0].content}`);
    }
    if (conversation[0]) {
      lines.push(`${copy(language, "memory.conversation")} ${conversation[0].content}`);
    }
    if (lessons.length > 0) {
      lines.push(
        `${copy(language, "memory.lessons")} ${lessons.map((row) => row.content).join(" ")}`,
      );
    }
    if (plans.length > 0) {
      lines.push(
        `${copy(language, "memory.plans")} ${plans.map((plan) => planLine(language, plan)).join("; ")}`,
      );
      const newest = [...plans].sort((left, right) => right.createdAt - left.createdAt)[0];
      if (newest) {
        const review = runRiskReviewer({
          entry: newest.entry,
          stopLoss: newest.stopLoss,
          targets: newest.targets,
          language,
        });
        if (review.ok) {
          lines.push(`${copy(language, "memory.risk")} ${review.summary}`);
        }
      }
    }
    if (tasks.length > 0) {
      lines.push(`${copy(language, "memory.tasks")} ${tasks.map((row) => row.title).join("; ")}`);
    }
    return lines.join(" ").slice(0, 700);
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
    entry?: number;
    stopLoss?: number;
    targets?: number[];
    note?: string;
    events?: EconomicEvent[];
    calendarKnown?: boolean;
    headlines?: NewsHeadline[];
    headlinesKnown?: boolean;
    marketKnown?: boolean;
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
    const language = this.store.ensureLocalOwner().language;
    const pending =
      input.agent === "risk-reviewer"
        ? this.store
            .listRecommendations()
            .filter(
              (plan) =>
                plan.symbol === "XAUUSD" &&
                plan.outcome === "pending" &&
                Number.isFinite(plan.entry) &&
                Number.isFinite(plan.stopLoss) &&
                plan.targets.some((level) => Number.isFinite(level)),
            )
            .sort((left, right) => right.createdAt - left.createdAt)[0]
        : undefined;
    const reviewed =
      input.agent === "risk-reviewer"
        ? {
            ...input,
            entry: pending?.entry,
            stopLoss: pending?.stopLoss,
            targets: pending?.targets ?? [],
          }
        : input;
    const result = runSpecialist(reviewed.agent, {
      ...reviewed,
      note,
      language,
      guardian:
        input.agent === "system-guardian"
          ? this.guardianFacts(
              input.childCount ?? this.store.countAgentRunsSince(Date.now() - DELEGATION_WINDOW_MS),
            )
          : undefined,
    });
    const lesson =
      input.agent === "memory-curator" && result.ok && typeof result.data.lesson === "string"
        ? result.data.lesson
        : "";
    if (lesson) {
      this.remember("lesson", lesson, "XAUUSD");
    }
    const summary =
      input.agent === "memory-curator" && result.ok
        ? copy(language, lesson ? "memory.stored" : "memory.none")
        : result.summary;
    this.store.recordAgentRun({
      agent: input.agent,
      parentRunId: input.parentRunId,
      status: result.ok ? "ok" : "failed",
      summary,
    });
    return { ...result, summary };
  }

  agentsView() {
    const runs = this.store.listAgentRuns();
    const language = this.store.ensureLocalOwner().language;
    return SPECIALISTS.map((agent) => {
      const latest = runs.find((run) => run.agent === agent);
      const alwaysOn = agent === "market-watcher" || agent === "system-guardian";
      return {
        agent,
        name: specialistName(agent, language),
        state: alwaysOn ? "running" : "on_demand",
        stateLabel: copy(language, alwaysOn ? "state.running" : "state.onDemand"),
        purpose: purposeFor(agent, language),
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

  private guardianFacts(childCount: number): GuardianFacts {
    const modelTrade = this.confirmTrade({ caller: "model", ownerConfirmed: true });
    const ownerTrade = this.confirmTrade({ caller: "owner", ownerConfirmed: true });
    return {
      childCount,
      maxChildren: MAX_CHILD_RUNS,
      modelTradeBlocked: !modelTrade.ok && modelTrade.brokerCalled === false,
      ownerBrokerCalled: ownerTrade.brokerCalled,
      codingBlocked: blockReasonForTool({ toolName: "exec", ownerConfirmed: true }) != null,
    };
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

  private noticeText(language: OwnerLanguage, key: string, now: number): string {
    const lead = describeNotice(language, key);
    if (key.startsWith("macro_event:") && this.lastCalendar.summary) {
      return `${lead} ${this.lastCalendar.summary}`;
    }
    if (key.startsWith("headline:") && this.lastHeadlines.summary) {
      return `${lead} ${this.lastHeadlines.summary}`;
    }
    if (key.startsWith("session:")) {
      return `${lead} ${marketReasonCopy(language, readMarketClock(now).reason)}`;
    }
    if (key.startsWith("price_move:")) {
      const price = this.store.getObservation<Observation>()?.price;
      return price == null ? lead : `${lead} ${price}`;
    }
    return lead;
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
  const ruleText = rule ? describeActivationRule(rule, language) : null;
  if (plan.entryType !== "retest_zone") {
    return ruleText;
  }
  const band = tradableRetestBand({
    direction: plan.direction,
    zone: plan.retestZone,
    stopLoss: plan.stopLoss,
  });
  if (!band) {
    return copy(language, "entry.retestMissing");
  }
  const bandText = `${copy(language, "entry.retest")} ${band.low}–${band.high}`;
  return ruleText ? `${ruleText} ${bandText}` : bandText;
}

function recommendationLabels(
  plan: {
    direction: RecommendationPlan["direction"];
    status: RecommendationStatus;
    outcome: RecommendationOutcome;
  },
  language: OwnerLanguage,
): { directionLabel: string; statusLabel: string; outcomeLabel: string } {
  const statusKey: Record<RecommendationStatus, CopyKey> = {
    pending_entry: "label.status.pending_entry",
    triggered: "label.status.triggered",
    tp1_hit: "label.status.tp1_hit",
    tp2_hit: "label.status.tp2_hit",
    tp3_hit: "label.status.tp3_hit",
    sl_hit: "label.status.sl_hit",
    invalidated: "label.status.invalidated",
    expired: "label.status.expired",
    cancelled: "label.status.cancelled",
  };
  const outcomeKey: Record<RecommendationOutcome, CopyKey> = {
    pending: "label.outcome.pending",
    win_tp1: "label.outcome.win_tp1",
    win_tp2: "label.outcome.win_tp2",
    win_tp3: "label.outcome.win_tp3",
    loss: "label.outcome.loss",
    expired: "label.outcome.expired",
    cancelled: "label.outcome.cancelled",
    invalidated: "label.outcome.invalidated",
  };
  return {
    directionLabel: copy(language, plan.direction === "sell" ? "label.sell" : "label.buy"),
    statusLabel: copy(language, statusKey[plan.status]),
    outcomeLabel: copy(language, outcomeKey[plan.outcome]),
  };
}

function planLine(language: OwnerLanguage, plan: RecommendationPlan): string {
  const side = copy(language, plan.direction === "sell" ? "memory.sell" : "memory.buy");
  const target = plan.targets.find((level) => Number.isFinite(level));
  const levels = `${copy(language, "memory.planStop")} ${plan.stopLoss}`;
  return target == null
    ? `${side} ${plan.entry}, ${levels}`
    : `${side} ${plan.entry}, ${levels}, ${copy(language, "memory.planTarget")} ${target}`;
}

function specialistName(agent: SpecialistId, language: OwnerLanguage): string {
  switch (agent) {
    case "market-watcher":
      return copy(language, "name.marketWatcher");
    case "structure-analyst":
      return copy(language, "name.structure");
    case "liquidity-analyst":
      return copy(language, "name.liquidity");
    case "supply-demand-analyst":
      return copy(language, "name.zones");
    case "multi-timeframe-analyst":
      return copy(language, "name.mtf");
    case "macro-news-analyst":
      return copy(language, "name.macro");
    case "risk-reviewer":
      return copy(language, "name.risk");
    case "research-agent":
      return copy(language, "name.research");
    case "memory-curator":
      return copy(language, "name.memory");
    case "system-guardian":
      return copy(language, "name.guardian");
  }
}

function purposeFor(agent: SpecialistId, language: OwnerLanguage): string {
  switch (agent) {
    case "market-watcher":
      return copy(language, "purpose.marketWatcher");
    case "structure-analyst":
      return copy(language, "purpose.structure");
    case "liquidity-analyst":
      return copy(language, "purpose.liquidity");
    case "supply-demand-analyst":
      return copy(language, "purpose.zones");
    case "multi-timeframe-analyst":
      return copy(language, "purpose.mtf");
    case "macro-news-analyst":
      return copy(language, "purpose.macro");
    case "risk-reviewer":
      return copy(language, "purpose.risk");
    case "research-agent":
      return copy(language, "purpose.research");
    case "memory-curator":
      return copy(language, "purpose.memory");
    case "system-guardian":
      return copy(language, "purpose.guardian");
  }
}
