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

type Responsibility = {
  id: string;
  title: string;
  instruction: string;
  status: "running" | "paused" | "cancelled" | "scheduled";
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  lastEvent: string | null;
};

class ResponsibilitiesPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @state() private rows: Responsibility[] = [];
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
    const target = lonoraRequestTarget(this.context, "lonora.tasks.list");
    if (!target.ok) {
      this.error = t(
        target.reason === "disconnected" ? "lonora.tasks.disconnected" : "lonora.tasks.unavailable",
      );
      this.rows = [];
      this.loading = false;
      return;
    }
    this.loading = true;
    this.error = null;
    try {
      const rows = await target.client.request<Responsibility[]>("lonora.tasks.list", {});
      if (generation !== this.loadGeneration) {
        return;
      }
      this.rows = rows;
    } catch (error) {
      if (generation !== this.loadGeneration) {
        return;
      }
      this.rows = [];
      this.error = error instanceof Error ? error.message : t("lonora.tasks.unavailable");
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
      }
    }
  }

  private async setStatus(id: string, status: "running" | "paused" | "cancelled") {
    const target = lonoraRequestTarget(this.context, "lonora.tasks.setStatus");
    if (!target.ok) {
      this.error = t(
        target.reason === "disconnected" ? "lonora.tasks.disconnected" : "lonora.tasks.unavailable",
      );
      return;
    }
    this.loading = true;
    try {
      await target.client.request("lonora.tasks.setStatus", { id, status });
      await this.load();
    } catch (error) {
      this.error = error instanceof Error ? error.message : t("lonora.tasks.unavailable");
      this.loading = false;
    }
  }

  override render() {
    return html`
      <section class="content" style="padding: 24px; max-width: 880px;">
        <header>
          <h1>${titleForRoute("responsibilities")}</h1>
          <p>${t("lonora.tasks.lead")}</p>
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
                      <strong>${row.title}</strong>
                      <p>${row.instruction}</p>
                      <p>${statusLabel(row.status)}</p>
                      <p>${t("lonora.tasks.lastCheck")} ${whenLabel(row.lastCheckAt)}</p>
                      <p>${t("lonora.tasks.nextCheck")} ${nextLabel(row.nextCheckAt)}</p>
                      <p>${t("lonora.tasks.lastEvent")} ${row.lastEvent ?? t("common.na")}</p>
                      ${
                        row.status === "cancelled"
                          ? nothing
                          : html`
                              <button
                                class="btn"
                                type="button"
                                ?disabled=${this.loading || row.status === "paused"}
                                @click=${() => void this.setStatus(row.id, "paused")}
                              >
                                ${t("lonora.tasks.pause")}
                              </button>
                              <button
                                class="btn"
                                type="button"
                                ?disabled=${this.loading || row.status === "running"}
                                @click=${() => void this.setStatus(row.id, "running")}
                              >
                                ${t("lonora.tasks.resume")}
                              </button>
                              <button
                                class="btn"
                                type="button"
                                ?disabled=${this.loading}
                                @click=${() => void this.setStatus(row.id, "cancelled")}
                              >
                                ${t("lonora.tasks.cancel")}
                              </button>
                            `
                      }
                    </li>
                  `,
                )}
              </ul>`
            : this.error
              ? nothing
              : html`<p>${t("lonora.tasks.empty")}</p>`
        }
      </section>
    `;
  }
}

function statusLabel(status: Responsibility["status"]): string {
  return t(`lonora.tasks.status.${status}`);
}

function whenLabel(ms: number | null): string {
  if (ms == null) {
    return t("lonora.tasks.notChecked");
  }
  const minutes = Math.max(0, Math.floor((Date.now() - ms) / 60_000));
  if (minutes < 1) {
    return t("lonora.tasks.justNow");
  }
  if (minutes < 60) {
    return t("lonora.tasks.minutesAgo", { count: String(minutes) });
  }
  return t("lonora.tasks.hoursAgo", { count: String(Math.floor(minutes / 60)) });
}

function nextLabel(ms: number | null): string {
  if (ms == null) {
    return t("lonora.tasks.waitingEvent");
  }
  return new Date(ms).toISOString();
}

customElements.define("openclaw-responsibilities-page", ResponsibilitiesPage);
