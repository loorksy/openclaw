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
import { connectLonoraModel } from "./connect.ts";

registerLonoraEnglish();

type ProviderStatus = {
  provider: "anthropic" | "openai" | "zai" | "openrouter";
  connected: boolean;
  defaultModel: string | null;
  status: string;
  lastError: string | null;
};

const PROVIDER_LABELS: Record<ProviderStatus["provider"], string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  zai: "Z.AI",
  openrouter: "OpenRouter",
};

class AiModelsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private rows: ProviderStatus[] = [];
  @state() private error: string | null = null;
  @state() private loading = false;
  @state() private drafts: Record<string, string> = {};

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
    const target = lonoraRequestTarget(this.context, "lonora.providers.status");
    if (!target.ok) {
      this.error = t(
        target.reason === "disconnected"
          ? "lonora.models.disconnected"
          : "lonora.models.unavailable",
      );
      this.rows = [];
      this.loading = false;
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const rows = await target.client.request<ProviderStatus[]>("lonora.providers.status", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      this.rows = rows;
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.rows = [];
      this.error = error instanceof Error ? error.message : t("lonora.models.unavailable");
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
      }
    }
  }

  private async connect(provider: string) {
    const apiKey = this.drafts[provider] ?? "";
    const target = lonoraRequestTarget(this.context, "lonora.providers.connect");
    if (!target.ok) {
      this.error = t(
        target.reason === "disconnected"
          ? "lonora.models.disconnected"
          : "lonora.models.unavailable",
      );
      return;
    }
    this.loading = true;
    this.drafts = { ...this.drafts, [provider]: "" };
    try {
      const result = await connectLonoraModel(target.client, {
        provider,
        apiKey,
        agentId: this.context.gateway.snapshot.assistantAgentId || "main",
      });
      if (result.error) {
        this.error = result.error;
      } else if (result.warning) {
        this.error = result.warning;
      }
      await this.load();
    } catch (error) {
      this.error = error instanceof Error ? error.message : t("lonora.models.unavailable");
      this.loading = false;
    }
  }

  override render() {
    return html`
      <section class="content" style="padding: 24px; max-width: 880px;">
        <header>
          <h1>${titleForRoute("ai-models")}</h1>
          <p>${t("lonora.models.lead")}</p>
        </header>
        ${this.error ? html`<p role="alert">${this.error}</p>` : nothing}
        <ul>
          ${(this.rows.length
            ? this.rows
            : (Object.keys(PROVIDER_LABELS) as ProviderStatus["provider"][]).map((provider) => ({
                provider,
                connected: false,
                defaultModel: null,
                status: "not_connected",
                lastError: null,
              }))
          ).map((row) => {
            const label = PROVIDER_LABELS[row.provider] ?? row.provider;
            return html`
              <li>
                <h2>${label}</h2>
                <p>${connectionLabel(row)}</p>
                <p>${t("lonora.models.defaultModel")} ${row.defaultModel ?? t("common.na")}</p>
                ${row.lastError ? html`<p role="status">${row.lastError}</p>` : nothing}
                <form
                  @submit=${(event: Event) => {
                    event.preventDefault();
                    void this.connect(row.provider);
                  }}
                >
                  <label>
                    ${t("lonora.models.apiKey")}
                    <input
                      type="password"
                      autocomplete="off"
                      .value=${this.drafts[row.provider] ?? ""}
                      @input=${(event: Event) => {
                        const value = (event.target as HTMLInputElement).value;
                        this.drafts = { ...this.drafts, [row.provider]: value };
                      }}
                    />
                  </label>
                  <button class="btn" type="submit" ?disabled=${this.loading}>
                    ${t("lonora.models.connect")}
                  </button>
                </form>
              </li>
            `;
          })}
        </ul>
      </section>
    `;
  }
}

function connectionLabel(row: ProviderStatus): string {
  if (row.connected) {
    return t("lonora.models.connected");
  }
  if (row.status === "invalid") {
    return t("lonora.models.invalid");
  }
  return t("lonora.models.notConnected");
}

customElements.define("openclaw-ai-models-page", AiModelsPage);
