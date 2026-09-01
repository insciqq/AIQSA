import {
  ProviderResponseTooLargeError,
  isProviderDeadlineExceededError,
  providerResponseMaxBytes,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import {
  effectiveProviderResponseTimeoutMs,
  normalizeProviderConnectionConfiguration,
  normalizeProviderModelConfiguration,
  providerAuthenticationMode,
  providerRequestEndpoint,
  type EmbeddingModelConfiguration,
  type ProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "./providerConfiguration";
import {
  assertProviderCredentialSource,
  resolveProviderCredentialSource,
  type ProviderCredentialSource
} from "./providerCredentialSource";
import { createProviderSafeFetch } from "./providerSafeFetch";
import {
  executeWithProviderRetry,
  isRetryableProviderHttpStatus,
  isRetryableProviderNetworkError,
  type ProviderRetryDecision,
  type ProviderRetryOptions
} from "./providerRetry";
import { parseRetryAfterMs } from "../retryAfter";

export const MAX_EMBEDDING_BATCH_INPUTS = 128;
export const MAX_EMBEDDING_INPUT_CHARS = 131_072;
export const MAX_EMBEDDING_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024;
export const OPENROUTER_INTERACTIVE_EMBEDDING_HEDGE_DELAY_MS = 1_000;

export type EmbeddingMode = "document" | "query";

export type EmbeddingUsage = Readonly<{
  inputTokens: number | null;
  totalTokens: number | null;
}>;

export type EmbeddingResult = Readonly<{
  model: string;
  providerRequestCount?: number;
  providerRequestRoutes?: readonly (string | null)[];
  requestId: string | null;
  usage: EmbeddingUsage;
  vectors: readonly (readonly number[])[];
}>;

export type EmbeddingRequest = Readonly<{
  latencyClass?: "background" | "interactive";
  mode: EmbeddingMode;
  signal?: AbortSignal;
  texts: readonly string[];
}>;

export type EmbeddingAdapter = Readonly<{
  embed(request: EmbeddingRequest): Promise<EmbeddingResult>;
}>;

export type EmbeddingErrorCode =
  | "embedding_batch_invalid"
  | "embedding_input_invalid"
  | "embedding_provider_http_error"
  | "embedding_provider_request_failed"
  | "embedding_request_timed_out"
  | "embedding_request_too_large"
  | "embedding_response_count_mismatch"
  | "embedding_response_dimension_mismatch"
  | "embedding_response_invalid"
  | "embedding_response_model_mismatch"
  | "embedding_response_too_large"
  | "embedding_response_vector_invalid";

export class EmbeddingAdapterError extends Error {
  readonly httpStatus: number | null;
  readonly providerRequestCount: number | null;
  readonly providerRequestRoutes: readonly (string | null)[] | null;
  readonly retryAfterMs: number | null;

  constructor(
    readonly code: EmbeddingErrorCode,
    options: Readonly<{
      httpStatus?: number;
      providerRequestCount?: number;
      providerRequestRoutes?: readonly (string | null)[];
      retryAfterMs?: number | null;
    }> = {}
  ) {
    super(code);
    this.name = "EmbeddingAdapterError";
    this.httpStatus = Number.isSafeInteger(options.httpStatus) &&
      Number(options.httpStatus) >= 100 && Number(options.httpStatus) <= 599
      ? Number(options.httpStatus)
      : null;
    this.providerRequestCount = Number.isSafeInteger(options.providerRequestCount) &&
      Number(options.providerRequestCount) >= 0
      ? Number(options.providerRequestCount)
      : null;
    this.providerRequestRoutes = Array.isArray(options.providerRequestRoutes) &&
      options.providerRequestRoutes.length <= 64 &&
      options.providerRequestRoutes.every((route) => route === null ||
        typeof route === "string" && route.length > 0 && route.length <= 128 &&
        !/[\u0000-\u001f\u007f]/u.test(route))
      ? Object.freeze([...options.providerRequestRoutes])
      : null;
    this.retryAfterMs = Number.isSafeInteger(options.retryAfterMs) &&
      Number(options.retryAfterMs) > 0
      ? Number(options.retryAfterMs)
      : null;
  }
}

type EmbeddingNetworkOptions = Readonly<{
  fetchFn?: typeof fetch;
  responseMaxBytes?: number;
  retry?: ProviderRetryOptions;
}>;

function embeddingRetryDecision(
  error: unknown,
  signal: AbortSignal
): ProviderRetryDecision | null {
  if (signal.aborted || error instanceof ProviderResponseTooLargeError ||
    isProviderDeadlineExceededError(error)) return null;
  if (error instanceof EmbeddingAdapterError) {
    return error.code === "embedding_provider_http_error" &&
      isRetryableProviderHttpStatus(error.httpStatus)
      ? { retryAfterMs: error.retryAfterMs }
      : null;
  }
  return isRetryableProviderNetworkError(error) ? { retryAfterMs: null } : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedIdentifier(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function requestInputs(
  texts: readonly string[],
  mode: EmbeddingMode,
  configuration: EmbeddingModelConfiguration
): string[] {
  if (!Array.isArray(texts) || texts.length < 1 || texts.length > MAX_EMBEDDING_BATCH_INPUTS) {
    throw new EmbeddingAdapterError("embedding_batch_invalid");
  }
  if (mode !== "document" && mode !== "query") {
    throw new EmbeddingAdapterError("embedding_batch_invalid");
  }
  const prepared = texts.map((text) => {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > MAX_EMBEDDING_INPUT_CHARS ||
      /\u0000/u.test(text)
    ) {
      throw new EmbeddingAdapterError("embedding_input_invalid");
    }
    return mode === "query" && configuration.queryInstructionTemplate
      ? configuration.queryInstructionTemplate.replace("{text}", () => text)
      : text;
  });
  if (Buffer.byteLength(JSON.stringify(prepared), "utf8") > MAX_EMBEDDING_REQUEST_BYTES) {
    throw new EmbeddingAdapterError("embedding_request_too_large");
  }
  return prepared;
}

function normalizeVector(
  vector: readonly number[],
  targetDimension: number
): number[] {
  let squaredNorm = 0;
  for (let index = 0; index < vector.length; index += 1) {
    const value = vector[index];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new EmbeddingAdapterError("embedding_response_vector_invalid");
    }
    if (index < targetDimension) squaredNorm += value * value;
  }
  if (!Number.isFinite(squaredNorm) || squaredNorm <= 0) {
    throw new EmbeddingAdapterError("embedding_response_vector_invalid");
  }
  const norm = Math.sqrt(squaredNorm);
  return vector.slice(0, targetDimension).map((value) => value / norm);
}

function responseUsage(value: unknown): EmbeddingUsage {
  if (value === undefined) {
    return { inputTokens: null, totalTokens: null };
  }
  if (!isRecord(value)) {
    throw new EmbeddingAdapterError("embedding_response_invalid");
  }
  const inputTokens = value.prompt_tokens === undefined
    ? value.input_tokens === undefined
      ? null
      : nonnegativeInteger(value.input_tokens)
    : nonnegativeInteger(value.prompt_tokens);
  const totalTokens = value.total_tokens === undefined
    ? null
    : nonnegativeInteger(value.total_tokens);
  if (
    (value.prompt_tokens !== undefined || value.input_tokens !== undefined) && inputTokens === null ||
    value.total_tokens !== undefined && totalTokens === null
  ) {
    throw new EmbeddingAdapterError("embedding_response_invalid");
  }
  return { inputTokens, totalTokens };
}

function responseVectors(
  value: unknown,
  expectedCount: number,
  configuration: EmbeddingModelConfiguration
): readonly (readonly number[])[] {
  if (!Array.isArray(value)) {
    throw new EmbeddingAdapterError("embedding_response_invalid");
  }
  if (value.length !== expectedCount) {
    throw new EmbeddingAdapterError("embedding_response_count_mismatch");
  }
  const vectors: Array<readonly number[] | undefined> = new Array(expectedCount);
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      !Number.isSafeInteger(entry.index) ||
      Number(entry.index) < 0 ||
      Number(entry.index) >= expectedCount ||
      vectors[Number(entry.index)] !== undefined ||
      !Array.isArray(entry.embedding)
    ) {
      throw new EmbeddingAdapterError("embedding_response_invalid");
    }
    if (entry.embedding.length !== configuration.nativeDimension) {
      throw new EmbeddingAdapterError("embedding_response_dimension_mismatch");
    }
    vectors[Number(entry.index)] = normalizeVector(
      entry.embedding as number[],
      configuration.targetDimension
    );
  }
  if (vectors.some((vector) => vector === undefined)) {
    throw new EmbeddingAdapterError("embedding_response_count_mismatch");
  }
  return vectors as readonly (readonly number[])[];
}

function responseBody(
  value: unknown,
  expectedCount: number,
  model: ProviderModelConfiguration,
  requestId: string | null
): EmbeddingResult {
  if (!isRecord(value) || typeof value.model !== "string" || !model.embedding) {
    throw new EmbeddingAdapterError("embedding_response_invalid");
  }
  const openRouterModel = model.embedding.providerFamily === "openrouter"
    ? model.upstreamModelId.toLowerCase()
    : null;
  const openRouterSlug = openRouterModel?.split("/").at(-1) ?? null;
  const responseModel = value.model.toLowerCase();
  if (
    value.model !== model.upstreamModelId &&
    (!openRouterModel || responseModel !== openRouterModel) &&
    (!openRouterSlug || responseModel !== openRouterSlug)
  ) {
    throw new EmbeddingAdapterError("embedding_response_model_mismatch");
  }
  return {
    model: value.model,
    requestId,
    usage: responseUsage(value.usage),
    vectors: responseVectors(value.data, expectedCount, model.embedding)
  };
}

function serializedRequestBody(
  prepared: readonly string[],
  model: ProviderModelConfiguration,
  pinnedOpenRouterProvider: string | null = null
): string {
  const selectedRouting = model.openRouterRouting?.mode === "only_selected"
    ? model.openRouterRouting
    : null;
  const body = {
    encoding_format: "float",
    input: prepared,
    model: model.upstreamModelId,
    ...(model.embedding?.providerFamily === "openrouter"
      ? {
          provider: {
            allow_fallbacks: pinnedOpenRouterProvider === null &&
              model.openRouterRouting !== undefined,
            data_collection: "deny",
            ...(pinnedOpenRouterProvider !== null
              ? {
                  only: [pinnedOpenRouterProvider],
                  order: [pinnedOpenRouterProvider]
                }
              : selectedRouting
                ? {
                    only: [...selectedRouting.providers],
                    order: [...selectedRouting.providers]
                  }
                : {})
          }
        }
      : {})
  };
  const serialized = JSON.stringify(body);
  if (Buffer.byteLength(serialized, "utf8") > MAX_EMBEDDING_REQUEST_BYTES) {
    throw new EmbeddingAdapterError("embedding_request_too_large");
  }
  return serialized;
}

function abortReason(signal: AbortSignal): unknown {
  return typeof signal.reason === "undefined"
    ? new DOMException("The operation was aborted", "AbortError")
    : signal.reason;
}

function waitForHedge(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      clearTimeout(timeout);
      reject(abortReason(signal));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

function hedgeFailure(error: unknown): unknown {
  if (!(error instanceof AggregateError)) return error;
  const failures = error.errors as unknown[];
  return failures.find((failure) =>
    failure instanceof ProviderResponseTooLargeError ||
    failure instanceof EmbeddingAdapterError
  ) ?? failures[0] ?? error;
}

function interactiveOpenRouterProviders(
  request: EmbeddingRequest,
  model: ProviderModelConfiguration
): readonly string[] {
  const interactive = request.latencyClass === "interactive" ||
    request.latencyClass === undefined && request.mode === "query";
  return interactive &&
    model.embedding?.providerFamily === "openrouter" &&
    model.openRouterRouting?.mode === "only_selected" &&
    model.openRouterRouting.providers.length > 1
    ? model.openRouterRouting.providers
    : [];
}

export function createOpenAICompatibleEmbeddingAdapter(input: Readonly<{
  connection: ProviderConnectionConfiguration;
  model: ProviderModelConfiguration;
  network?: EmbeddingNetworkOptions;
  secret: ProviderCredentialSource | null;
}>): EmbeddingAdapter {
  const connection = normalizeProviderConnectionConfiguration(input.connection);
  const model = normalizeProviderModelConfiguration(input.model);
  if (model.modelClass !== "embedding" || !model.embedding) {
    throw new EmbeddingAdapterError("embedding_input_invalid");
  }
  const authenticationMode = providerAuthenticationMode(connection);
  if (authenticationMode === "bearer") {
    if (input.secret === null) throw new EmbeddingAdapterError("embedding_provider_request_failed");
    assertProviderCredentialSource(input.secret, "embedding_provider_request_failed");
  } else if (input.secret !== null) {
    throw new EmbeddingAdapterError("embedding_provider_request_failed");
  }
  const fetchFn = input.network?.fetchFn ?? createProviderSafeFetch({ configuration: connection });
  const responseMaxBytes = Math.min(
    input.network?.responseMaxBytes ?? providerResponseMaxBytes(),
    MAX_EMBEDDING_RESPONSE_BYTES
  );

  return {
    async embed(request) {
      const prepared = requestInputs(request.texts, request.mode, model.embedding!);
      const timeoutMs = effectiveProviderResponseTimeoutMs(connection, model);
      const timeout = withTimeoutSignal(request.signal, timeoutMs);
      const providerRequestRoutes: Array<string | null> = [];
      try {
        const secret = authenticationMode === "bearer"
          ? await resolveProviderCredentialSource(
              input.secret as ProviderCredentialSource,
              "embedding_provider_request_failed"
            )
          : null;
        const headers = new Headers({
          accept: "application/json",
          "content-type": "application/json"
        });
        if (secret !== null) headers.set("authorization", `Bearer ${secret}`);
        const executeRequest = (
          serialized: string,
          signal: AbortSignal,
          pinnedOpenRouterProvider: string | null
        ) => executeWithProviderRetry({
          operation: async () => {
            providerRequestRoutes.push(pinnedOpenRouterProvider);
            const response = await fetchFn(providerRequestEndpoint(
              connection,
              "openai_embeddings_compatible"
            ), {
              body: serialized,
              headers,
              method: "POST",
              redirect: "error",
              signal
            });
            const text = await readBoundedResponseText(response, {
              maxBytes: responseMaxBytes,
              signal
            });
            if (!response.ok) {
              throw new EmbeddingAdapterError("embedding_provider_http_error", {
                httpStatus: response.status,
                retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"))
              });
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(text) as unknown;
            } catch {
              throw new EmbeddingAdapterError("embedding_response_invalid");
            }
            return responseBody(
              parsed,
              prepared.length,
              model,
              boundedIdentifier(response.headers.get("x-request-id"))
            );
          },
          options: input.network?.retry,
          shouldRetry: (error) => embeddingRetryDecision(error, signal),
          signal
        });
        const hedgeProviders = interactiveOpenRouterProviders(request, model);
        if (hedgeProviders.length === 0) {
          const result = await executeRequest(
            serializedRequestBody(prepared, model),
            timeout.signal,
            null
          );
          return Object.freeze({
            ...result,
            providerRequestCount: providerRequestRoutes.length,
            providerRequestRoutes: Object.freeze([...providerRequestRoutes])
          });
        }

        const settled = new AbortController();
        const hedgeSignal = AbortSignal.any([timeout.signal, settled.signal]);
        try {
          const result = await Promise.any(hedgeProviders.map(async (provider, index) => {
            if (index > 0) {
              await waitForHedge(
                OPENROUTER_INTERACTIVE_EMBEDDING_HEDGE_DELAY_MS * index,
                hedgeSignal
              );
            }
            return executeRequest(
              serializedRequestBody(prepared, model, provider),
              hedgeSignal,
              provider
            );
          }));
          settled.abort(new DOMException("Embedding hedge settled", "AbortError"));
          return Object.freeze({
            ...result,
            providerRequestCount: providerRequestRoutes.length,
            providerRequestRoutes: Object.freeze([...providerRequestRoutes])
          });
        } catch (error) {
          throw hedgeFailure(error);
        } finally {
          if (!settled.signal.aborted) {
            settled.abort(new DOMException("Embedding hedge settled", "AbortError"));
          }
        }
      } catch (error) {
        if (
          isProviderDeadlineExceededError(error) ||
          timeout.signal.aborted && isProviderDeadlineExceededError(timeout.signal.reason)
        ) {
          throw new EmbeddingAdapterError("embedding_request_timed_out", {
            providerRequestCount: providerRequestRoutes.length,
            providerRequestRoutes
          });
        }
        if (error instanceof EmbeddingAdapterError) {
          throw new EmbeddingAdapterError(error.code, {
            ...(error.httpStatus !== null ? { httpStatus: error.httpStatus } : {}),
            providerRequestCount: providerRequestRoutes.length,
            providerRequestRoutes,
            retryAfterMs: error.retryAfterMs
          });
        }
        if (error instanceof ProviderResponseTooLargeError) {
          throw new EmbeddingAdapterError("embedding_response_too_large", {
            providerRequestCount: providerRequestRoutes.length,
            providerRequestRoutes
          });
        }
        throw new EmbeddingAdapterError("embedding_provider_request_failed", {
          providerRequestCount: providerRequestRoutes.length,
          providerRequestRoutes
        });
      } finally {
        timeout.clear();
      }
    }
  };
}
