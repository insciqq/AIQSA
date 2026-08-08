import { createHash } from "node:crypto";
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

export const MAX_EMBEDDING_BATCH_INPUTS = 128;
export const MAX_EMBEDDING_INPUT_CHARS = 131_072;
export const MAX_EMBEDDING_REQUEST_BYTES = 2 * 1024 * 1024;
export const MAX_EMBEDDING_RESPONSE_BYTES = 16 * 1024 * 1024;

export type EmbeddingMode = "document" | "query";

export type EmbeddingUsage = Readonly<{
  inputTokens: number | null;
  totalTokens: number | null;
}>;

export type EmbeddingResult = Readonly<{
  model: string;
  requestId: string | null;
  usage: EmbeddingUsage;
  vectors: readonly (readonly number[])[];
}>;

export type EmbeddingRequest = Readonly<{
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
  constructor(readonly code: EmbeddingErrorCode) {
    super(code);
    this.name = "EmbeddingAdapterError";
  }
}

type EmbeddingNetworkOptions = Readonly<{
  fetchFn?: typeof fetch;
  responseMaxBytes?: number;
}>;

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
  if (value.model !== model.upstreamModelId) {
    throw new EmbeddingAdapterError("embedding_response_model_mismatch");
  }
  return {
    model: value.model,
    requestId,
    usage: responseUsage(value.usage),
    vectors: responseVectors(value.data, expectedCount, model.embedding)
  };
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
      const body = {
        encoding_format: "float",
        input: prepared,
        model: model.upstreamModelId,
        ...(model.embedding!.providerFamily === "openrouter"
          ? {
              provider: {
                allow_fallbacks: false,
                data_collection: "deny"
              }
            }
          : {})
      };
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > MAX_EMBEDDING_REQUEST_BYTES) {
        throw new EmbeddingAdapterError("embedding_request_too_large");
      }
      const timeoutMs = effectiveProviderResponseTimeoutMs(connection, model);
      const timeout = withTimeoutSignal(request.signal, timeoutMs);
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
        const response = await fetchFn(providerRequestEndpoint(
          connection,
          "openai_embeddings_compatible"
        ), {
          body: serialized,
          headers,
          method: "POST",
          redirect: "error",
          signal: timeout.signal
        });
        const text = await readBoundedResponseText(response, {
          maxBytes: responseMaxBytes,
          signal: timeout.signal
        });
        if (!response.ok) {
          throw new EmbeddingAdapterError("embedding_provider_http_error");
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
      } catch (error) {
        if (error instanceof EmbeddingAdapterError) throw error;
        if (error instanceof ProviderResponseTooLargeError) {
          throw new EmbeddingAdapterError("embedding_response_too_large");
        }
        if (
          isProviderDeadlineExceededError(error) ||
          timeout.signal.aborted && isProviderDeadlineExceededError(timeout.signal.reason)
        ) {
          throw new EmbeddingAdapterError("embedding_request_timed_out");
        }
        throw new EmbeddingAdapterError("embedding_provider_request_failed");
      } finally {
        timeout.clear();
      }
    }
  };
}

function fakeVector(text: string, dimension: number, seed: string): number[] {
  const vector: number[] = [];
  for (let counter = 0; vector.length < dimension; counter += 1) {
    const digest = createHash("sha256")
      .update(seed, "utf8")
      .update("\u0000", "utf8")
      .update(text, "utf8")
      .update("\u0000", "utf8")
      .update(String(counter), "utf8")
      .digest();
    for (let offset = 0; offset + 4 <= digest.length && vector.length < dimension; offset += 4) {
      vector.push(digest.readInt32BE(offset) / 0x8000_0000);
    }
  }
  return vector;
}

export function createFakeEmbeddingAdapter(input: Readonly<{
  configuration: EmbeddingModelConfiguration;
  seed?: string;
}>): EmbeddingAdapter {
  const configuration = input.configuration;
  if (
    !Number.isSafeInteger(configuration.nativeDimension) ||
    !Number.isSafeInteger(configuration.targetDimension) ||
    configuration.targetDimension < 1 ||
    configuration.targetDimension > configuration.nativeDimension ||
    !configuration.supportsMrl && configuration.targetDimension !== configuration.nativeDimension
  ) {
    throw new EmbeddingAdapterError("embedding_input_invalid");
  }
  return {
    async embed(request) {
      const prepared = requestInputs(request.texts, request.mode, configuration);
      const inputTokens = prepared.reduce(
        (total, text) => total + Math.ceil(Buffer.byteLength(text, "utf8") / 4),
        0
      );
      return {
        model: "fake-embedding",
        requestId: null,
        usage: { inputTokens, totalTokens: inputTokens },
        vectors: prepared.map((text) => normalizeVector(
          fakeVector(text, configuration.nativeDimension, input.seed ?? "aiqsa"),
          configuration.targetDimension
        ))
      };
    }
  };
}
