export const LONORA_PROVIDERS = ["anthropic", "openai", "zai", "openrouter"] as const;
export type LonoraProviderId = (typeof LONORA_PROVIDERS)[number];

export function isLonoraProvider(id: string): id is LonoraProviderId {
  return (LONORA_PROVIDERS as readonly string[]).includes(id.toLowerCase());
}

export interface ProviderProbe {
  provider: LonoraProviderId;
  connected: boolean;
  defaultModel: string | null;
  models: string[];
  error: string | null;
}

const ENDPOINTS: Record<LonoraProviderId, { url: string; headers: (key: string) => Record<string, string> }> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/models",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    }),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  zai: {
    url: "https://api.z.ai/api/paas/v4/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/models",
    headers: (key) => ({ authorization: `Bearer ${key}` }),
  },
};

export function publicProviderView(probe: ProviderProbe): Omit<ProviderProbe, "models"> & { models: string[] } {
  return {
    provider: probe.provider,
    connected: probe.connected,
    defaultModel: probe.defaultModel,
    models: probe.models,
    error: probe.error,
  };
}

export async function probeProvider(input: {
  provider: LonoraProviderId;
  apiKey: string;
  fetchImpl?: typeof fetch;
}): Promise<ProviderProbe> {
  if (!input.apiKey.trim()) {
    return {
      provider: input.provider,
      connected: false,
      defaultModel: null,
      models: [],
      error: "Missing API key.",
    };
  }
  const endpoint = ENDPOINTS[input.provider];
  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(endpoint.url, { headers: endpoint.headers(input.apiKey) });
    const body = await response.text();
    if (!response.ok) {
      return {
        provider: input.provider,
        connected: false,
        defaultModel: null,
        models: [],
        error: safeProviderError(response.status, body, input.apiKey),
      };
    }
    const models = readModelIds(body).slice(0, 12);
    return {
      provider: input.provider,
      connected: true,
      defaultModel: models[0] ?? null,
      models,
      error: null,
    };
  } catch (error) {
    return {
      provider: input.provider,
      connected: false,
      defaultModel: null,
      models: [],
      error: error instanceof Error ? "Provider request failed." : "Provider request failed.",
    };
  }
}

function readModelIds(body: string): string[] {
  try {
    const parsed = JSON.parse(body) as { data?: { id?: string }[] };
    return (parsed.data ?? []).flatMap((row) => (row.id ? [row.id] : []));
  } catch {
    return [];
  }
}

function safeProviderError(status: number, body: string, apiKey: string): string {
  const redacted = apiKey ? body.replaceAll(apiKey, "[redacted]") : body;
  const compact = redacted.replace(/\s+/g, " ").slice(0, 180);
  if (status === 401 || status === 403) {
    return "The API key was rejected.";
  }
  return `Provider returned ${status}. ${compact}`.trim();
}
