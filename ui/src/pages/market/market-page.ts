import { consume } from "@lit/context";
import { html, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerLonoraEnglish } from "../../i18n/locales/en-lonora.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { lonoraRequestTarget } from "../lonora/request.ts";
import { candleChart, type ChartCandle, type ChartMark } from "./chart.ts";

registerLonoraEnglish();

type MarketSnapshot = {
  symbol: string;
  message: string;
  lastPrice: number | null;
  stale: boolean;
  invented: false;
  clock: { isOpen: boolean; session: string; reason: string };
  centers?: string;
  recommendations: {
    id: string;
    direction: string;
    directionLabel?: string;
    status: string;
    statusLabel?: string;
  }[];
  responsibilities: { id: string; title: string; status: string; statusLabel?: string }[];
  dataStatus?: string;
  dataError?: string | null;
  assessment?: string | null;
  calendar?: { known: boolean; summary: string | null };
  headlines?: { known: boolean; summary: string | null };
};

class MarketPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private snapshot: MarketSnapshot | null = null;
  @state() private candles: ChartCandle[] = [];
  @state() private latestSweep: { side: "buy_side" | "sell_side"; sweptLevel: number } | null =
    null;
  @state() private buySide: number | null = null;
  @state() private sellSide: number | null = null;
  @state() private demandZone: ZoneView | null = null;
  @state() private supplyZone: ZoneView | null = null;
  @state() private pattern: SwingRangeView | null = null;
  @state() private candleShape: CandleShapeView | null = null;
  @state() private dealingRange: DealingRangeView | null = null;
  @state() private priorDay: PriorDayView | null = null;
  @state() private structureBreak: number | null = null;
  @state() private breakSummary: string | null = null;
  @state() private timeframeSummary: string | null = null;
  @state() private chartError: string | null = null;
  @state() private error: string | null = null;
  @state() private headlineText: string | null = null;
  @state() private calendarText: string | null = null;
  @state() private memoryText: string | null = null;
  @state() private historyText: string | null = null;
  @state() private comparing = false;
  @state() private loading = false;

  private loadGeneration = 0;
  private seenPhase: string | undefined;

  private readonly subscriptions = new SubscriptionsController(this).watchStore(
    () => this.context?.gateway,
    () => {
      const phase = this.context?.gateway?.snapshot.phase;
      if (phase === "connected" && this.seenPhase !== "connected") {
        this.seenPhase = phase;
        void this.load();
      } else if (phase) {
        this.seenPhase = phase;
      }
    },
  );

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    const generation = ++this.loadGeneration;
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.client;
    if (!client || gateway.snapshot.phase !== "connected") {
      this.error = t("lonora.market.disconnected");
      this.snapshot = null;
      this.candles = [];
      this.latestSweep = null;
      this.buySide = null;
      this.sellSide = null;
      this.demandZone = null;
      this.supplyZone = null;
      this.pattern = null;
      this.candleShape = null;
      this.dealingRange = null;
      this.priorDay = null;
      this.structureBreak = null;
      this.breakSummary = null;
      this.timeframeSummary = null;
      this.chartError = t("lonora.market.chartUnavailable");
      return;
    }
    if (isGatewayMethodAdvertised(gateway.snapshot, "lonora.market.snapshot") === false) {
      this.error = t("lonora.market.unavailable");
      this.snapshot = null;
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const snapshot = await client.request<MarketSnapshot>("lonora.market.snapshot", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      this.snapshot = snapshot;
      await Promise.all([
        this.loadCandles(generation),
        this.loadHeadlines(generation),
        this.loadCalendar(generation),
        this.loadMemory(generation),
      ]);
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.snapshot = null;
      this.error = error instanceof Error ? error.message : t("lonora.market.unavailable");
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
      }
    }
  }

  private async loadMemory(generation: number) {
    const target = lonoraRequestTarget(this.context, "lonora.memory.brief");
    if (!target.ok) {
      this.memoryText = null;
      return;
    }
    try {
      const read = await target.client.request<{ text?: string; invented?: boolean }>(
        "lonora.memory.brief",
        {},
      );
      if (generation !== this.loadGeneration) {
        return;
      }
      this.memoryText = read.invented ? null : (read.text ?? null);
    } catch {
      if (generation === this.loadGeneration) {
        this.memoryText = null;
      }
    }
  }

  private async loadCalendar(generation: number) {
    const target = lonoraRequestTarget(this.context, "lonora.calendar.read");
    if (!target.ok) {
      this.calendarText = null;
      return;
    }
    try {
      const read = await target.client.request<{
        ok: boolean;
        summary?: string;
        invented?: boolean;
      }>("lonora.calendar.read", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      if (read.invented) {
        this.calendarText = null;
        return;
      }
      this.calendarText = read.summary ?? t("lonora.market.calendarUnknown");
    } catch {
      if (generation === this.loadGeneration) {
        this.calendarText = null;
      }
    }
  }

  private async loadHeadlines(generation: number) {
    const target = lonoraRequestTarget(this.context, "lonora.headlines.read");
    if (!target.ok) {
      this.headlineText = null;
      return;
    }
    try {
      const read = await target.client.request<{
        ok: boolean;
        summary?: string;
        invented?: boolean;
        headlines?: { title: string }[];
      }>("lonora.headlines.read", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      if (read.invented) {
        this.headlineText = null;
        return;
      }
      this.headlineText = read.summary ?? t("lonora.market.headlinesUnknown");
    } catch {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.headlineText = null;
    }
  }

  private async compareHistory() {
    const target = lonoraRequestTarget(this.context, "lonora.research.similar");
    if (!target.ok) {
      this.historyText = null;
      this.error =
        target.reason === "disconnected"
          ? t("lonora.market.disconnected")
          : t("lonora.market.historyUnavailable");
      return;
    }
    this.comparing = true;
    this.error = null;
    try {
      const result = await target.client.request<{
        ok: boolean;
        text?: string;
        matches?: number;
        resolved?: number;
        winRate?: number | null;
        invented?: boolean;
        brokerCalled?: boolean;
      }>("lonora.research.similar", {});
      const resolved = result.resolved ?? 0;
      const rateTooSmall = result.winRate != null && resolved < 8;
      if (result.invented || result.brokerCalled || rateTooSmall) {
        this.historyText = null;
        this.error = t("lonora.market.historyUnavailable");
        return;
      }
      this.historyText = result.text ?? t("lonora.market.historyUnavailable");
    } catch (error) {
      this.historyText = null;
      this.error = error instanceof Error ? error.message : t("lonora.market.historyUnavailable");
    } finally {
      this.comparing = false;
    }
  }

  private async loadCandles(generation: number) {
    const target = lonoraRequestTarget(this.context, "lonora.candles.read");
    if (!target.ok) {
      this.candles = [];
      this.latestSweep = null;
      this.buySide = null;
      this.sellSide = null;
      this.demandZone = null;
      this.supplyZone = null;
      this.pattern = null;
      this.candleShape = null;
      this.dealingRange = null;
      this.priorDay = null;
      this.structureBreak = null;
      this.breakSummary = null;
      this.timeframeSummary = null;
      this.chartError = t("lonora.market.chartUnavailable");
      return;
    }
    try {
      const read = await target.client.request<{
        ok: boolean;
        candles: ChartCandle[];
        latestSweep?: { side: "buy_side" | "sell_side"; sweptLevel: number } | null;
        buySide?: number | null;
        sellSide?: number | null;
        demand?: ZoneView | null;
        supply?: ZoneView | null;
        pattern?: SwingRangeView | null;
        candleShape?: CandleShapeView | null;
        range?: DealingRangeView | null;
        priorDay?: PriorDayView | null;
        structureBreak?: number | null;
        breakSummary?: string | null;
        timeframeSummary?: string | null;
        invented: false;
        error?: string | null;
      }>("lonora.candles.read", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      this.candles = read.invented ? [] : read.candles;
      this.latestSweep = read.invented ? null : (read.latestSweep ?? null);
      this.buySide = read.invented || !read.ok ? null : finitePrice(read.buySide);
      this.sellSide = read.invented || !read.ok ? null : finitePrice(read.sellSide);
      this.demandZone = read.invented || !read.ok ? null : readZone(read.demand);
      this.supplyZone = read.invented || !read.ok ? null : readZone(read.supply);
      this.pattern =
        read.invented || read.pattern?.inventedTarget !== false ? null : (read.pattern ?? null);
      this.candleShape =
        read.invented || read.candleShape?.inventedTarget !== false
          ? null
          : (read.candleShape ?? null);
      this.dealingRange = read.invented || read.range?.invented !== false ? null : read.range;
      this.priorDay = read.invented || read.priorDay?.invented !== false ? null : read.priorDay;
      this.structureBreak = read.invented || !read.ok ? null : finitePrice(read.structureBreak);
      this.breakSummary = read.invented || !read.ok ? null : (read.breakSummary ?? null);
      this.timeframeSummary = read.invented || !read.ok ? null : (read.timeframeSummary ?? null);
      this.chartError = read.ok ? null : (read.error ?? t("lonora.market.chartEmpty"));
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.candles = [];
      this.latestSweep = null;
      this.buySide = null;
      this.sellSide = null;
      this.demandZone = null;
      this.supplyZone = null;
      this.pattern = null;
      this.candleShape = null;
      this.dealingRange = null;
      this.priorDay = null;
      this.structureBreak = null;
      this.breakSummary = null;
      this.timeframeSummary = null;
      this.chartError =
        error instanceof Error ? error.message : t("lonora.market.chartUnavailable");
    }
  }

  override render() {
    const snapshot = this.snapshot;
    return html`
      <section class="content" style="padding: 24px; max-width: 880px;">
        <header>
          <h1>${titleForRoute("market")}</h1>
          <p>${t("lonora.market.lead")}</p>
        </header>
        <button
          class="btn"
          type="button"
          ?disabled=${this.loading}
          @click=${() => void this.load()}
        >
          ${t("common.refresh")}
        </button>
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        ${
          snapshot
            ? html`
                <dl>
                  <dt>${t("lonora.market.symbol")}</dt>
                  <dd>${snapshot.symbol}</dd>
                  <dt>${t("lonora.market.session")}</dt>
                  <dd>${snapshot.centers || snapshot.clock.session}</dd>
                  <dt>${t("lonora.market.state")}</dt>
                  <dd>
                    ${snapshot.clock.isOpen ? t("lonora.market.open") : t("lonora.market.closed")}
                  </dd>
                  <dt>${t("lonora.market.data")}</dt>
                  <dd>${marketDataLabel(snapshot)}</dd>
                  <dt>${t("lonora.market.price")}</dt>
                  <dd>${marketPriceLabel(snapshot)}</dd>
                  ${snapshot.dataError ? html`<p role="status">${snapshot.dataError}</p>` : nothing}
                  <dt>${t("lonora.market.assessment")}</dt>
                  <dd>${snapshot.assessment ?? t("lonora.market.chartUnavailable")}</dd>
                  <dt>${t("lonora.market.calendar")}</dt>
                  <dd>
                    ${
                      this.calendarText ??
                      snapshot.calendar?.summary ??
                      t("lonora.market.calendarUnknown")
                    }
                  </dd>
                  <dt>${t("lonora.market.memory")}</dt>
                  <dd>${this.memoryText ?? t("lonora.market.memoryUnknown")}</dd>
                  <dt>${t("lonora.market.headlines")}</dt>
                  <dd>
                    ${
                      this.headlineText ??
                      snapshot.headlines?.summary ??
                      t("lonora.market.headlinesUnknown")
                    }
                  </dd>
                </dl>
                <h2>${t("lonora.market.history")}</h2>
                <button
                  class="btn"
                  type="button"
                  ?disabled=${this.comparing}
                  @click=${() => void this.compareHistory()}
                >
                  ${this.comparing ? t("lonora.market.historyComparing") : t("lonora.market.historyCompare")}
                </button>
                <p role="status">${this.historyText ?? t("lonora.market.historyEmpty")}</p>
                <h2>${t("lonora.market.chart")}</h2>
                ${renderChart(
                  this.candles,
                  this.chartError,
                  chartMarks({
                    priorDay: this.priorDay,
                    buySide: this.buySide,
                    sellSide: this.sellSide,
                    demand: this.demandZone,
                    supply: this.supplyZone,
                    structureBreak: this.structureBreak,
                  }),
                )}
                <h2>${t("lonora.market.break")}</h2>
                <p>${readSentence(this.breakSummary, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.timeframe")}</h2>
                <p>${readSentence(this.timeframeSummary, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.priorDay")}</h2>
                <p>${priorDayText(this.priorDay, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.range")}</h2>
                <p>${rangeText(this.dealingRange, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.sweep")}</h2>
                <p>${sweepText(this.latestSweep, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.pools")}</h2>
                <p>${poolText(this.buySide, "lonora.market.poolsBuy")}</p>
                <p>${poolText(this.sellSide, "lonora.market.poolsSell")}</p>
                <h2>${t("lonora.market.zones")}</h2>
                <p>
                  ${zonesText(this.demandZone, this.supplyZone, this.chartError, this.candles.length)}
                </p>
                <h2>${t("lonora.market.pattern")}</h2>
                <p>${patternText(this.pattern, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.candle")}</h2>
                <p>${candleText(this.candleShape, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.activeRecommendations")}</h2>
                ${
                  snapshot.recommendations.length
                    ? html`<ul>
                        ${snapshot.recommendations.map(
                          (plan) =>
                            html`<li>
                              ${plan.id}: ${plan.directionLabel || plan.direction} ·
                              ${plan.statusLabel || plan.status}
                            </li>`,
                        )}
                      </ul>`
                    : html`<p>${t("lonora.market.noRecommendations")}</p>`
                }
                <h2>${t("lonora.market.responsibilities")}</h2>
                ${
                  snapshot.responsibilities.length
                    ? html`<ul>
                        ${snapshot.responsibilities.map(
                          (row) => html`<li>${row.title} · ${row.statusLabel || row.status}</li>`,
                        )}
                      </ul>`
                    : html`<p>${t("lonora.market.noResponsibilities")}</p>`
                }
              `
            : nothing
        }
      </section>
    `;
  }
}

type PriorDayView = {
  high: number;
  low: number;
  invented: false;
};

type DealingRangeView = {
  high: number;
  low: number;
  label: "premium" | "discount" | "mid_range" | "near_high" | "near_low";
  invented: false;
};

type CandleShapeView = {
  name: string;
  inventedTarget: false;
};

type SwingRangeView = {
  stage: string;
  high: number | null;
  low: number | null;
  inventedTarget: false;
  named?: { kind: string; inventedTarget: false } | null;
};

function priorDayText(day: PriorDayView | null, error: string | null, candleCount: number) {
  if (!day || day.invented !== false) {
    if (error && candleCount === 0) {
      return t("lonora.market.chartUnavailable");
    }
    return t("lonora.market.priorDayUnknown");
  }
  return `${day.low}–${day.high}`;
}

function rangeText(range: DealingRangeView | null, error: string | null, candleCount: number) {
  if (!range || range.invented !== false) {
    if (error && candleCount === 0) {
      return t("lonora.market.chartUnavailable");
    }
    return t("lonora.market.rangeUnknown");
  }
  const label = rangeLabel(range.label);
  return label ? `${label} ${range.low}–${range.high}` : t("lonora.market.rangeUnknown");
}

function rangeLabel(label: DealingRangeView["label"]) {
  switch (label) {
    case "premium":
      return t("lonora.market.rangePremium");
    case "discount":
      return t("lonora.market.rangeDiscount");
    case "mid_range":
      return t("lonora.market.rangeMid");
    case "near_high":
      return t("lonora.market.rangeNearHigh");
    case "near_low":
      return t("lonora.market.rangeNearLow");
  }
}

function candleText(shape: CandleShapeView | null, error: string | null, candleCount: number) {
  if (!shape || shape.inventedTarget !== false) {
    if (error && candleCount === 0) {
      return t("lonora.market.chartUnavailable");
    }
    return t("lonora.market.candleUnknown");
  }
  const name = candleShapeLabel(shape.name);
  if (!name) {
    return t("lonora.market.candleUnknown");
  }
  return `${name}. ${t("lonora.market.candleNotATrade")}`;
}

function candleShapeLabel(name: string) {
  switch (name) {
    case "doji":
      return t("lonora.market.candleDoji");
    case "hammer":
      return t("lonora.market.candleHammer");
    case "inverted_hammer":
      return t("lonora.market.candleInvertedHammer");
    case "shooting_star":
      return t("lonora.market.candleShootingStar");
    case "hanging_man":
      return t("lonora.market.candleHangingMan");
    case "marubozu_bullish":
      return t("lonora.market.candleMarubozuBullish");
    case "marubozu_bearish":
      return t("lonora.market.candleMarubozuBearish");
    case "spinning_top":
      return t("lonora.market.candleSpinningTop");
    case "bullish_engulfing":
      return t("lonora.market.candleBullishEngulfing");
    case "bearish_engulfing":
      return t("lonora.market.candleBearishEngulfing");
    case "morning_star":
      return t("lonora.market.candleMorningStar");
    case "evening_star":
      return t("lonora.market.candleEveningStar");
    case "three_white_soldiers":
      return t("lonora.market.candleThreeWhiteSoldiers");
    case "three_black_crows":
      return t("lonora.market.candleThreeBlackCrows");
    case "bullish_harami":
      return t("lonora.market.candleBullishHarami");
    case "bearish_harami":
      return t("lonora.market.candleBearishHarami");
    case "tweezer_top":
      return t("lonora.market.candleTweezerTop");
    case "tweezer_bottom":
      return t("lonora.market.candleTweezerBottom");
    default:
      return "";
  }
}

function patternText(pattern: SwingRangeView | null, error: string | null, candleCount: number) {
  if (!pattern) {
    if (error && candleCount === 0) {
      return t("lonora.market.chartUnavailable");
    }
    return t("lonora.market.patternUnknown");
  }
  const stage = patternStageLabel(pattern.stage);
  const name = pattern.named?.inventedTarget === false ? namedPatternLabel(pattern.named.kind) : "";
  const bounds =
    pattern.low == null || pattern.high == null || pattern.stage === "unclassified"
      ? stage
      : `${stage} ${pattern.low}–${pattern.high}`;
  return name ? `${bounds} · ${name}` : bounds;
}

function namedPatternLabel(kind: string) {
  if (kind === "double_top") {
    return t("lonora.market.patternDoubleTop");
  }
  if (kind === "double_bottom") {
    return t("lonora.market.patternDoubleBottom");
  }
  if (kind === "triple_top") {
    return t("lonora.market.patternTripleTop");
  }
  if (kind === "triple_bottom") {
    return t("lonora.market.patternTripleBottom");
  }
  if (kind === "head_and_shoulders") {
    return t("lonora.market.patternHeadShoulders");
  }
  if (kind === "inverse_head_and_shoulders") {
    return t("lonora.market.patternInverseHeadShoulders");
  }
  if (kind === "ascending_triangle") {
    return t("lonora.market.patternAscending");
  }
  if (kind === "descending_triangle") {
    return t("lonora.market.patternDescending");
  }
  if (kind === "symmetrical_triangle") {
    return t("lonora.market.patternSymmetrical");
  }
  if (kind === "rising_wedge") {
    return t("lonora.market.patternRisingWedge");
  }
  if (kind === "falling_wedge") {
    return t("lonora.market.patternFallingWedge");
  }
  if (kind === "flag") {
    return t("lonora.market.patternFlag");
  }
  if (kind === "pennant") {
    return t("lonora.market.patternPennant");
  }
  if (kind === "cup_and_handle") {
    return t("lonora.market.patternCup");
  }
  if (kind === "inverse_cup_and_handle") {
    return t("lonora.market.patternInverseCup");
  }
  if (kind === "rectangle") {
    return t("lonora.market.patternRectangle");
  }
  if (kind === "support") {
    return t("lonora.market.patternSupport");
  }
  if (kind === "resistance") {
    return t("lonora.market.patternResistance");
  }
  if (kind === "rising_channel") {
    return t("lonora.market.patternRisingChannel");
  }
  if (kind === "falling_channel") {
    return t("lonora.market.patternFallingChannel");
  }
  if (kind === "horizontal_channel") {
    return t("lonora.market.patternHorizontalChannel");
  }
  return "";
}

function patternStageLabel(stage: string) {
  switch (stage) {
    case "unclassified":
      return t("lonora.market.patternUnclassified");
    case "starting":
      return t("lonora.market.patternStarting");
    case "forming":
      return t("lonora.market.patternForming");
    case "near_completion":
      return t("lonora.market.patternNear");
    case "completed_unconfirmed":
      return t("lonora.market.patternCompleted");
    case "confirmed":
      return t("lonora.market.patternConfirmed");
    case "failed":
      return t("lonora.market.patternFailed");
    default:
      return t("lonora.market.patternUnknown");
  }
}

type ZoneView = {
  type: "supply" | "demand";
  low: number;
  high: number;
  grade: "A" | "B" | "C" | "reject" | null;
  tradable: boolean;
  invented: false;
};

function readZone(value: ZoneView | null | undefined): ZoneView | null {
  if (!value || value.invented !== false) {
    return null;
  }
  if (value.type !== "supply" && value.type !== "demand") {
    return null;
  }
  if (!(value.low > 0) || !(value.high > value.low)) {
    return null;
  }
  if (
    value.grade != null &&
    value.grade !== "A" &&
    value.grade !== "B" &&
    value.grade !== "C" &&
    value.grade !== "reject"
  ) {
    return null;
  }
  return value;
}

function zonesText(
  demand: ZoneView | null,
  supply: ZoneView | null,
  error: string | null,
  candleCount: number,
) {
  if (!demand && !supply) {
    if (error && candleCount === 0) {
      return t("lonora.market.chartUnavailable");
    }
    return t("lonora.market.zonesNone");
  }
  return [demand, supply]
    .filter((zone): zone is ZoneView => zone != null)
    .map((zone) => {
      const label =
        zone.type === "demand" ? t("lonora.market.zonesDemand") : t("lonora.market.zonesSupply");
      const grade =
        zone.grade == null
          ? t("lonora.market.zonesUnread")
          : `${t("lonora.market.zonesGrade")} ${zone.grade}. ${
              zone.tradable ? t("lonora.market.zonesTradable") : t("lonora.market.zonesNotTradable")
            }`;
      return `${label} ${zone.low}–${zone.high}. ${grade}`;
    })
    .join(" ");
}

function finitePrice(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function poolText(
  price: number | null,
  labelKey: "lonora.market.poolsBuy" | "lonora.market.poolsSell",
) {
  if (price == null) {
    return `${t(labelKey)} ${t("lonora.market.poolsUnread")}`;
  }
  return `${t(labelKey)} ${price}`;
}

function sweepText(
  sweep: { side: "buy_side" | "sell_side"; sweptLevel: number } | null,
  error: string | null,
  candleCount: number,
) {
  if (sweep) {
    const side =
      sweep.side === "buy_side" ? t("lonora.market.sweepBuy") : t("lonora.market.sweepSell");
    return `${side} ${sweep.sweptLevel}`;
  }
  if (error && candleCount === 0) {
    return t("lonora.market.chartUnavailable");
  }
  return t("lonora.market.sweepNone");
}

function readSentence(summary: string | null, error: string | null, candleCount: number) {
  if (summary && summary.trim().length > 0) {
    return summary;
  }
  if (candleCount === 0) {
    return error ? t("lonora.market.chartUnavailable") : t("lonora.market.chartEmpty");
  }
  return t("lonora.market.chartUnavailable");
}

function lineColor(kind: ChartMark["kind"]): string {
  if (kind === "prior-high" || kind === "prior-low") {
    return "#8a7340";
  }
  if (kind === "buy-side") {
    return "#1f6f8a";
  }
  if (kind === "break") {
    return "#5b3a8a";
  }
  return "#8a4b1f";
}

function chartMarks(input: {
  priorDay: PriorDayView | null;
  buySide: number | null;
  sellSide: number | null;
  demand: ZoneView | null;
  supply: ZoneView | null;
  structureBreak: number | null;
}): ChartMark[] {
  const marks: ChartMark[] = [];
  if (input.priorDay && input.priorDay.invented === false) {
    marks.push(
      { kind: "prior-high", price: input.priorDay.high },
      { kind: "prior-low", price: input.priorDay.low },
    );
  }
  if (input.buySide != null) {
    marks.push({ kind: "buy-side", price: input.buySide });
  }
  if (input.sellSide != null) {
    marks.push({ kind: "sell-side", price: input.sellSide });
  }
  if (input.demand) {
    marks.push({ kind: "demand", low: input.demand.low, high: input.demand.high });
  }
  if (input.supply) {
    marks.push({ kind: "supply", low: input.supply.low, high: input.supply.high });
  }
  if (input.structureBreak != null) {
    marks.push({ kind: "break", price: input.structureBreak });
  }
  return marks;
}

function renderChart(candles: ChartCandle[], error: string | null, marks: ChartMark[]) {
  const chart = candleChart(candles, marks);
  if (!chart) {
    return html`<p>${error ?? t("lonora.market.chartEmpty")}</p>`;
  }
  return svg`<svg
    viewBox="0 0 ${chart.width} ${chart.height}"
    width="100%"
    role="img"
    aria-label=${t("lonora.market.chart")}
  >
    ${chart.bands.map(
      (band) => svg`
        <rect
          x="0"
          y=${band.y}
          width=${chart.width}
          height=${band.height}
          fill=${band.kind === "demand" ? "#1f8a4c22" : "#b4231822"}
        ></rect>
      `,
    )}
    ${chart.lines.map(
      (line) => svg`
        <line
          x1="0"
          x2=${chart.width}
          y1=${line.y}
          y2=${line.y}
          stroke=${lineColor(line.kind)}
        ></line>
      `,
    )}
    ${chart.bars.map(
      (bar) => svg`
        <line
          x1=${bar.x + bar.width / 2}
          x2=${bar.x + bar.width / 2}
          y1=${bar.highY}
          y2=${bar.lowY}
          stroke=${bar.up ? "#1f8a4c" : "#b42318"}
        ></line>
        <rect
          x=${bar.x}
          y=${bar.bodyY}
          width=${bar.width}
          height=${bar.bodyHeight}
          fill=${bar.up ? "#1f8a4c" : "#b42318"}
        ></rect>
      `,
    )}
  </svg>`;
}

function marketPriceLabel(snapshot: MarketSnapshot): string {
  if (
    snapshot.dataStatus === "unavailable" ||
    snapshot.dataStatus === "failed" ||
    snapshot.lastPrice == null
  ) {
    return t("lonora.market.noPrice");
  }
  return String(snapshot.lastPrice);
}

function marketDataLabel(snapshot: MarketSnapshot): string {
  switch (snapshot.dataStatus) {
    case "ok":
      return t("lonora.market.dataLive");
    case "stale":
      return t("lonora.market.dataStale");
    case "unavailable":
      return t("lonora.market.dataUnavailable");
    case "failed":
      return t("lonora.market.dataFailed");
    case "closed":
      return t("lonora.market.dataClosed");
    default:
      return snapshot.clock.isOpen ? t("lonora.market.dataLive") : t("lonora.market.dataClosed");
  }
}

customElements.define("openclaw-market-page", MarketPage);
