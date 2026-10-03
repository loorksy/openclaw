import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  type GatewayRequestHandlerOptions,
} from "openclaw/plugin-sdk/gateway-runtime";
import { definePluginEntry, type OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import type { SpecialistId } from "./src/domain/agents.js";
import type { Candle } from "./src/domain/candles.js";
import { copy } from "./src/domain/copy.js";
import { cronForResponsibility } from "./src/domain/responsibilities.js";
import { usageIdentity } from "./src/domain/usage.js";
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
    const config =
      api.pluginConfig && typeof api.pluginConfig === "object"
        ? (api.pluginConfig as { monitorIntervalMs?: number; dailyBudgetUsd?: number | null })
        : {};
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
        service.setNoticeDelivery(async ({ chatId, text, key }) => {
          const result = await api.runtime.gateway.request<{ ok?: boolean }>("tools.invoke", {
            name: "message",
            args: {
              action: "send",
              channel: "telegram",
              target: chatId,
              message: text,
            },
            idempotencyKey: `lonora-${key}`,
          });
          return result?.ok === true;
        });
        const tick = () => {
          const current = service;
          if (!current) {
            return;
          }
          void current.startMonitor().catch((error: unknown) => {
            current.recordMonitorFailure(error);
          });
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
        const current = service;
        service = null;
        if (!current) {
          return;
        }
        void current.monitorSettled.finally(() => {
          current.store.close();
        });
      },
    });

    api.on("before_tool_call", (event, ctx) => {
      const context = ctx as { sessionKey?: string; jobId?: string };
      return lonoraToolDecision({
        toolName: event.toolName,
        sessionKey: context.sessionKey,
        jobId: context.jobId,
      });
    });

    api.on("before_prompt_build", () => ({
      prependSystemContext: service
        ? `${LONORA_SYSTEM_CONTEXT}\n${service.ownerBrief()}`
        : LONORA_SYSTEM_CONTEXT,
      toolsAllow: [...LONORA_TOOL_ALLOW],
    }));

    api.on("agent_end", (event) => {
      if (!service) {
        return;
      }
      const messages = (event as { messages?: unknown }).messages;
      service.noteConversation(Array.isArray(messages) ? messages : []);
    });

    api.on("llm_output", (event, ctx) => {
      if (!service) {
        return;
      }
      const output = event as {
        provider?: string;
        model?: string;
        usage?: { input?: number; output?: number };
      };
      const context = ctx as {
        modelProviderId?: string;
        modelId?: string;
        sessionKey?: string;
        jobId?: string;
        agentId?: string;
      };
      if (!output.usage) {
        return;
      }
      const identity = usageIdentity({
        provider: output.provider,
        model: output.model,
        modelProviderId: context.modelProviderId,
        modelId: context.modelId,
      });
      service.recordModelUsage({
        provider: identity.provider,
        model: identity.model,
        inputTokens: output.usage.input ?? 0,
        outputTokens: output.usage.output ?? 0,
        sessionKey: context.sessionKey,
        jobId: context.jobId,
        agent: context.agentId ?? "lonora",
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
      "Read closed XAUUSD candles from the market feed. Missing credentials stay unavailable.",
      Type.Object({ count: Type.Optional(Type.Number()) }),
      (params) =>
        requireService().readCandles(typeof params.count === "number" ? params.count : undefined),
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
      "Read gold-relevant economic events. A failed feed stays unknown and does not invent a quiet week.",
      Type.Object({}),
      () => requireService().readCalendar(),
    );
    tool(
      "lonora_headlines",
      "Read gold headlines. A failed or unconfigured feed stays unknown and does not invent a quiet tape.",
      Type.Object({}),
      () => requireService().readHeadlines(),
    );
    tool(
      "lonora_recommendations",
      "List, grade, or prepare an XAUUSD recommendation from closed candles. Preparing a plan does not place an order.",
      Type.Object({
        action: Type.Union([Type.Literal("list"), Type.Literal("grade"), Type.Literal("prepare")]),
      }),
      async (params) => {
        const current = requireService();
        if (params.action === "grade") {
          return current.gradeLiveRecommendations();
        }
        if (params.action === "prepare") {
          return current.prepareRecommendation();
        }
        return current.listRecommendations();
      },
    );
    tool(
      "lonora_memory",
      "Read or write Lonora memory. Kinds stay separate: preference, lesson, research, scenario, recommendation, market_observation.",
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
        const query = String(params.query ?? "");
        return {
          brief: current.ownerBrief(),
          rows: current.recall(query, params.kind as MemoryKind | undefined),
        };
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
      async (params) => {
        const current = requireService();
        if (params.action === "list") {
          return current.store.listResponsibilities();
        }
        if (params.action === "create") {
          const instruction = String(params.instruction ?? "");
          const title = String(params.title ?? "Responsibility");
          const cron = cronForResponsibility(instruction);
          if (!cron) {
            return current.upsertResponsibility({ title, instruction });
          }
          const language = current.ownerStatus().language;
          let scheduled = false;
          try {
            const job = await api.session.workflow.scheduleSessionTurn({
              sessionKey: "agent:main:main",
              message: instruction,
              cron: cron.expr,
              tz: cron.tz,
              deleteAfterRun: false,
              name: `lonora-${randomUUID().slice(0, 8)}`,
              tag: "lonora",
              deliveryMode: "announce",
            });
            scheduled = job != null;
          } catch {
            scheduled = false;
          }
          return current.upsertResponsibility({
            title,
            instruction,
            status: scheduled ? "scheduled" : "running",
            lastEvent: scheduled
              ? `${copy(language, "tasks.scheduled")} ${cron.expr} ${cron.tz}.`
              : copy(language, "tasks.scheduleRejected"),
          });
        }
        const status =
          params.action === "pause"
            ? "paused"
            : params.action === "resume"
              ? "running"
              : "cancelled";
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
      }),
      async (params) => {
        const current = requireService();
        const agent = String(params.agent) as SpecialistId;
        if (agent === "macro-news-analyst") {
          const [calendar, headlines] = await Promise.all([
            current.readCalendar(),
            current.readHeadlines(),
          ]);
          return current.delegate({
            agent,
            events: calendar.events,
            calendarKnown: calendar.ok,
            headlines: headlines.headlines,
            headlinesKnown: headlines.ok,
          });
        }
        if (agent === "research-agent") {
          return current.compareSimilarHistory({ enforceDelegation: true });
        }
        if (agent === "multi-timeframe-analyst") {
          return current.compareTimeframes();
        }
        return current.delegate({
          agent,
          candles: params.candles as Candle[] | undefined,
          note: params.note as string | undefined,
        });
      },
    );
    tool(
      "lonora_notify",
      "Record an owner notification intent. Delivery stays deduped.",
      Type.Object({ key: Text, message: Text }),
      (params) => requireService().notifyOwner(String(params.key), String(params.message)),
    );
    tool(
      "lonora_execute_trade",
      "Owner-confirmed trade boundary. Model calls are refused and no broker is contacted.",
      Type.Object({}),
      () => requireService().confirmTrade({ caller: "model" }),
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

    api.registerGatewayMethod(
      "lonora.owner.status",
      handle(() => requireService().ownerStatus()),
      {
        scope: "operator.read",
      },
    );
    api.registerGatewayMethod(
      "lonora.market.snapshot",
      handle(() => requireService().marketSnapshot()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.candles.read",
      handle(() => requireService().readVisibleCandles()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.memory.brief",
      handle(() => ({ text: requireService().ownerBrief(), invented: false as const })),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.headlines.read",
      handle(() => requireService().readHeadlines()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.calendar.read",
      handle(() => requireService().readCalendar()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.recommendations.list",
      handle(() => requireService().listRecommendations()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.recommendations.record",
      handle(() => requireService().recommendationRecord()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.recommendations.prepare",
      handle(() => requireService().prepareRecommendation()),
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "lonora.research.similar",
      handle(() => requireService().compareSimilarHistory()),
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "lonora.tasks.list",
      handle(() => requireService().tasksView()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.tasks.setStatus",
      handle((params) => {
        const body = params as { id?: unknown; status?: unknown } | undefined;
        const status = body?.status;
        if (
          typeof body?.id !== "string" ||
          (status !== "running" && status !== "paused" && status !== "cancelled")
        ) {
          throw new Error("id and status are required.");
        }
        return requireService().setResponsibilityStatus(body.id, status);
      }),
      { scope: "operator.write" },
    );
    api.registerGatewayMethod(
      "lonora.agents.list",
      handle(() => requireService().agentsView()),
      {
        scope: "operator.read",
      },
    );
    api.registerGatewayMethod(
      "lonora.usage.summary",
      handle(() => requireService().usageSummary()),
      {
        scope: "operator.read",
      },
    );
    api.registerGatewayMethod(
      "lonora.providers.status",
      handle(() => requireService().providerSettings()),
      { scope: "operator.read" },
    );
    api.registerGatewayMethod(
      "lonora.providers.connect",
      handle(async (params) => {
        const body = params as { provider?: unknown; apiKey?: unknown } | undefined;
        if (typeof body?.provider !== "string" || typeof body.apiKey !== "string") {
          throw new Error("provider and apiKey are required.");
        }
        const result = await requireService().connectProvider({
          provider: body.provider,
          apiKey: body.apiKey,
        });
        return {
          ok: result.ok,
          provider: "provider" in result ? result.provider : body.provider,
          connected: "connected" in result ? result.connected : false,
          defaultModel: "defaultModel" in result ? result.defaultModel : null,
          models: "models" in result ? result.models : [],
          error: result.error ?? null,
        };
      }),
      { scope: "operator.write" },
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
