/**
 * Tool risk classes are enforced here, not only described to the model.
 * Scheduled work, the market watcher, and sub-agents cannot place trades.
 */

export type PermissionClass =
  | "READ"
  | "INTERNAL_WRITE"
  | "NOTIFY"
  | "EXTERNAL_WRITE"
  | "TRADE_EXECUTION";

export type CallerKind = "owner" | "chat" | "monitor" | "schedule" | "subagent" | "model";

export class PermissionDenied extends Error {
  readonly code = "PERMISSION_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "PermissionDenied";
  }
}

const AUTONOMOUS = new Set<CallerKind>(["monitor", "schedule", "subagent", "model"]);

export function assertPermission(input: {
  permission: PermissionClass;
  caller: CallerKind;
  ownerConfirmed?: boolean;
}): void {
  if (input.permission === "TRADE_EXECUTION") {
    if (input.caller !== "owner" || input.ownerConfirmed !== true) {
      throw new PermissionDenied(
        "Trade execution requires an explicit owner confirmation. Autonomous callers cannot place trades.",
      );
    }
  }
  if (input.permission === "EXTERNAL_WRITE" && AUTONOMOUS.has(input.caller)) {
    throw new PermissionDenied("External writes require the owner. This caller is autonomous.");
  }
  if (input.permission === "NOTIFY" && input.caller === "model" && input.ownerConfirmed !== true) {
    throw new PermissionDenied("Model-originated notifications require owner confirmation.");
  }
}

export function authorizeTrade(input: {
  caller: CallerKind;
  ownerConfirmed?: boolean;
}): { ok: true } | { ok: false; code: "autonomous_trade_blocked" | "owner_confirmation_required" } {
  try {
    assertPermission({
      permission: "TRADE_EXECUTION",
      caller: input.caller,
      ownerConfirmed: input.ownerConfirmed,
    });
    return { ok: true };
  } catch {
    return {
      ok: false,
      code: input.caller === "owner" ? "owner_confirmation_required" : "autonomous_trade_blocked",
    };
  }
}

export const CODING_TOOL_NAMES = [
  "exec",
  "process",
  "code_execution",
  "read",
  "write",
  "edit",
  "apply_patch",
  "ls",
  "terminal",
  "browser",
  "screen",
  "canvas",
  "gateway",
  "plugins",
  "github_publish",
  "github_identity_status",
  "nodes",
  "sessions_spawn",
] as const;

export function isCodingTool(name: string): boolean {
  return (CODING_TOOL_NAMES as readonly string[]).includes(name);
}

export function blockReasonForTool(input: {
  toolName: string;
  sessionKey?: string;
  jobId?: string;
  /** Ignored. Model parameters are not owner authority. */
  ownerConfirmed?: boolean;
}): string | null {
  if (isCodingTool(input.toolName)) {
    return "Lonora does not expose coding, shell, or filesystem tools.";
  }
  if (input.toolName === "lonora_execute_trade") {
    return "Trade execution is owner-confirmed only. Model tools, monitoring, schedules, and sub-agents cannot place trades.";
  }
  if (input.toolName === "lonora_notify") {
    return "Notifications are recorded by the market monitor. A model call cannot confirm them.";
  }
  return null;
}
