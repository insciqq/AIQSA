import {
  providerResponseMaxBytes,
  readBoundedResponseText,
  withTimeoutSignal
} from "../../providers/network";
import {
  normalizeProviderConnectionConfiguration,
  providerAuthenticationMode,
  type ProviderConnectionConfiguration,
  type ProviderFamily,
  type ProviderModelClass
} from "../../providers/providerConfiguration";
import {
  resolveProviderCredentialSource,
  type ProviderCredentialSource
} from "../../providers/providerCredentialSource";
import {
  createProviderSafeFetch,
  type ProviderSafeFetchOptions
} from "../../providers/providerSafeFetch";
import type {
  AdminCompatibleDiscoveredCapabilities,
  AdminCompatibleDiscoveredModel
} from "../../../contracts/adminProviders";

const MAX_CREDENTIAL_TEST_BODY_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_ID_LENGTH = 256;

export const MAX_PROVIDER_CREDENTIAL_TEST_MODELS = 1_000;

export type AdminProviderCredentialTesterInput = Readonly<{
  connection: ProviderConnectionConfiguration;
  family: ProviderFamily;
  modelClasses?: readonly ProviderModelClass[];
  secret: ProviderCredentialSource | null;
  signal?: AbortSignal;
}>;

export type AdminProviderCredentialTestOutcome = Readonly<{
  method: "models_catalog";
  modelIds: string[];
  modelIdsByClass?: Readonly<Record<ProviderModelClass, string[]>>;
  models?: AdminCompatibleDiscoveredModel[];
}>;

export type AdminProviderCredentialTester = Readonly<{
  test(input: AdminProviderCredentialTesterInput): Promise<AdminProviderCredentialTestOutcome>;
}>;

export class AdminProviderCredentialTestError extends Error {
  readonly code = "provider_credential_test_failed" as const;

  constructor() {
    super("provider_credential_test_failed");
    this.name = "AdminProviderCredentialTestError";
  }
}

type CredentialTesterOptions = Readonly<{
  network?: Omit<ProviderSafeFetchOptions, "configuration">;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized &&
    normalized.length <= MAX_MODEL_ID_LENGTH &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function firstInteger(values: readonly unknown[]): number | undefined {
  return values.find((value): value is number =>
    Number.isInteger(value) && Number(value) > 0 && Number(value) <= 10_000_000
  ) as number | undefined;
}

function safeControl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 32 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function controlOptions(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16) return [];
  const options: string[] = [];
  for (const candidate of value) {
    const option = safeControl(isRecord(candidate) ? candidate.effort ?? candidate.mode : candidate);
    if (!option || options.includes(option)) continue;
    options.push(option);
  }
  return options;
}

function compatibleCapabilities(entry: Record<string, unknown>): AdminCompatibleDiscoveredCapabilities {
  const capabilities = isRecord(entry.capabilities) ? entry.capabilities : {};
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  const reasoningEfforts = controlOptions(
    metadata.supported_reasoning_levels ??
    entry.supported_reasoning_levels ??
    metadata.reasoning_efforts ??
    entry.reasoning_efforts
  );
  const reasoningModes = controlOptions(
    metadata.supported_reasoning_modes ??
    entry.supported_reasoning_modes ??
    metadata.reasoning_modes ??
    entry.reasoning_modes
  );
  const reportedReasoning = [
    entry.supportsReasoning,
    entry.supports_reasoning,
    capabilities.supports_reasoning,
    metadata.supports_reasoning
  ].find((value): value is boolean => typeof value === "boolean");
  const reasoning = reportedReasoning ?? (reasoningEfforts.length > 0 ? true : undefined);
  const defaultReasoningEffort = safeControl(
    metadata.default_reasoning_level ??
    entry.default_reasoning_level ??
    metadata.default_reasoning_effort ??
    entry.default_reasoning_effort
  );
  const defaultReasoningMode = safeControl(
    metadata.default_reasoning_mode ?? entry.default_reasoning_mode
  );
  const contextWindow = firstInteger([
    entry.contextWindow,
    entry.context_length,
    capabilities.context_length,
    metadata.context_window
  ]);
  const defaultMaxOutputTokens = firstInteger([
    entry.maxOutputTokens,
    entry.max_output_tokens,
    capabilities.max_output_tokens,
    metadata.max_output_tokens
  ]);

  return {
    ...(contextWindow ? { contextWindow } : {}),
    ...(defaultMaxOutputTokens ? { defaultMaxOutputTokens } : {}),
    ...(reasoning === undefined ? {} : { reasoning }),
    ...(reasoning && reasoningEfforts.length ? {
      reasoningEfforts,
      defaultReasoningEffort: defaultReasoningEffort && reasoningEfforts.includes(defaultReasoningEffort)
        ? defaultReasoningEffort
        : reasoningEfforts[0]!
    } : {}),
    ...(reasoning && reasoningModes.length ? {
      reasoningModes,
      defaultReasoningMode: defaultReasoningMode && reasoningModes.includes(defaultReasoningMode)
        ? defaultReasoningMode
        : reasoningModes[0]!
    } : {})
  };
}

function modelsFromCatalog(
  value: unknown,
  family: ProviderFamily
): AdminCompatibleDiscoveredModel[] {
  if (!isRecord(value)) {
    throw new AdminProviderCredentialTestError();
  }

  const entries = family === "gemini" ? value.models : value.data;
  if (!Array.isArray(entries) || entries.length > MAX_PROVIDER_CREDENTIAL_TEST_MODELS) {
    throw new AdminProviderCredentialTestError();
  }
  if (family === "gemini" && value.nextPageToken !== undefined) {
    throw new AdminProviderCredentialTestError();
  }

  const output: AdminCompatibleDiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    const rawId = isRecord(entry)
      ? modelId(family === "gemini" ? entry.name : entry.id)
      : null;
    const id = family === "gemini" && rawId?.startsWith("models/")
      ? modelId(rawId.slice("models/".length))
      : rawId;
    if (!id) throw new AdminProviderCredentialTestError();
    if (seen.has(id)) continue;
    seen.add(id);
    output.push({
      capabilities: family === "openai_compatible" && isRecord(entry)
        ? compatibleCapabilities(entry)
        : {},
      id
    });
  }
  return output;
}

function answerCatalogPath(family: ProviderFamily): string {
  if (family === "openrouter") return "models/user";
  return family === "gemini" ? "models?pageSize=1000" : "models";
}

function requestedModelClasses(
  family: ProviderFamily,
  value: readonly ProviderModelClass[] | undefined
): ProviderModelClass[] {
  const classes = [...new Set(value ?? ["answer"])] as ProviderModelClass[];
  if (
    classes.length < 1 ||
    classes.some((modelClass) => modelClass !== "answer" &&
      modelClass !== "embedding" && modelClass !== "reranker") ||
    (family !== "openai" && family !== "openai_compatible" && family !== "openrouter") &&
      classes.includes("embedding") ||
    family !== "openrouter" && classes.includes("reranker")
  ) {
    throw new AdminProviderCredentialTestError();
  }
  return classes;
}

function authenticationHeaders(family: ProviderFamily, secret: string | null): Headers {
  const headers = new Headers({ accept: "application/json" });
  if (secret === null) return headers;
  if (family === "anthropic") {
    headers.set("anthropic-version", "2023-06-01");
    headers.set("x-api-key", secret);
  } else if (family === "gemini") {
    headers.set("x-goog-api-key", secret);
  } else {
    headers.set("authorization", `Bearer ${secret}`);
  }
  return headers;
}

export function createAdminProviderCredentialTester(
  options: CredentialTesterOptions = {}
): AdminProviderCredentialTester {
  return {
    async test(input) {
      try {
        const connection = normalizeProviderConnectionConfiguration(input.connection);
        const authenticationMode = providerAuthenticationMode(connection);
        const secret = authenticationMode === "none"
          ? input.secret === null
            ? null
            : (() => { throw new AdminProviderCredentialTestError(); })()
          : input.secret === null
            ? (() => { throw new AdminProviderCredentialTestError(); })()
            : await resolveProviderCredentialSource(
                input.secret,
                "provider_credential_test_failed"
              );
        const fetchFn = createProviderSafeFetch({
          configuration: connection,
          ...options.network
        });
        const timeout = withTimeoutSignal(input.signal, connection.responseTimeoutMs);
        try {
          const classes = requestedModelClasses(input.family, input.modelClasses);
          const load = async (path: string): Promise<AdminCompatibleDiscoveredModel[]> => {
            const response = await fetchFn(`${connection.apiRoot}/${path}`, {
              headers: authenticationHeaders(input.family, secret),
              method: "GET",
              redirect: "error",
              signal: timeout.signal
            });
            const text = await readBoundedResponseText(response, {
              maxBytes: Math.min(providerResponseMaxBytes(), MAX_CREDENTIAL_TEST_BODY_BYTES),
              signal: timeout.signal
            });
            if (!response.ok) throw new AdminProviderCredentialTestError();
            try {
              return modelsFromCatalog(JSON.parse(text) as unknown, input.family);
            } catch {
              throw new AdminProviderCredentialTestError();
            }
          };
          const answerModels = classes.includes("answer") || classes.includes("reranker")
            ? await load(answerCatalogPath(input.family))
            : [];
          const embeddingModels = classes.includes("embedding")
            ? input.family === "openrouter"
              ? await load("embeddings/models")
              : await load(answerCatalogPath(input.family))
            : [];
          const modelIdsByClass = {
            answer: classes.includes("answer") ? answerModels.map(({ id }) => id) : [],
            embedding: embeddingModels.map(({ id }) => id),
            reranker: classes.includes("reranker") ? answerModels.map(({ id }) => id) : []
          };
          const models = [...new Map(
            [...answerModels, ...embeddingModels].map((model) => [model.id, model])
          ).values()];
          return {
            method: "models_catalog",
            modelIds: models.map(({ id }) => id),
            ...(input.modelClasses ? { modelIdsByClass } : {}),
            ...(input.family === "openai_compatible" ? { models } : {})
          };
        } finally {
          timeout.clear();
        }
      } catch {
        // Provider bodies, transport details, and credential-source errors are never surfaced.
        throw new AdminProviderCredentialTestError();
      }
    }
  };
}
