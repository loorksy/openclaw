import { definePage } from "@openclaw/uirouter";
import { html } from "lit";
import { routePageSpec } from "../../app-route-paths.ts";

export const page = definePage({
  ...routePageSpec("ai-models"),
  component: () =>
    import("./ai-models-page.ts").then(() => ({
      header: true,
      render: () => html`<openclaw-ai-models-page></openclaw-ai-models-page>`,
    })),
});
