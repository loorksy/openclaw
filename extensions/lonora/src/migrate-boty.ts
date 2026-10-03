/**
 * Import a Boty SQLite file into Lonora.
 * Defaults to dry-run. Refuses to guess when more than one user exists.
 * Does not delete the source database.
 */
import { DatabaseSync } from "node:sqlite";
import { isGoldSymbol } from "./domain/candles.js";
import { OwnerSelectionRequired, resolveOwnerCandidate } from "./domain/owner.js";
import type {
  RecommendationOutcome,
  RecommendationPlan,
  RecommendationStatus,
} from "./domain/recommendations.js";
import { LonoraStore } from "./store.js";

export interface MigrationReport {
  dryRun: boolean;
  ownerId: string | null;
  recommendations: number;
  memories: number;
  telegramBound: boolean;
  language: "en" | "ar";
  warnings: string[];
}

interface BotyUser {
  id: number;
  email: string;
}

export function planBotyMigration(input: {
  sourcePath: string;
  target: LonoraStore;
  apply?: boolean;
  ownerId?: string;
}): MigrationReport {
  const source = new DatabaseSync(input.sourcePath, { readOnly: true });
  try {
    const users = source
      .prepare("SELECT id, email FROM users ORDER BY id")
      .all() as unknown as BotyUser[];
    if (users.length === 0) {
      throw new Error("Boty database has no users. Nothing was imported.");
    }
    const selected = resolveOwnerCandidate(
      users.map((user) => ({ id: String(user.id) })),
      input.ownerId,
    );
    const user = users.find((candidate) => String(candidate.id) === selected.id)!;
    const settings = source
      .prepare("SELECT language, telegram_chat_id FROM trading_settings WHERE user_id = ?")
      .get(user.id) as { language: string | null; telegram_chat_id: string | null } | undefined;
    const recommendations = source
      .prepare(
        `SELECT id, symbol, direction, entry, stop_loss, targets_json, rationale, confidence, status
         FROM recommendations WHERE user_id = ?`,
      )
      .all(user.id) as {
      id: number;
      symbol: string;
      direction: string | null;
      entry: number | null;
      stop_loss: number | null;
      targets_json: string;
      rationale: string | null;
      confidence: number;
      status: string;
    }[];
    const memories = source
      .prepare(
        `SELECT id, content, memory_type, symbol FROM semantic_memories
         WHERE user_id = ? AND archived = 0`,
      )
      .all(user.id) as {
      id: number;
      content: string;
      memory_type: string;
      symbol: string | null;
    }[];
    const language = settings?.language === "ar" ? "ar" : "en";
    const report: MigrationReport = {
      dryRun: input.apply !== true,
      ownerId: String(user.id),
      recommendations: recommendations.length,
      memories: memories.length,
      telegramBound: Boolean(settings?.telegram_chat_id),
      language,
      warnings: [],
    };
    if (recommendations.some((row) => row.entry == null || row.stop_loss == null)) {
      report.warnings.push("Some recommendations have no entry or stop and will be skipped.");
    }
    const foreign = recommendations.filter((row) => !isGoldSymbol(row.symbol ?? ""));
    if (foreign.length > 0) {
      report.warnings.push(`${foreign.length} recommendations are not XAUUSD and will be skipped.`);
    }
    if (input.apply !== true) {
      return report;
    }
    const importedAt = Date.now();
    input.target.transaction(() => {
      input.target.adoptOwner({
        id: String(user.id),
        label: user.email,
        language,
        telegramChatId: settings?.telegram_chat_id ?? null,
        source: "migration",
      });
      for (const row of recommendations) {
        if (
          !isGoldSymbol(row.symbol ?? "") ||
          row.entry == null ||
          row.stop_loss == null ||
          (row.direction !== "buy" && row.direction !== "sell")
        ) {
          continue;
        }
        const lifecycle = importedLifecycle(row.status);
        if (!lifecycle) {
          report.warnings.push(
            `Skipped recommendation ${row.id} with unrecognized status ${row.status}.`,
          );
          continue;
        }
        const targets = parseTargets(row.targets_json);
        const createdAt = recommendationCreatedAt(source, row.id, importedAt);
        const plan: RecommendationPlan = {
          id: `boty-${row.id}`,
          symbol: "XAUUSD",
          direction: row.direction,
          entryType: "limit_touch",
          entry: row.entry,
          stopLoss: row.stop_loss,
          targets,
          status: lifecycle.status,
          outcome: lifecycle.outcome,
          createdCandleTime: createdAt,
          createdAt,
          rationale: row.rationale ?? undefined,
          confidence: row.confidence,
        };
        input.target.saveRecommendation(plan);
      }
      for (const memory of memories) {
        input.target.addMemory({
          kind: mapMemory(memory.memory_type),
          content: memory.content,
          symbol: memory.symbol ?? undefined,
        });
      }
    });
    report.dryRun = false;
    return report;
  } finally {
    source.close();
  }
}

function importedLifecycle(
  status: string,
): { status: RecommendationStatus; outcome: RecommendationOutcome } | null {
  switch (status) {
    case "pending_entry":
    case "active":
    case "pending":
      return { status: "pending_entry", outcome: "pending" };
    case "triggered":
      return { status: "triggered", outcome: "pending" };
    case "tp1_hit":
      return { status: "tp1_hit", outcome: "win_tp1" };
    case "tp2_hit":
      return { status: "tp2_hit", outcome: "win_tp2" };
    case "tp3_hit":
      return { status: "tp3_hit", outcome: "win_tp3" };
    case "sl_hit":
      return { status: "sl_hit", outcome: "loss" };
    case "invalidated":
      return { status: "invalidated", outcome: "invalidated" };
    case "expired":
      return { status: "expired", outcome: "expired" };
    case "cancelled":
      return { status: "cancelled", outcome: "cancelled" };
    default:
      return null;
  }
}

function recommendationCreatedAt(source: DatabaseSync, rowId: number, importedAt: number): number {
  const columns = source.prepare("PRAGMA table_info(recommendations)").all() as { name: string }[];
  const names = new Set(columns.map((column) => column.name));
  const column = ["created_candle_time", "created_at", "createdAt"].find((name) => names.has(name));
  if (!column) {
    return importedAt;
  }
  const row = source
    .prepare(`SELECT ${column} AS created FROM recommendations WHERE id = ?`)
    .get(rowId) as { created: unknown } | undefined;
  return candleTime(row?.created, importedAt);
}

function candleTime(value: unknown, fallback: number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value < 1_000_000_000_000 ? Math.trunc(value * 1000) : Math.trunc(value);
}

function parseTargets(value: string): number[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "number") : [];
  } catch {
    return [];
  }
}

function mapMemory(type: string): "lesson" | "historical_case" | "conversation" | "research" {
  if (type.includes("lesson")) {
    return "lesson";
  }
  if (type.includes("case") || type.includes("scenario")) {
    return "historical_case";
  }
  if (type.includes("research")) {
    return "research";
  }
  return "conversation";
}

export function formatMigrationFailure(error: unknown): string {
  if (error instanceof OwnerSelectionRequired) {
    return `${error.message} Re-run with --owner-id. No rows were written.`;
  }
  return error instanceof Error ? error.message : String(error);
}
