import type { ApplicationContext } from "../../app/context.ts";
import { isGatewayMethodAdvertised } from "../../lib/gateway-methods.ts";

export function lonoraRequestTarget(
  context: ApplicationContext | undefined,
  method: string,
):
  | { ok: true; client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]> }
  | { ok: false; reason: "disconnected" | "unavailable" } {
  const gateway = context?.gateway;
  const client = gateway?.snapshot.client;
  if (!client || gateway.snapshot.phase !== "connected") {
    return { ok: false, reason: "disconnected" };
  }
  if (isGatewayMethodAdvertised(gateway.snapshot, method) === false) {
    return { ok: false, reason: "unavailable" };
  }
  return { ok: true, client };
}
