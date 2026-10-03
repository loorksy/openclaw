import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";

type Recommendation = {
  id: string;
  symbol: string;
  direction: string;
  entry: number;
  stop: number;
  targets: number[];
  status: string;
  outcome: string;
  rationale?: string;
};

class RecommendationsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private plans: Recommendation[] = [];
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
      this.error = t("lonora.recommendations.disconnected");
      this.plans = [];
      return;
    }
    if (isGatewayMethodAdvertised(gateway.snapshot, "lonora.recommendations.list") === false) {
      this.error = t("lonora.recommendations.unavailable");
      this.plans = [];
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const result = await client.request<Recommendation[]>("lonora.recommendations.list", {});
      this.plans = Array.isArray(result) ? result : [];
    } catch (error) {
      this.plans = [];
      this.error =
        error instanceof Error ? error.message : t("lonora.recommendations.unavailable");
    } finally {
      this.loading = false;
    }
  }

  override render() {
    return html`
      <section class="content" style="padding: 24px; max-width: 880px;">
        <header>
          <h1>${titleForRoute("recommendations")}</h1>
          <p>${t("lonora.recommendations.lead")}</p>
        </header>
        <button class="btn" type="button" ?disabled=${this.loading} @click=${() => void this.load()}>
          ${t("common.refresh")}
        </button>
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        ${
          !this.error && this.plans.length === 0
            ? html`<p>${t("lonora.recommendations.empty")}</p>`
            : html`<ul>
                ${this.plans.map(
                  (plan) => html`
                    <li>
                      <strong>${plan.symbol} ${plan.direction}</strong>
                      · ${plan.status} · ${plan.outcome}
                      <div>
                        ${t("lonora.recommendations.entry")} ${plan.entry} ·
                        ${t("lonora.recommendations.stop")} ${plan.stop} ·
                        ${t("lonora.recommendations.targets")} ${plan.targets.join(", ")}
                      </div>
                      ${plan.rationale ? html`<p>${plan.rationale}</p>` : nothing}
                    </li>
                  `,
                )}
              </ul>`
        }
      </section>
    `;
  }
}

customElements.define("openclaw-recommendations-page", RecommendationsPage);
