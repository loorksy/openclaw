import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("usage-cost"),
  component: () =>
    import("./usage-cost-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-usage-cost-page></openclaw-usage-cost-page>`,
    })),
});
