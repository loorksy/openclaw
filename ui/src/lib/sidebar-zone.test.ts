import { describe, expect, it } from "vitest";
import { SIDEBAR_NAV_ROUTES } from "../app-navigation.ts";
import { reconcileSidebarZone } from "./sidebar-zone.ts";

describe("reconcileSidebarZone", () => {
  it("preserves route and pinned-session interleaving", () => {
    const result = reconcileSidebarZone(
      ["route:market", "session:agent:main:alpha", "route:skills"],
      [{ key: "agent:main:alpha" }],
      SIDEBAR_NAV_ROUTES,
    );

    expect(result.entries).toEqual([
      { type: "route", route: "market" },
      { type: "session", key: "agent:main:alpha" },
      { type: "route", route: "skills" },
    ]);
    expect(result.sidebarEntries).toEqual([
      "route:market",
      "session:agent:main:alpha",
      "route:skills",
    ]);
  });

  it("prunes known-unpinned sessions and appends server-pinned sessions", () => {
    const result = reconcileSidebarZone(
      ["session:agent:main:stale", "route:market", "session:agent:main:alpha"],
      [{ key: "agent:main:alpha" }, { key: "agent:main:beta" }],
      SIDEBAR_NAV_ROUTES,
      new Set(["agent:main:stale"]),
    );

    expect(result.sidebarEntries).toEqual([
      "route:market",
      "session:agent:main:alpha",
      "session:agent:main:beta",
    ]);
  });

  it("keeps unknown-state session entries in place without rendering them", () => {
    // agent-b's pinned session is not loaded in this view; its slot must
    // survive a canonical write or synced prefs lose cross-agent order.
    const result = reconcileSidebarZone(
      ["session:agent:b:remote", "route:market", "session:agent:main:alpha"],
      [{ key: "agent:main:alpha" }],
      SIDEBAR_NAV_ROUTES,
      new Set(["agent:main:other"]),
    );

    expect(result.entries).toEqual([
      { type: "route", route: "market" },
      { type: "session", key: "agent:main:alpha" },
    ]);
    expect(result.sidebarEntries).toEqual([
      "session:agent:b:remote",
      "route:market",
      "session:agent:main:alpha",
    ]);
  });

  it("drops routes outside the supplied valid route set", () => {
    expect(
      reconcileSidebarZone(["route:market", "route:skills"], [], ["market"]).sidebarEntries,
    ).toEqual(["route:market"]);
  });

  it("migrates shipped Workboard placements to plugin destinations", () => {
    const result = reconcileSidebarZone(
      ["route:market", "route:workboard", "workboard:ops"],
      [],
      SIDEBAR_NAV_ROUTES,
      new Set(),
      new Set(["workboard/workboard", "workboard/board-ops"]),
    );
    expect(result.sidebarEntries).toEqual([
      "route:market",
      "plugin:workboard/workboard",
      "plugin:workboard/board-ops",
    ]);
    expect(result.entries).toEqual([
      { type: "route", route: "market" },
      { type: "plugin", key: "workboard/workboard" },
      { type: "plugin", key: "workboard/board-ops" },
    ]);
  });

  it("preserves unavailable plugin positions through reloads and permission loss", () => {
    const entries = ["plugin:example/review", "route:market"];
    expect(reconcileSidebarZone(entries, [], SIDEBAR_NAV_ROUTES)).toEqual({
      entries: [{ type: "route", route: "market" }],
      sidebarEntries: entries,
    });
    expect(
      reconcileSidebarZone(entries, [], SIDEBAR_NAV_ROUTES, new Set(), new Set(["example/review"]))
        .entries,
    ).toEqual([
      { type: "plugin", key: "example/review" },
      { type: "route", route: "market" },
    ]);
  });
});
