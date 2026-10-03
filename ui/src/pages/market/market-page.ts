import { consume } from "@lit/context";
import { html, nothing, svg } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { lonoraRequestTarget } from "../lonora/request.ts";
import { candleChart, type ChartCandle } from "./chart.ts";

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
};

class MarketPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private snapshot: MarketSnapshot | null = null;
  @state() private candles: ChartCandle[] = [];
  @state() private latestSweep: { side: "buy_side" | "sell_side"; sweptLevel: number } | null =
    null;
  @state() private chartError: string | null = null;
  @state() private error: string | null = null;
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
      await this.loadCandles(generation);
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

  private async loadCandles(generation: number) {
    const target = lonoraRequestTarget(this.context, "lonora.candles.read");
    if (!target.ok) {
      this.candles = [];
      this.latestSweep = null;
      this.chartError = t("lonora.market.chartUnavailable");
      return;
    }
    try {
      const read = await target.client.request<{
        ok: boolean;
        candles: ChartCandle[];
        latestSweep?: { side: "buy_side" | "sell_side"; sweptLevel: number } | null;
        invented: false;
        error?: string | null;
      }>("lonora.candles.read", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      this.candles = read.invented ? [] : read.candles;
      this.latestSweep = read.invented ? null : (read.latestSweep ?? null);
      this.chartError = read.ok ? null : (read.error ?? t("lonora.market.chartEmpty"));
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.candles = [];
      this.latestSweep = null;
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
                </dl>
                <h2>${t("lonora.market.chart")}</h2>
                ${renderChart(this.candles, this.chartError)}
                <h2>${t("lonora.market.sweep")}</h2>
                <p>${sweepText(this.latestSweep, this.chartError, this.candles.length)}</p>
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
