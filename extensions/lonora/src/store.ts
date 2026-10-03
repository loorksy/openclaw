import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { HistoricalCase } from "./domain/cases.js";
import type { OwnerLanguage, OwnerRecord } from "./domain/owner.js";
import type { RecommendationPlan } from "./domain/recommendations.js";
import type { UsageEvent, UsageFeature } from "./domain/usage.js";

export type MemoryKind =
  | "conversation"
  | "preference"
  | "responsibility"
  | "market_observation"
  | "recommendation"
  | "historical_case"
  | "lesson"
  | "research"
  | "scenario";

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  content: string;
  symbol: string | null;
  createdAt: number;
}

export interface ResponsibilityRow {
  id: string;
  title: string;
  instruction: string;
  status: "running" | "paused" | "cancelled" | "scheduled";
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  lastEvent: string | null;
}

export interface NoticeRow {
  key: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastAttemptAt: number | null;
  cooldownUntil: number;
  payload: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS owner (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  language TEXT NOT NULL,
  telegram_chat_id TEXT,
  source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS recommendations (
  id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  symbol TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS responsibilities (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  last_check_at INTEGER,
  next_check_at INTEGER,
  last_event TEXT
);
CREATE TABLE IF NOT EXISTS notices (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL,
  last_attempt_at INTEGER,
  cooldown_until INTEGER NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  feature TEXT NOT NULL,
  agent TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  parent_run_id TEXT,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_secrets (
  provider TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  default_model TEXT,
  status TEXT NOT NULL,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS market_cases (
  case_time INTEGER NOT NULL,
  direction TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (case_time, direction)
);
`;

export class LonoraStore {
  constructor(private readonly db: DatabaseSync) {
    this.db.exec(SCHEMA);
  }

  static open(path: string): LonoraStore {
    return new LonoraStore(new DatabaseSync(path));
  }

  close(): void {
    this.db.close();
  }

  getOwner(): OwnerRecord | null {
    const row = this.db.prepare("SELECT * FROM owner LIMIT 1").get() as
      | {
          id: string;
          label: string;
          language: string;
          telegram_chat_id: string | null;
          source: OwnerRecord["source"];
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      label: row.label,
      language: row.language === "ar" ? "ar" : "en",
      telegramChatId: row.telegram_chat_id,
      source: row.source,
    };
  }

  /**
   * Replace the automatic local placeholder when a migration names the real owner.
   * A different owner that already has recommendations or memories is refused.
   */
  adoptOwner(owner: OwnerRecord): OwnerRecord {
    const existing = this.getOwner();
    if (!existing || existing.id === owner.id) {
      return this.insertOwner(owner);
    }
    const placeholder =
      existing.id === "owner" &&
      existing.source === "local-gateway" &&
      this.listRecommendations().length === 0 &&
      this.memoryCount() === 0;
    if (!placeholder) {
      throw new Error("Lonora already has an owner. A second account cannot be created.");
    }
    this.db.exec("SAVEPOINT lonora_adopt_owner");
    try {
      this.db.prepare("DELETE FROM owner WHERE id = ?").run(existing.id);
      const saved = this.insertOwner(owner);
      this.db.exec("RELEASE lonora_adopt_owner");
      return saved;
    } catch (error) {
      this.db.exec("ROLLBACK TO lonora_adopt_owner");
      this.db.exec("RELEASE lonora_adopt_owner");
      throw error;
    }
  }

  transaction<T>(run: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = run();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  memoryCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM memories").get() as {
      count: number;
    };
    return Number(row.count);
  }

  insertOwner(owner: OwnerRecord): OwnerRecord {
    const existing = this.getOwner();
    if (existing && existing.id !== owner.id) {
      throw new Error("Lonora already has an owner. A second account cannot be created.");
    }
    this.db
      .prepare(
        `INSERT INTO owner (id, label, language, telegram_chat_id, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label,
           language = excluded.language,
           telegram_chat_id = excluded.telegram_chat_id,
           source = excluded.source`,
      )
      .run(owner.id, owner.label, owner.language, owner.telegramChatId, owner.source);
    return this.getOwner()!;
  }

  ensureLocalOwner(): OwnerRecord {
    return (
      this.getOwner() ??
      this.insertOwner({
        id: "owner",
        label: "Owner",
        language: "en",
        telegramChatId: null,
        source: "local-gateway",
      })
    );
  }

  setLanguage(language: OwnerLanguage): void {
    const owner = this.ensureLocalOwner();
    this.insertOwner({ ...owner, language });
  }

  saveRecommendation(plan: RecommendationPlan): void {
    this.db
      .prepare(
        `INSERT INTO recommendations (id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(plan.id, JSON.stringify(plan), Date.now());
  }

  listRecommendations(): RecommendationPlan[] {
    const rows = this.db
      .prepare("SELECT payload FROM recommendations ORDER BY updated_at DESC")
      .all() as {
      payload: string;
    }[];
    return rows.map((row) => JSON.parse(row.payload) as RecommendationPlan);
  }

  addMemory(input: { kind: MemoryKind; content: string; symbol?: string }): MemoryRow {
    const row: MemoryRow = {
      id: randomUUID(),
      kind: input.kind,
      content: input.content,
      symbol: input.symbol ?? null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        "INSERT INTO memories (id, kind, content, symbol, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.kind, row.content, row.symbol, row.createdAt);
    return row;
  }

  /** One live block per kind and symbol. A null content removes the previous block. */
  replaceMemory(kind: MemoryKind, symbol: string, content: string | null): MemoryRow | null {
    this.db.exec("SAVEPOINT lonora_replace_memory");
    try {
      this.db.prepare("DELETE FROM memories WHERE kind = ? AND symbol = ?").run(kind, symbol);
      if (!content) {
        this.db.exec("RELEASE lonora_replace_memory");
        return null;
      }
      const row = this.addMemory({ kind, content, symbol });
      this.db.exec("RELEASE lonora_replace_memory");
      return row;
    } catch (error) {
      this.db.exec("ROLLBACK TO lonora_replace_memory");
      this.db.exec("RELEASE lonora_replace_memory");
      throw error;
    }
  }

  insertCases(cases: HistoricalCase[]): number {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO market_cases (case_time, direction, payload) VALUES (?, ?, ?)`,
    );
    this.db.exec("BEGIN");
    try {
      let added = 0;
      for (const item of cases) {
        const result = insert.run(item.caseTime, item.direction, JSON.stringify(item));
        added += Number(result.changes ?? 0);
      }
      this.db.exec("COMMIT");
      return added;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  listCases(): HistoricalCase[] {
    const rows = this.db
      .prepare("SELECT payload FROM market_cases ORDER BY case_time ASC")
      .all() as { payload: string }[];
    return rows.map((row) => JSON.parse(row.payload) as HistoricalCase);
  }

  listRecentMemory(kind: MemoryKind, limit = 3): MemoryRow[] {
    const rows = this.db
      .prepare("SELECT * FROM memories WHERE kind = ? ORDER BY created_at DESC LIMIT ?")
      .all(kind, limit) as {
      id: string;
      kind: MemoryKind;
      content: string;
      symbol: string | null;
      created_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      symbol: row.symbol,
      createdAt: row.created_at,
    }));
  }

  searchMemory(query: string, kind?: MemoryKind): MemoryRow[] {
    const needle = `%${query.toLowerCase()}%`;
    const rows = (
      kind
        ? this.db
            .prepare(
              "SELECT * FROM memories WHERE kind = ? AND lower(content) LIKE ? ORDER BY created_at DESC LIMIT 20",
            )
            .all(kind, needle)
        : this.db
            .prepare(
              "SELECT * FROM memories WHERE lower(content) LIKE ? ORDER BY created_at DESC LIMIT 20",
            )
            .all(needle)
    ) as {
      id: string;
      kind: MemoryKind;
      content: string;
      symbol: string | null;
      created_at: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      content: row.content,
      symbol: row.symbol,
      createdAt: row.created_at,
    }));
  }

  saveResponsibility(row: ResponsibilityRow): void {
    this.db
      .prepare(
        `INSERT INTO responsibilities
          (id, title, instruction, status, last_check_at, next_check_at, last_event)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          instruction = excluded.instruction,
          status = excluded.status,
          last_check_at = excluded.last_check_at,
          next_check_at = excluded.next_check_at,
          last_event = excluded.last_event`,
      )
      .run(
        row.id,
        row.title,
        row.instruction,
        row.status,
        row.lastCheckAt,
        row.nextCheckAt,
        row.lastEvent,
      );
  }

  listResponsibilities(): ResponsibilityRow[] {
    const rows = this.db.prepare("SELECT * FROM responsibilities").all() as {
      id: string;
      title: string;
      instruction: string;
      status: ResponsibilityRow["status"];
      last_check_at: number | null;
      next_check_at: number | null;
      last_event: string | null;
    }[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      instruction: row.instruction,
      status: row.status,
      lastCheckAt: row.last_check_at,
      nextCheckAt: row.next_check_at,
      lastEvent: row.last_event,
    }));
  }

  getNotice(key: string): NoticeRow | null {
    const row = this.db.prepare("SELECT * FROM notices WHERE key = ?").get(key) as
      | {
          key: string;
          status: NoticeRow["status"];
          attempts: number;
          last_attempt_at: number | null;
          cooldown_until: number;
          payload: string;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      key: row.key,
      status: row.status,
      attempts: row.attempts,
      lastAttemptAt: row.last_attempt_at,
      cooldownUntil: row.cooldown_until,
      payload: row.payload,
    };
  }

  saveNotice(row: NoticeRow): void {
    this.db
      .prepare(
        `INSERT INTO notices (key, status, attempts, last_attempt_at, cooldown_until, payload)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
          status = excluded.status,
          attempts = excluded.attempts,
          last_attempt_at = excluded.last_attempt_at,
          cooldown_until = excluded.cooldown_until,
          payload = excluded.payload`,
      )
      .run(row.key, row.status, row.attempts, row.lastAttemptAt, row.cooldownUntil, row.payload);
  }

  saveObservation(payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO observations (id, payload, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(payload), Date.now());
  }

  getObservation<T>(): T | null {
    const row = this.db.prepare("SELECT payload FROM observations WHERE id = 1").get() as
      | { payload: string }
      | undefined;
    return row ? (JSON.parse(row.payload) as T) : null;
  }

  addUsage(event: UsageEvent): void {
    this.db
      .prepare(
        `INSERT INTO usage_events
          (id, at, provider, model, feature, agent, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.at,
        event.provider,
        event.model,
        event.feature,
        event.agent,
        event.inputTokens,
        event.outputTokens,
      );
  }

  listUsage(): UsageEvent[] {
    const rows = this.db.prepare("SELECT * FROM usage_events").all() as {
      id: string;
      at: number;
      provider: string;
      model: string;
      feature: UsageFeature;
      agent: string;
      input_tokens: number;
      output_tokens: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      provider: row.provider,
      model: row.model,
      feature: row.feature,
      agent: row.agent,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      estimated: true,
    }));
  }

  recordAgentRun(input: {
    agent: string;
    parentRunId?: string;
    status: "ok" | "failed" | "timeout";
    summary: string;
    inputTokens?: number;
    outputTokens?: number;
  }): string {
    const id = randomUUID();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO agent_runs
          (id, agent, parent_run_id, status, summary, started_at, finished_at, input_tokens, output_tokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.agent,
        input.parentRunId ?? null,
        input.status,
        input.summary,
        now,
        now,
        input.inputTokens ?? 0,
        input.outputTokens ?? 0,
      );
    return id;
  }

  countAgentRunsSince(since: number): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM agent_runs WHERE started_at >= ?")
      .get(since) as { count: number };
    return Number(row.count);
  }

  listAgentRuns(): {
    id: string;
    agent: string;
    status: string;
    summary: string;
    startedAt: number;
    inputTokens: number;
    outputTokens: number;
  }[] {
    const rows = this.db
      .prepare("SELECT * FROM agent_runs ORDER BY started_at DESC, rowid DESC LIMIT 50")
      .all() as {
      id: string;
      agent: string;
      status: string;
      summary: string;
      started_at: number;
      input_tokens: number;
      output_tokens: number;
    }[];
    return rows.map((row) => ({
      id: row.id,
      agent: row.agent,
      status: row.status,
      summary: row.summary,
      startedAt: row.started_at,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
    }));
  }

  saveProviderSecret(input: {
    provider: string;
    apiKey: string;
    defaultModel: string | null;
    status: "connected" | "not_connected" | "invalid";
    lastError: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO provider_secrets (provider, api_key, default_model, status, last_error, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET
          api_key = excluded.api_key,
          default_model = excluded.default_model,
          status = excluded.status,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.provider,
        input.apiKey,
        input.defaultModel,
        input.status,
        input.lastError,
        Date.now(),
      );
  }

  /** Public status never includes the stored key. */
  listProviderStatus(): {
    provider: string;
    connected: boolean;
    defaultModel: string | null;
    status: string;
    lastError: string | null;
  }[] {
    const rows = this.db
      .prepare("SELECT provider, default_model, status, last_error FROM provider_secrets")
      .all() as {
      provider: string;
      default_model: string | null;
      status: string;
      last_error: string | null;
    }[];
    return rows.map((row) => ({
      provider: row.provider,
      connected: row.status === "connected",
      defaultModel: row.default_model,
      status: row.status,
      lastError: row.last_error,
    }));
  }
}
