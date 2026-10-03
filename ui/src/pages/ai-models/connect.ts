export type LonoraConnectClient = {
  request<T>(method: string, params: Record<string, unknown>): Promise<T>;
};

export type LonoraConnectResult = {
  connected: boolean;
  savedToRuntime: boolean;
  defaultModel: string | null;
  error: string | null;
  warning: string | null;
};

type ProbeResult = {
  connected?: boolean;
  defaultModel?: string | null;
  error?: string | null;
};

type RuntimeSaveResult = {
  warning?: string;
};

function redact(message: string, secret: string): string {
  const trimmed = secret.trim();
  return trimmed ? message.split(trimmed).join("[redacted]") : message;
}

/**
 * Probe the provider, then save an accepted key through the runtime credential
 * writer. The returned object never includes the key.
 */
export async function connectLonoraModel(
  client: LonoraConnectClient,
  input: { provider: string; apiKey: string; agentId: string },
): Promise<LonoraConnectResult> {
  const probe = await client.request<ProbeResult>("lonora.providers.connect", {
    provider: input.provider,
    apiKey: input.apiKey,
  });
  if (!probe.connected) {
    return {
      connected: false,
      savedToRuntime: false,
      defaultModel: probe.defaultModel ?? null,
      error: redact(probe.error ?? "The provider rejected the key.", input.apiKey),
      warning: null,
    };
  }
  try {
    const saved = await client.request<RuntimeSaveResult>("models.authSetApiKey", {
      provider: input.provider,
      apiKey: input.apiKey,
      agentId: input.agentId,
    });
    return {
      connected: true,
      savedToRuntime: true,
      defaultModel: probe.defaultModel ?? null,
      error: null,
      warning: saved.warning ? redact(saved.warning, input.apiKey) : null,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Lonora could not save the key for chat.";
    return {
      connected: true,
      savedToRuntime: false,
      defaultModel: probe.defaultModel ?? null,
      error: redact(message, input.apiKey),
      warning: null,
    };
  }
}
