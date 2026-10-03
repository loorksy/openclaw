import { mkdirSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { Candle } from "./src/domain/candles.js";
import type { SpecialistId } from "./src/domain/agents.js";
import { LONORA_SYSTEM_CONTEXT, LONORA_TOOL_ALLOW, lonoraToolDecision } from "./src/policy.js";
import { LonoraService } from "./src/service.js";
import { LonoraStore, type MemoryKind } from "./src/store.js";

const Text = Type.String();

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    details: value,
  };
}

export default definePluginEntry({
  id: "lonora",
  name: "Lonora",
  description: "Private gold-market intelligence for a single owner.",
  configSchema: {
    parse(value: unknown) {
      const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
        const dailyBudgetUsd =
          typeof record.dailyBudgetUsd === "number" && record.dailyBudgetUsd >= 0
            ? record.dailyBudgetUsd
            : null;
        return {
        monitorIntervalMs:
          typeof record.monitorIntervalMs === "number" && record.monitorIntervalMs >= 15_000
            ? record.monitorIntervalMs
            : 60_000,
        dailyBudgetUsd,
      };
    },
  },
  register(api: OpenClawPluginApi) {
    let service: LonoraService | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    const config = (
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as { monitorIntervalMs?: number; dailyBudgetUsd?: number | null })
        : {}
    );
    const intervalMs =
      typeof config.monitorIntervalMs === "number" && config.monitorIntervalMs >= 15_000
        ? config.monitorIntervalMs
        : 60_000;

    const requireService = () => {
      if (!service) {
        throw new Error("Lonora is still starting.");
      }
      return service;
    };

    api.registerService({
      id: "lonora-runtime",
      start(ctx) {
        const directory = path.join(ctx.stateDir, "lonora");
        mkdirSync(directory, { recursive: true });
        service = new LonoraService(LonoraStore.open(path.join(directory, "lonora.sqlite")));
        service.dailyBudgetUsd =
          typeof config.dailyBudgetUsd === "number" ? config.dailyBudgetUsd : null;
        service.ownerStatus();
        const tick = () => {
          void service?.monitorOnce();
        };
        tick();
        timer = setInterval(tick, intervalMs);
        timer.unref?.();
      },
      stop() {
        if (timer) {
          clearInterval(timer);
          timer = undefined;
        }
        service?.store.close();
        service = null;
      },
    });

    api.on("before_tool_call", (event, ctx) => {
      const params = event.params as { ownerConfirmed?: boolean } | undefined;
      const context = ctx as { sessionKey?: string; jobId?: string };
      return lonoraToolDecision({
        toolName: event.toolName,
        sessionKey: context.sessionKey,
        jobId: context.jobId,
        ownerConfirmed: params?.ownerConfirmed === true,
      });
    });

    api.on("before_prompt_build", () => ({
      prependSystemContext: LONORA_SYSTEM_CONTEXT,
      toolsAllow: [...LONORA_TOOL_ALLOW],
    }));

    api.on("llm_output", (event, ctx) => {
      if (!service) {
        return;
      }
      const usage = (event as { usage?: { input?: number; output?: number } }).usage;
      const context = ctx as { provider?: string; model?: string; sessionKey?: string; jobId?: string };
      if (!usage) {
        return;
      }
      service.recordModelUsage({
        provider: context.provider ?? "unknown",
        model: context.model ?? "unknown",
        inputTokens: usage.input ?? 0,
        outputTokens: usage.output ?? 0,
        sessionKey: context.sessionKey,
        jobId: context.jobId,
        agent: "lonora",
      });
    });

    const tool = (
      name: string,
      description: string,
      parameters: ReturnType<typeof Type.Object>,
      run: (params: Record<string, unknown>) => unknown,
    ) => {
      api.registerTool({
        name,
        description,
        parameters,
        async execute(_id, params) {
          try {
            return textResult(await run(params as Record<string, unknown>));
          } catch (error) {
            const message = error instanceof Error ? error.message : "Lonora tool failed.";
            return textResult({ ok: false, error: message });
          }
        },
      });
    };

    tool(
      "lonora_market_snapshot",
      "Read the current XAUUSD session, open or closed state, and active recommendations.",
      Type.Object({}),
      () => requireService().marketSnapshot(),
    );
    tool(
      "lonora_candles",
      "Report whether supplied candles are usable. Closed markets do not invent bars.",
      Type.Object({ count: Type.Optional(Type.Number()) }),
      () => requireService().readCandles(),
    );
    tool(
      "lonora_analyze_structure",
      "Run the structure analyst on closed XAUUSD candles.",
      Type.Object({ candles: Type.Array(Type.Unknown()) }),
      (params) =>
        requireService().delegate({
          agent: "structure-analyst",
          candles: params.candles as Candle[],
        }),
    );
    tool(
      "lonora_analyze_liquidity",
      "Run the liquidity analyst on closed XAUUSD candles.",
      Type.Object({ candles: Type.Array(Type.Unknown()) }),
      (params) =>
        requireService().delegate({
          agent: "liquidity-analyst",
          candles: params.candles as Candle[],
        }),
    );
    tool(
      "lonora_analyze_supply_demand",
      "Run the supply and demand analyst on closed XAUUSD candles.",
      Type.Object({ candles: Type.Array(Type.Unknown()) }),
      (params) =>
        requireService().delegate({
          agent: "supply-demand-analyst",
          candles: params.candles as Candle[],
        }),
    );
    tool(
      "lonora_calendar",
      "Read the gold session clock.",
      Type.Object({}),
      () => requireService().marketSnapshot().clock,
    );
    tool(
      "lonora_recommendations",
      "List or grade XAUUSD recommendations. Grading uses closed candles only.",
      Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("grade")]),
        candles: Type.Optional(Type.Array(Type.Unknown())),
      }),
      (params) => {
        const current = requireService();
        if (params.action === "grade") {
          return current.gradeRecommendations(
            (params.candles as Candle[] | undefined) ?? [],
          );
        }
        return current.store.listRecommendations();
      },
    );
    tool(
      "lonora_memory",
      "Read or write Lonora memory. Kinds stay separate: preference, lesson, research, recommendation, market_observation.",
      Type.Object({
        action: Type.Union([Type.Literal("read"), Type.Literal("write")]),
        kind: Type.Optional(Text),
        content: Type.Optional(Text),
        query: Type.Optional(Text),
      }),
      (params) => {
        const current = requireService();
        if (params.action === "write") {
          return current.remember(
            (params.kind as MemoryKind | undefined) ?? "lesson",
            String(params.content ?? ""),
          );
        }
        return current.recall(String(params.query ?? ""), params.kind as MemoryKind | undefined);
      },
    );
    tool(
      "lonora_responsibility",
      "Create, pause, resume, or cancel a persistent responsibility.",
      Type.Object({
        action: Type.Union([
          Type.Literal("list"),
          Type.Literal("create"),
          Type.Literal("pause"),
          Type.Literal("resume"),
          Type.Literal("cancel"),
        ]),
        id: Type.Optional(Text),
        title: Type.Optional(Text),
        instruction: Type.Optional(Text),
      }),
      (params) => {
        const current = requireService();
        if (params.action === "list") {
          return current.store.listResponsibilities();
        }
        if (params.action === "create") {
          return current.upsertResponsibility({
            title: String(params.title ?? "Responsibility"),
            instruction: String(params.instruction ?? ""),
          });
        }
        const status =
          params.action === "pause" ? "paused" : params.action === "resume" ? "running" : "cancelled";
        return current.setResponsibilityStatus(String(params.id), status);
      },
    );
    tool(
      "lonora_delegate",
      "Delegate one specialist. Depth and child limits are enforced.",
      Type.Object({
        agent: Text,
        candles: Type.Optional(Type.Array(Type.Unknown())),
        note: Type.Optional(Text),
        depth: Type.Optional(Type.Number()),
      }),
      (params) =>
        requireService().delegate({
          agent: String(params.agent) as SpecialistId,
          candles: params.candles as Candle[] | undefined,
          note: params.note as string | undefined,
          depth: params.depth as number | undefined,
        }),
    );
    tool(
      "lonora_notify",
      "Record an owner notification intent. Delivery stays deduped.",
      Type.Object({ key: Text, message: Text }),
      (params) => {
        const current = requireService();
        current.store.saveNotice({
          key: String(params.key),
          status: "pending",
          attempts: 1,
          lastAttemptAt: Date.now(),
          cooldownUntil: Date.now(),
          payload: String(params.message),
        });
        return { ok: true, status: "pending" };
      },
    );
    tool(
      "lonora_execute_trade",
      "Owner-confirmed trade boundary. Autonomous calls are refused and no broker is contacted.",
      Type.Object({ ownerConfirmed: Type.Optional(Type.Boolean()) }),
      () => requireService().confirmTrade({ caller: "model", ownerConfirmed: true }),
    );

    const handle =
      (run: (params: unknown) => unknown) =>
      async ({ params, respond }: GatewayRequestHandlerOptions) => {
        try {
          respond(true, await run(params));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Lonora request failed.";
          respond(false, { error: message }, errorShape(ErrorCodes.UNAVAILABLE, message));
        }
      };

    api.registerGatewayMethod("lonora.owner.status", handle(() => requireService().ownerStatus()), {
      scope: "operator.read",
    });
    api.registerGatewayMethod(
      "lonora.market.snapshot",
      handle(() => requireService().marketSnapshot()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.recommendations.list",
      handle(() => requireService().store.listRecommendations()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.tasks.list",
      handle(() => requireService().store.listResponsibilities()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod("lonora.agents.list", handle(() => requireService().agentsView()), {
      scope: "operator.read",
    });
    api.registerGatewayMethod("lonora.usage.summary", handle(() => requireService().usageSummary()), {
      scope: "operator.read",
    });
    api.registerGatewayMethod(
      "lonora.providers.status",
      handle(() => requireService().providerSettings()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.owner.bindTelegram",
      handle((params) => {
        const chatId = (params as { chatId?: unknown } | undefined)?.chatId;
        if (typeof chatId !== "string" || !chatId.trim()) {
          throw new Error("chatId is required.");
        }
        return requireService().bindTelegram(chatId.trim());
      }),
      { scope: "operator.write" },
    );
  },
});
