import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  providerResponseMaxBytes,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import {
  DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS,
  normalizeProviderConnectionConfiguration,
  type ProviderConnectionConfiguration
} from "./providerConfiguration";
import {
  createProviderSafeFetch,
  type ProviderSafeFetchOptions
} from "./providerSafeFetch";
import {
  assertProviderCredentialSource,
  resolveProviderCredentialSource,
  type ProviderCredentialSource
} from "./providerCredentialSource";

const MAX_DISCOVERY_BODY_BYTES = 2 * 1024 * 1024;
export const MAX_OPENROUTER_DISCOVERY_MODELS = 1_000;
export const MAX_OPENROUTER_DISCOVERY_ENDPOINTS = 128;
const MAX_MODEL_ID_LENGTH = 256;
const MAX_NAME_LENGTH = 256;
const MAX_METADATA_STRING_LENGTH = 96;
const MAX_MODALITIES = 16;
const MAX_SUPPORTED_PARAMETERS = 128;
const MAX_PRICING_FIELDS = 32;
const MAX_CONTEXT_LENGTH = 100_000_000;
const FORBIDDEN_METADATA_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type OpenRouterDiscoveredModel = {
  contextLength?: number;
  id: string;
  inputModalities: string[];
  name: string;
  outputModalities: string[];
  pricing: Record<string, string>;
  supportedParameters: string[];
};

export type OpenRouterDiscoveredEndpoint = {
  contextLength?: number;
  maxCompletionTokens?: number;
  maxPromptTokens?: number;
  name: string;
  providerName: string;
  quantization?: string;
  supportedParameters: string[];
  tag: string;
};

export type OpenRouterDiscoveryClient = {
  listEmbeddingModels(
    options?: { signal?: AbortSignal }
  ): Promise<OpenRouterDiscoveredModel[]>;
  listModelEndpoints(
    modelId: string,
    options?: { signal?: AbortSignal }
  ): Promise<OpenRouterDiscoveredEndpoint[]>;
  listModels(options?: { signal?: AbortSignal }): Promise<OpenRouterDiscoveredModel[]>;
  listRerankModels(
    options?: { signal?: AbortSignal }
  ): Promise<OpenRouterDiscoveredModel[]>;
};

export type OpenRouterDiscoveryErrorCode =
  | "openrouter_discovery_api_key_required"
  | "openrouter_discovery_model_id_invalid"
  | "openrouter_discovery_response_invalid";

export class OpenRouterDiscoveryError extends Error {
  readonly code: OpenRouterDiscoveryErrorCode;

  constructor(code: OpenRouterDiscoveryErrorCode) {
    super(code);
    this.code = code;
    this.name = "OpenRouterDiscoveryError";
  }
}

type DiscoveryNetworkOptions = Omit<ProviderSafeFetchOptions, "configuration">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  return text && text.length <= maxLength && !/[\u0000-\u001F\u007F]/u.test(text)
    ? text
    : null;
}

function normalizeModelId(value: unknown): string | null {
  const modelId = safeText(value, MAX_MODEL_ID_LENGTH);
  if (!modelId) {
    return null;
  }
  const segments = modelId.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) =>
      !segment ||
      segment.length > 128 ||
      !/^[a-zA-Z0-9._~:-]+$/u.test(segment)
    )
  ) {
    return null;
  }

  return modelId;
}

function boundedPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_CONTEXT_LENGTH
    ? value
    : undefined;
}

function safeStringArray(
  value: unknown,
  maxCount: number,
  maxStringLength = MAX_METADATA_STRING_LENGTH
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  if (value.length > maxCount) {
    throw new OpenRouterDiscoveryError("openrouter_discovery_response_invalid");
  }

  const output: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const text = safeText(candidate, maxStringLength);
    if (!text || seen.has(text)) {
      continue;
    }
    seen.add(text);
    output.push(text);
  }
  return output;
}

function safePricing(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_PRICING_FIELDS) {
    throw new OpenRouterDiscoveryError("openrouter_discovery_response_invalid");
  }

  return Object.fromEntries(
    entries.flatMap(([key, rawValue]): [string, string][] => {
      if (!/^[a-z0-9_]{1,64}$/u.test(key) || FORBIDDEN_METADATA_KEYS.has(key)) {
        return [];
      }
      const valueText =
        typeof rawValue === "number" && Number.isFinite(rawValue)
          ? String(rawValue)
          : safeText(rawValue, MAX_METADATA_STRING_LENGTH);
      return valueText === null ? [] : [[key, valueText]];
    })
  );
}

function normalizeModels(value: unknown): OpenRouterDiscoveredModel[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new OpenRouterDiscoveryError("openrouter_discovery_response_invalid");
  }
  if (value.data.length > MAX_OPENROUTER_DISCOVERY_MODELS) {
    throw new OpenRouterDiscoveryError("openrouter_discovery_response_invalid");
  }

  const models: OpenRouterDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const candidate of value.data) {
    if (!isRecord(candidate)) {
      continue;
    }
    const id = normalizeModelId(candidate.id);
    if (!id) {
      continue;
    }
    if (seen.has(id)) {
      throw new OpenRouterDiscoveryError("openrouter_discovery_response_invalid");
    }
    seen.add(id);

    const architecture = isRecord(candidate.architecture) ? candidate.architecture : {};
    const contextLength = boundedPositiveInteger(candidate.context_length);
    models.push({
      ...(contextLength !== undefined ? { contextLength } : {}),
      id,
      inputModalities: safeStringArray(
        architecture.input_modalities,
        MAX_MODALITIES
      ),
      name: safeText(candidate.name, MAX_NAME_LENGTH) ?? id,
      outputModalities: safeStringArray(
        architecture.output_modalities,
        MAX_MODALITIES
      ),
      pricing: safePricing(candidate.pricing),
      supportedParameters: safeStringArray(
        candidate.supported_parameters,
        MAX_SUPPORTED_PARAMETERS
      )
    });
  }

  return models;
}

function normalizeEndpoints(value: unknown): OpenRouterDiscoveredEndpoint[] {
  if (!isRecord(value) || !isRecord(value.data) || !Array.isArray(value.data.endpoints)) {
    throw new OpenRouterDiscoveryError("openrouter_discovery_response_invalid");
  }
  if (value.data.endpoints.length > MAX_OPENROUTER_DISCOVERY_ENDPOINTS) {
    throw new OpenRouterDiscoveryError("openrouter_discovery_response_invalid");
  }

  const endpoints: OpenRouterDiscoveredEndpoint[] = [];
  const seen = new Set<string>();
  for (const candidate of value.data.endpoints) {
    if (!isRecord(candidate)) {
      continue;
    }
    const tag = safeText(candidate.tag, MAX_METADATA_STRING_LENGTH);
    if (!tag || seen.has(tag)) {
      continue;
    }
    const providerName =
      safeText(candidate.provider_name, MAX_NAME_LENGTH) ??
      safeText(candidate.name, MAX_NAME_LENGTH) ??
      tag;
    const name = safeText(candidate.name, MAX_NAME_LENGTH) ?? providerName;
    const contextLength = boundedPositiveInteger(candidate.context_length);
    const maxCompletionTokens = boundedPositiveInteger(candidate.max_completion_tokens);
    const maxPromptTokens = boundedPositiveInteger(candidate.max_prompt_tokens);
    const quantization = safeText(candidate.quantization, MAX_METADATA_STRING_LENGTH);

    seen.add(tag);
    endpoints.push({
      ...(contextLength !== undefined ? { contextLength } : {}),
      ...(maxCompletionTokens !== undefined ? { maxCompletionTokens } : {}),
      ...(maxPromptTokens !== undefined ? { maxPromptTokens } : {}),
      name,
      providerName,
      ...(quantization ? { quantization } : {}),
      supportedParameters: safeStringArray(
        candidate.supported_parameters,
        MAX_SUPPORTED_PARAMETERS
      ),
      tag
    });
  }

  return endpoints;
}

function requiredBearerToken(value: string): string {
  const token = value.trim();
  if (!token) {
    throw new OpenRouterDiscoveryError("openrouter_discovery_api_key_required");
  }
  return token;
}

function modelEndpointsPath(modelId: string): string {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    throw new OpenRouterDiscoveryError("openrouter_discovery_model_id_invalid");
  }
  const [author, slug] = normalized.split("/");
  return `models/${encodeURIComponent(author)}/${encodeURIComponent(slug)}/endpoints`;
}

export function createOpenRouterDiscoveryClient(input: {
  allowPrivateNetwork?: boolean;
  apiRoot: string;
  bearerToken: ProviderCredentialSource;
  network?: DiscoveryNetworkOptions;
  responseTimeoutMs?: number;
}): OpenRouterDiscoveryClient {
  const configuration: ProviderConnectionConfiguration =
    normalizeProviderConnectionConfiguration({
      allowPrivateNetwork: input.allowPrivateNetwork === true,
      apiRoot: input.apiRoot,
      authenticationMode: "bearer",
      responseTimeoutMs: input.responseTimeoutMs ?? DEFAULT_PROVIDER_RESPONSE_TIMEOUT_MS
    });
  assertProviderCredentialSource(
    input.bearerToken,
    "openrouter_discovery_api_key_required"
  );
  const fetchFn = createProviderSafeFetch({
    configuration,
    ...input.network
  });

  async function get(path: string, signal?: AbortSignal): Promise<unknown> {
    const timeout = withTimeoutSignal(signal, configuration.responseTimeoutMs);
    try {
      const bearerToken = requiredBearerToken(
        await resolveProviderCredentialSource(
          input.bearerToken,
          "openrouter_discovery_api_key_required"
        )
      );
      const response = await fetchFn(`${configuration.apiRoot}/${path}`, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${bearerToken}`
        },
        method: "GET",
        signal: timeout.signal
      });
      const maxBytes = Math.min(
        providerResponseMaxBytes(),
        MAX_DISCOVERY_BODY_BYTES
      );
      let text = "";
      try {
        text = await readBoundedResponseText(response, {
          maxBytes,
          signal: timeout.signal
        });
      } catch (error) {
        if (!(error instanceof ProviderResponseTooLargeError)) {
          throw error;
        }
        if (response.ok) {
          throw error;
        }
        text = error.code;
      }

      if (!response.ok) {
        throw new Error(
          providerHttpErrorMessage("OpenRouter discovery", response.status)
        );
      }
      try {
        return text ? (JSON.parse(text) as unknown) : {};
      } catch {
        throw new OpenRouterDiscoveryError("openrouter_discovery_response_invalid");
      }
    } finally {
      timeout.clear();
    }
  }

  return {
    async listEmbeddingModels(options) {
      return normalizeModels(await get("embeddings/models", options?.signal));
    },
    async listModelEndpoints(modelId, options) {
      return normalizeEndpoints(
        await get(modelEndpointsPath(modelId), options?.signal)
      );
    },
    async listModels(options) {
      return normalizeModels(await get("models/user", options?.signal));
    },
    async listRerankModels(options) {
      // The upstream filter narrows the public catalog to the rerank output
      // modality; the local re-check keeps catalog rows availability evidence
      // only, so a loose or drifting upstream filter can never classify a
      // non-rerank model as a reranker candidate.
      const models = normalizeModels(
        await get("models?output_modalities=rerank", options?.signal)
      );
      return models.filter((model) => model.outputModalities.includes("rerank"));
    }
  };
}
