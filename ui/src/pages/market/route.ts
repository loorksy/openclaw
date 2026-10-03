import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("market"),
  component: () =>
    import("./market-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-market-page></openclaw-market-page>`,
    })),
});
