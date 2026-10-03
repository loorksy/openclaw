import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("responsibilities"),
  component: () =>
    import("./responsibilities-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-responsibilities-page></openclaw-responsibilities-page>`,
    })),
});
