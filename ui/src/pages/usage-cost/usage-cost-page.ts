import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { lonoraRequestTarget } from "../lonora/request.ts";

type UsageSummary = {
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
};

class UsageCostPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private summary: UsageSummary | null = null;
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
    const target = lonoraRequestTarget(this.context, "lonora.usage.summary");
    if (!target.ok) {
      this.error = t(
        target.reason === "disconnected" ? "lonora.usage.disconnected" : "lonora.usage.unavailable",
      );
      this.summary = null;
      this.loading = false;
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const summary = await target.client.request<UsageSummary>("lonora.usage.summary", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      this.summary = summary;
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.summary = null;
      this.error = error instanceof Error ? error.message : t("lonora.usage.unavailable");
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
      }
    }
  }

  override render() {
    const summary = this.summary;
    return html`
      <section class="content" style="padding: 24px; max-width: 880px;">
        <header>
          <h1>${titleForRoute("usage-cost")}</h1>
          <p>${t("lonora.usage.lead")}</p>
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
          summary
            ? html`
                <p>${t("lonora.usage.estimated")}</p>
                <dl>
                  <dt>${t("lonora.usage.costToday")}</dt>
                  <dd>${money(summary.costTodayUsd)}</dd>
                  <dt>${t("lonora.usage.costMonth")}</dt>
                  <dd>${money(summary.costMonthUsd)}</dd>
                  <dt>${t("lonora.usage.tokensToday")}</dt>
                  <dd>${summary.tokensToday}</dd>
                  <dt>${t("lonora.usage.tokensMonth")}</dt>
                  <dd>${summary.tokensMonth}</dd>
                  <dt>${t("lonora.usage.unpriced")}</dt>
                  <dd>${summary.unpricedEvents}</dd>
                </dl>
                ${breakdown(t("lonora.usage.byProvider"), summary.byProvider)}
                ${breakdown(t("lonora.usage.byModel"), summary.byModel)}
                ${breakdown(t("lonora.usage.byFeature"), summary.byFeature)}
                ${breakdown(t("lonora.usage.byAgent"), summary.byAgent)}
              `
            : nothing
        }
      </section>
    `;
  }
}

function money(value: number | null): string {
  if (value == null) {
    return t("lonora.usage.none");
  }
  return `$${value.toFixed(4)}`;
}

function breakdown(title: string, rows: Record<string, number>) {
  const entries = Object.entries(rows);
  if (entries.length === 0) {
    return html`<h2>${title}</h2>
      <p>${t("lonora.usage.none")}</p>`;
  }
  return html`
    <h2>${title}</h2>
    <ul>
      ${entries.map(([key, value]) => html`<li>${key}: $${value.toFixed(4)}</li>`)}
    </ul>
  `;
}

customElements.define("openclaw-usage-cost-page", UsageCostPage);
