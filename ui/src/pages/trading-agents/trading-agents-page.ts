import { consume } from "@lit/context";
import { html, nothing } from "lit";
import { state } from "lit/decorators.js";
import { titleForRoute } from "../../app-navigation.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import { registerLonoraEnglish } from "../../i18n/locales/en-lonora.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { lonoraRequestTarget } from "../lonora/request.ts";

registerLonoraEnglish();

type AgentRow = {
  agent: string;
  state: "running" | "on_demand";
  purpose: string;
  lastRunAt: number | null;
  lastResult: string | null;
  tokens: number;
};

class TradingAgentsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private rows: AgentRow[] = [];
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
    const target = lonoraRequestTarget(this.context, "lonora.agents.list");
    if (!target.ok) {
      this.error = t(
        target.reason === "disconnected"
          ? "lonora.agents.disconnected"
          : "lonora.agents.unavailable",
      );
      this.rows = [];
      this.loading = false;
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const rows = await target.client.request<AgentRow[]>("lonora.agents.list", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      this.rows = rows;
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.rows = [];
      this.error = error instanceof Error ? error.message : t("lonora.agents.unavailable");
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
          <h1>${titleForRoute("trading-agents")}</h1>
          <p>${t("lonora.agents.lead")}</p>
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
          this.rows.length
            ? html`<ul>
                ${this.rows.map(
                  (row) => html`
                    <li>
                      <strong>${t(`lonora.agents.names.${row.agent}`)}</strong>
                      <p>${t(`lonora.agents.state.${row.state}`)}</p>
                      <p>${row.purpose}</p>
                      <p>
                        ${t("lonora.agents.lastRun")}
                        ${row.lastRunAt == null ? t("lonora.agents.none") : new Date(row.lastRunAt).toISOString()}
                      </p>
                      <p>
                        ${t("lonora.agents.lastResult")}
                        ${row.lastResult ?? t("lonora.agents.none")}
                      </p>
                      <p>${t("lonora.agents.tokens")} ${row.tokens}</p>
                    </li>
                  `,
                )}
              </ul>`
            : this.error
              ? nothing
              : html`<p>${t("lonora.agents.unavailable")}</p>`
        }
      </section>
    `;
  }
}

customElements.define("openclaw-trading-agents-page", TradingAgentsPage);
