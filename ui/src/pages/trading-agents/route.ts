import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("trading-agents"),
  component: () =>
    import("./trading-agents-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-trading-agents-page></openclaw-trading-agents-page>`,
    })),
});
