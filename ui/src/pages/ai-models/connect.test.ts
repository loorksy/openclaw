// @vitest-environment node
import { describe, expect, it } from "vitest";
import { connectLonoraModel, type LonoraConnectClient } from "./connect.ts";

function client(handlers: Record<string, (params: Record<string, unknown>) => unknown>): {
  client: LonoraConnectClient;
  calls: { method: string; params: Record<string, unknown> }[];
} {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      async request(method, params) {
        calls.push({ method, params });
        const handler = handlers[method];
        if (!handler) {
          throw new Error(`unexpected ${method}`);
        }
        return await handler(params);
      },
    },
  };
}

describe("connectLonoraModel", () => {
  it("does not save a rejected key into the runtime", async () => {
    const secret = "sk-rejected-secret";
    const harness = client({
      "lonora.providers.connect": () => ({
        connected: false,
        error: `rejected ${secret}`,
      }),
    });
    const result = await connectLonoraModel(harness.client, {
      provider: "openai",
      apiKey: secret,
      agentId: "main",
    });
    expect(harness.calls.map((call) => call.method)).toEqual(["lonora.providers.connect"]);
    expect(result.savedToRuntime).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.error).toContain("[redacted]");
  });

  it("saves an accepted key through the runtime credential writer", async () => {
    const secret = "sk-accepted-secret";
    const harness = client({
      "lonora.providers.connect": () => ({
        connected: true,
        defaultModel: "gpt-test",
      }),
      "models.authSetApiKey": (params) => {
        expect(params.apiKey).toBe(secret);
        return { profileId: "openai:manual" };
      },
    });
    const result = await connectLonoraModel(harness.client, {
      provider: "openai",
      apiKey: secret,
      agentId: "main",
    });
    expect(harness.calls.map((call) => call.method)).toEqual([
      "lonora.providers.connect",
      "models.authSetApiKey",
    ]);
    expect(result).toMatchObject({
      connected: true,
      savedToRuntime: true,
      defaultModel: "gpt-test",
      error: null,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("reports a runtime save failure without returning the key", async () => {
    const secret = "sk-runtime-secret";
    const harness = client({
      "lonora.providers.connect": () => ({ connected: true, defaultModel: "claude-test" }),
      "models.authSetApiKey": () => {
        throw new Error(`save failed for ${secret}`);
      },
    });
    const result = await connectLonoraModel(harness.client, {
      provider: "anthropic",
      apiKey: secret,
      agentId: "main",
    });
    expect(result.connected).toBe(true);
    expect(result.savedToRuntime).toBe(false);
    expect(result.error).toBe("save failed for [redacted]");
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
