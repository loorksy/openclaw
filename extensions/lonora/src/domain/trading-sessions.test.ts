import { describe, expect, it } from "vitest";
import { copy } from "./copy.js";
import { describeTradingCenters, getTradingSessionInfo, isCenterOpen } from "./trading-sessions.js";

describe("session windows follow each center's own clock", () => {
  it("names the London and New York overlap on a winter afternoon", () => {
    const info = getTradingSessionInfo(Date.UTC(2026, 0, 14, 15, 0));
    expect(info.active).toEqual(["london", "newyork"]);
    expect(info.overlap).toBe("london_newyork");
    expect(info.primary).toBe("newyork");
    expect(info.nextOpen).toBeNull();
    const text = describeTradingCenters(info, "en");
    expect(text).toBe("London and New York are open. London and New York overlap.");
    expect(text).not.toMatch(/breakout|liquidity|trend|spread/i);
    expect(describeTradingCenters(info, "ar")).toBe("لندن ونيويورك مفتوحتان. تداخل لندن ونيويورك.");
  });

  it("keeps that overlap in summer when both clocks move together", () => {
    const info = getTradingSessionInfo(Date.UTC(2026, 6, 15, 15, 0));
    expect(info.active).toEqual(["london", "newyork"]);
    expect(info.overlap).toBe("london_newyork");
  });

  it("lets US daylight time decide whether 12:30 UTC includes New York", () => {
    const beforeDst = getTradingSessionInfo(Date.UTC(2026, 2, 5, 12, 30));
    expect(beforeDst.active).not.toContain("newyork");
    expect(beforeDst.primary).toBe("london");
    expect(beforeDst.overlap).toBeNull();
    const insideDst = getTradingSessionInfo(Date.UTC(2026, 2, 25, 12, 30));
    expect(insideDst.active).toContain("newyork");
    expect(insideDst.overlap).toBe("london_newyork");
  });

  it("names Sydney and Tokyo while London and New York are closed", () => {
    const info = getTradingSessionInfo(Date.UTC(2026, 0, 14, 2, 0));
    expect(info.active).toEqual(["sydney", "tokyo"]);
    expect(info.overlap).toBe("sydney_tokyo");
    expect(info.primary).toBe("tokyo");
    expect(describeTradingCenters(info, "en")).toBe(
      "Sydney and Tokyo are open. Sydney and Tokyo overlap.",
    );
  });

  it("uses each center's own weekday", () => {
    const sundayEveningUtc = Date.UTC(2026, 0, 18, 21, 0);
    expect(isCenterOpen("sydney", sundayEveningUtc)).toBe(true);
    expect(isCenterOpen("newyork", sundayEveningUtc)).toBe(false);
  });

  it("names Sydney as the next center on a Saturday gap", () => {
    const info = getTradingSessionInfo(Date.UTC(2026, 0, 17, 12, 0));
    expect(info.active).toEqual([]);
    expect(info.primary).toBeNull();
    expect(info.nextOpen).toEqual({ session: "sydney", inMs: 32 * 3_600_000 });
    expect(describeTradingCenters(info, "en")).toBe(
      `${copy("en", "session.centersNone")} ${copy("en", "session.centersNext")} Sydney 32h.`,
    );
    expect(describeTradingCenters(info, "ar")).toContain("سيدني");
    expect(describeTradingCenters(info, "ar")).toContain("32 س");
  });
});
