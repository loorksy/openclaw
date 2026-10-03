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
import { candleChart, type ChartCandle } from "./chart.ts";

registerLonoraEnglish();

type MarketSnapshot = {
  symbol: string;
  message: string;
  lastPrice: number | null;
  stale: boolean;
  invented: false;
  clock: { isOpen: boolean; session: string; reason: string };
  recommendations: { id: string; direction: string; status: string }[];
  responsibilities: { id: string; title: string; status: string }[];
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
  @state() private pattern: SwingRangeView | null = null;
  @state() private candleShape: CandleShapeView | null = null;
  @state() private chartError: string | null = null;
  @state() private error: string | null = null;
  @state() private headlineText: string | null = null;
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
      this.pattern = null;
      this.candleShape = null;
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
      this.pattern = null;
      this.candleShape = null;
      this.chartError = t("lonora.market.chartUnavailable");
      return;
    }
    try {
      const read = await target.client.request<{
        ok: boolean;
        candles: ChartCandle[];
        latestSweep?: { side: "buy_side" | "sell_side"; sweptLevel: number } | null;
        pattern?: SwingRangeView | null;
        candleShape?: CandleShapeView | null;
        invented: false;
        error?: string | null;
      }>("lonora.candles.read", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      this.candles = read.invented ? [] : read.candles;
      this.latestSweep = read.invented ? null : (read.latestSweep ?? null);
      this.pattern =
        read.invented || read.pattern?.inventedTarget !== false ? null : (read.pattern ?? null);
      this.candleShape =
        read.invented || read.candleShape?.inventedTarget !== false
          ? null
          : (read.candleShape ?? null);
      this.chartError = read.ok ? null : (read.error ?? t("lonora.market.chartEmpty"));
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.candles = [];
      this.latestSweep = null;
      this.pattern = null;
      this.candleShape = null;
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
                  <dd>${snapshot.clock.session}</dd>
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
                  <dd>${snapshot.assessment ?? snapshot.message}</dd>
                  <dt>${t("lonora.market.calendar")}</dt>
                  <dd>${snapshot.calendar?.summary ?? t("lonora.market.calendarUnknown")}</dd>
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
                ${renderChart(this.candles, this.chartError)}
                <h2>${t("lonora.market.sweep")}</h2>
                <p>${sweepText(this.latestSweep, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.pattern")}</h2>
                <p>${patternText(this.pattern, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.candle")}</h2>
                <p>${candleText(this.candleShape, this.chartError, this.candles.length)}</p>
                <h2>${t("lonora.market.activeRecommendations")}</h2>
                ${
                  snapshot.recommendations.length
                    ? html`<ul>
                        ${snapshot.recommendations.map(
                          (plan) => html`<li>${plan.id}: ${plan.direction} · ${plan.status}</li>`,
                        )}
                      </ul>`
                    : html`<p>${t("lonora.market.noRecommendations")}</p>`
                }
                <h2>${t("lonora.market.responsibilities")}</h2>
                ${
                  snapshot.responsibilities.length
                    ? html`<ul>
                        ${snapshot.responsibilities.map(
                          (row) => html`<li>${row.title} · ${row.status}</li>`,
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

function renderChart(candles: ChartCandle[], error: string | null) {
  const chart = candleChart(candles);
  if (!chart) {
    return html`<p>${error ?? t("lonora.market.chartEmpty")}</p>`;
  }
  return svg`<svg
    viewBox="0 0 ${chart.width} ${chart.height}"
    width="100%"
    role="img"
    aria-label=${t("lonora.market.chart")}
  >
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
