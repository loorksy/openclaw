import { describe, expect, it } from "vitest";
import type { RecommendationPlan } from "./recommendations.js";
import { summarizeScenario } from "./scenario.js";

function closed(outcome: RecommendationPlan["outcome"], id: string): RecommendationPlan {
  return {
    id,
    symbol: "XAUUSD",
    direction: "buy",
    entryType: "limit_touch",
    entry: 2300,
    effectiveEntry: 2300,
    stopLoss: 2290,
    targets: [2320, 2340, 2360],
    status: outcome === "loss" ? "sl_hit" : "tp1_hit",
    outcome,
    createdCandleTime: 1,
    createdAt: 1,
  };
}

describe("scenario memory", () => {
  it("does not state a win rate below five completed outcomes", () => {
    const summary = summarizeScenario(
      [closed("win_tp1", "a"), closed("loss", "b"), closed("loss", "c"), closed("expired", "d")],
      "en",
    );
    expect(summary.sample).toBe(3);
    expect(summary.winRate).toBeNull();
    expect(summary.writable).toBe(false);
    expect(summary.text).not.toMatch(/%/);
    expect(summary.text).toMatch(/too small/);
  });

  it("states the win rate and average R once five outcomes exist", () => {
    const summary = summarizeScenario(
      [
        closed("win_tp1", "a"),
        closed("win_tp1", "b"),
        closed("win_tp1", "c"),
        closed("loss", "d"),
        closed("loss", "e"),
      ],
      "en",
    );
    expect(summary.winRate).toBe(60);
    expect(summary.averageR).toBe(0.8);
    expect(summary.text).toMatch(/Win rate 60%/);
    expect(summary.text).not.toMatch(/weak/);
  });

  it("names a weak record without turning it into a trade", () => {
    const summary = summarizeScenario(
      [
        closed("win_tp1", "a"),
        closed("loss", "b"),
        closed("loss", "c"),
        closed("loss", "d"),
        closed("loss", "e"),
      ],
      "ar",
    );
    expect(summary.winRate).toBe(20);
    expect(summary.text).toMatch(/ضعيف/);
    expect(summary.text).toMatch(/ليس صفقة/);
  });
});
