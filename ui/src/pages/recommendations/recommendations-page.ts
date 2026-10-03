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
  stop?: number;
  stopLoss?: number;
  targets?: number[];
  status: string;
  outcome: string;
  rationale?: string;
  activationSummary?: string | null;
};

class RecommendationsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private plans: Recommendation[] = [];
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
      if (generation !== this.loadGeneration) {
        return;
      }
      this.plans = Array.isArray(result) ? result : [];
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.plans = [];
      this.error = error instanceof Error ? error.message : t("lonora.recommendations.unavailable");
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
      }
    }
  }

  override render() {
    return html`
      <section class="content" style="padding: 24px; max-width: 880px;">
        <header>
          <h1>${titleForRoute("recommendations")}</h1>
          <p>${t("lonora.recommendations.lead")}</p>
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
          !this.error && this.plans.length === 0
            ? html`<p>${t("lonora.recommendations.empty")}</p>`
            : html`<ul>
                ${this.plans.map((plan) => {
                  const stop = plan.stopLoss ?? plan.stop;
                  const targets = Array.isArray(plan.targets) ? plan.targets : [];
                  return html`
                    <li>
                      <strong>${plan.symbol} ${plan.direction}</strong>
                      · ${plan.status} · ${plan.outcome}
                      <div>
                        ${t("lonora.recommendations.entry")} ${plan.entry} ·
                        ${t("lonora.recommendations.stop")} ${stop ?? t("common.na")} ·
                        ${t("lonora.recommendations.targets")}
                        ${targets.length ? targets.join(", ") : t("common.na")}
                      </div>
                      ${
                        plan.activationSummary
                          ? html`<p>
                              ${t("lonora.recommendations.activation")} ${plan.activationSummary}
                            </p>`
                          : nothing
                      }
                      ${plan.rationale ? html`<p>${plan.rationale}</p>` : nothing}
                    </li>
                  `;
                })}
              </ul>`
        }
      </section>
    `;
  }
}

customElements.define("openclaw-recommendations-page", RecommendationsPage);
