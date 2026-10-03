import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

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
  assessment?: string | null;
};

class MarketPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private snapshot: MarketSnapshot | null = null;
  @state() private error: string | null = null;
  @state() private loading = false;

  private readonly subscriptions = new SubscriptionsController(this).watchStore(
    () => this.context?.gateway,
  );

  override connectedCallback() {
    super.connectedCallback();
    void this.load();
  }

  private async load() {
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.client;
    if (!client || gateway.snapshot.phase !== "connected") {
      this.error = t("lonora.market.disconnected");
      this.snapshot = null;
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
      this.snapshot = await client.request<MarketSnapshot>("lonora.market.snapshot", {});
    } catch (error) {
      this.snapshot = null;
      this.error = error instanceof Error ? error.message : t("lonora.market.unavailable");
    } finally {
      this.loading = false;
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
        <button class="btn" type="button" ?disabled=${this.loading} @click=${() => void this.load()}>
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
                  <dd>${snapshot.clock.isOpen ? t("lonora.market.open") : t("lonora.market.closed")}</dd>
                  <dt>${t("lonora.market.price")}</dt>
                  <dd>${snapshot.lastPrice ?? t("lonora.market.noPrice")}</dd>
                  <dt>${t("lonora.market.assessment")}</dt>
                  <dd>${snapshot.assessment ?? snapshot.message}</dd>
                </dl>
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

customElements.define("openclaw-market-page", MarketPage);
