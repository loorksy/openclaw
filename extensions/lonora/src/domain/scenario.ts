/**
 * One realized XAUUSD record, rebuilt from closed recommendations.
 * Below five completed outcomes the block states the count and does not
 * invent a win rate. A refresh replaces the previous block.
 */
import type { OwnerLanguage } from "./owner.js";
import type { RecommendationOutcome, RecommendationPlan } from "./recommendations.js";

export const SCENARIO_MIN_OBSERVATIONS = 5;
const WEAK_WIN_RATE = 35;

export interface ScenarioSummary {
  sample: number;
  wins: number;
  losses: number;
  winRate: number | null;
  averageR: number | null;
  text: string;
  writable: boolean;
}

export function summarizeScenario(
  plans: RecommendationPlan[],
  language: OwnerLanguage,
): ScenarioSummary {
  const completed = plans.filter(
    (plan) =>
      plan.symbol.replace(/[^a-z0-9]/gi, "").toUpperCase() === "XAUUSD" && isRecorded(plan.outcome),
  );
  const wins = completed.filter((plan) => plan.outcome.startsWith("win_")).length;
  const losses = completed.filter((plan) => plan.outcome === "loss").length;
  const sample = wins + losses;
  const winRate = sample >= SCENARIO_MIN_OBSERVATIONS ? Math.round((wins / sample) * 100) : null;
  const rs = completed.map(realizedR);
  const averageR =
    sample >= SCENARIO_MIN_OBSERVATIONS && rs.every((value) => value != null)
      ? Math.round((rs.reduce((sum, value) => sum + (value ?? 0), 0) / sample) * 100) / 100
      : null;
  return {
    sample,
    wins,
    losses,
    winRate,
    averageR,
    writable: sample >= SCENARIO_MIN_OBSERVATIONS,
    text: renderScenario({ sample, wins, losses, winRate, averageR, language }),
  };
}

function isRecorded(outcome: RecommendationOutcome): boolean {
  return outcome.startsWith("win_") || outcome === "loss";
}

function realizedR(plan: RecommendationPlan): number | null {
  if (plan.outcome === "loss") {
    return plan.stopLoss != null && Number.isFinite(plan.stopLoss) ? -1 : null;
  }
  const index =
    plan.outcome === "win_tp1"
      ? 0
      : plan.outcome === "win_tp2"
        ? 1
        : plan.outcome === "win_tp3"
          ? 2
          : -1;
  const target = index >= 0 ? plan.targets[index] : undefined;
  const entry = plan.effectiveEntry ?? plan.entry;
  const risk = Math.abs(entry - plan.stopLoss);
  if (target == null || !(risk > 0)) {
    return null;
  }
  return Math.abs(target - entry) / risk;
}

function renderScenario(input: {
  sample: number;
  wins: number;
  losses: number;
  winRate: number | null;
  averageR: number | null;
  language: OwnerLanguage;
}): string {
  const { sample, wins, losses, winRate, averageR, language } = input;
  if (language === "ar") {
    const lines = ["سجل الذهب المحقق"];
    lines.push(
      winRate == null
        ? `${sample} صفقات مكتملة: ${wins} رابحة و${losses} خاسرة. العينة أصغر من أن يُذكر معدل فوز.`
        : `${sample} صفقات مكتملة: ${wins} رابحة و${losses} خاسرة. معدل الفوز ${winRate}%.`,
    );
    if (averageR != null) {
      lines.push(`متوسط النتيجة ${averageR}R.`);
    }
    if (winRate != null && winRate <= WEAK_WIN_RATE) {
      lines.push("هذا السجل ضعيف. هو دليل، وليس صفقة جديدة.");
    }
    return lines.join("\n");
  }
  const lines = ["XAUUSD realized record"];
  lines.push(
    winRate == null
      ? `${sample} completed: ${wins} wins, ${losses} losses. The sample is too small to state a win rate.`
      : `${sample} completed: ${wins} wins, ${losses} losses. Win rate ${winRate}%.`,
  );
  if (averageR != null) {
    lines.push(`Average result ${averageR}R.`);
  }
  if (winRate != null && winRate <= WEAK_WIN_RATE) {
    lines.push("This record is weak. It is evidence, not a new trade.");
  }
  return lines.join("\n");
}
