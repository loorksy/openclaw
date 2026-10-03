import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("recommendations"),
  component: () =>
    import("./recommendations-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-recommendations-page></openclaw-recommendations-page>`,
    })),
});
