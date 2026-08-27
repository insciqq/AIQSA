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
  type ProviderConnectionConfiguration,
  type ProviderModelConfiguration
} from "./providerConfiguration";
import {
  assertProviderCredentialSource,
  resolveProviderCredentialSource,
  type ProviderCredentialSource
} from "./providerCredentialSource";
import { createProviderSafeFetch } from "./providerSafeFetch";
import { parseRetryAfterMs } from "../retryAfter";

export const MAX_RERANK_DOCUMENTS = 96;
export const MAX_RERANK_QUERY_CHARACTERS = 2_000;
export const MAX_RERANK_INSTRUCTION_CHARACTERS = 2_000;
export const MAX_RERANK_DOCUMENT_CHARACTERS = 8_192;
export const MAX_RERANK_REQUEST_BYTES = 512 * 1024;
export const MAX_RERANK_RESPONSE_BYTES = 2 * 1024 * 1024;

export type RerankDocument = Readonly<{
  handle: string;
  text: string;
}>;

export type RerankRequest = Readonly<{
  documents: readonly RerankDocument[];
  instruction?: string | null;
  query: string;
  signal?: AbortSignal;
}>;

export type RerankScore = Readonly<{
  handle: string;
  index: number;
  relevanceScore: number;
}>;

export type RerankUsage = Readonly<{
  inputTokens: number | null;
  searchUnits: number | null;
  totalTokens: number | null;
}>;

export type RerankResult = Readonly<{
  model: string;
  provider: string | null;
  requestId: string | null;
  scores: readonly RerankScore[];
  usage: RerankUsage;
}>;

export type RerankAdapter = Readonly<{
  rerank(request: RerankRequest): Promise<RerankResult>;
}>;

export type RerankErrorCode =
  | "rerank_documents_invalid"
  | "rerank_input_invalid"
  | "rerank_provider_http_error"
  | "rerank_provider_request_failed"
  | "rerank_request_timed_out"
  | "rerank_request_too_large"
  | "rerank_response_invalid"
  | "rerank_response_model_mismatch"
  | "rerank_response_too_large";

export class RerankAdapterError extends Error {
  readonly httpStatus: number | null;
  readonly retryAfterMs: number | null;

  constructor(
    readonly code: RerankErrorCode,
    options: Readonly<{ httpStatus?: number; retryAfterMs?: number | null }> = {}
  ) {
    super(code);
    this.name = "RerankAdapterError";
    this.httpStatus = Number.isSafeInteger(options.httpStatus) &&
      Number(options.httpStatus) >= 100 && Number(options.httpStatus) <= 599
      ? Number(options.httpStatus)
      : null;
    this.retryAfterMs = Number.isSafeInteger(options.retryAfterMs) &&
      Number(options.retryAfterMs) > 0
      ? Number(options.retryAfterMs)
      : null;
  }
}

type RerankNetworkOptions = Readonly<{
  fetchFn?: typeof fetch;
  responseMaxBytes?: number;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedInput(value: unknown, maxCharacters: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    value.length <= maxCharacters && !value.includes("\u0000");
}

function boundedIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized
    : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function requestDocuments(documents: readonly RerankDocument[]): RerankDocument[] {
  if (!Array.isArray(documents) || documents.length < 1 ||
    documents.length > MAX_RERANK_DOCUMENTS) {
    throw new RerankAdapterError("rerank_documents_invalid");
  }
  const seen = new Set<string>();
  return documents.map((document) => {
    const value: unknown = document;
    const record = isRecord(value) ? value : null;
    const handle = boundedIdentifier(record?.handle);
    const text = record?.text;
    if (!handle || record?.handle !== handle || seen.has(handle) ||
      !boundedInput(text, MAX_RERANK_DOCUMENT_CHARACTERS)) {
      throw new RerankAdapterError("rerank_documents_invalid");
    }
    seen.add(handle);
    return { handle, text };
  });
}

function responseUsage(value: unknown): RerankUsage {
  if (value === undefined) {
    return { inputTokens: null, searchUnits: null, totalTokens: null };
  }
  if (!isRecord(value)) throw new RerankAdapterError("rerank_response_invalid");
  const inputTokens = value.input_tokens === undefined &&
    value.prompt_tokens === undefined
    ? null
    : nonnegativeInteger(value.input_tokens ?? value.prompt_tokens);
  const searchUnits = value.search_units === undefined
    ? null
    : nonnegativeInteger(value.search_units);
  const totalTokens = value.total_tokens === undefined
    ? null
    : nonnegativeInteger(value.total_tokens);
  if (
    (value.input_tokens !== undefined || value.prompt_tokens !== undefined) &&
      inputTokens === null ||
    value.search_units !== undefined && searchUnits === null ||
    value.total_tokens !== undefined && totalTokens === null
  ) throw new RerankAdapterError("rerank_response_invalid");
  return { inputTokens, searchUnits, totalTokens };
}

function responseModelMatches(
  actual: string,
  expected: string,
  provider: string | null
): boolean {
  const normalizedActual = actual.toLocaleLowerCase("und");
  const normalizedExpected = expected.toLocaleLowerCase("und");
  const expectedSlug = normalizedExpected.split("/").at(-1);
  if (normalizedActual === normalizedExpected || normalizedActual === expectedSlug) {
    return true;
  }
  const providerNativeParts = normalizedActual.split("/");
  return provider !== null && providerNativeParts.length === 4 &&
    providerNativeParts[0] === "accounts" && providerNativeParts[2] === "models" &&
    providerNativeParts[1] === provider.toLocaleLowerCase("und") &&
    providerNativeParts[3] === expectedSlug;
}

function responseBody(
  value: unknown,
  documents: readonly RerankDocument[],
  model: ProviderModelConfiguration,
  headerRequestId: string | null
): RerankResult {
  const body = isRecord(value) ? value : null;
  const responseModel = boundedIdentifier(body?.model);
  const responseProvider = boundedIdentifier(body?.provider);
  if (!body || !responseModel ||
    !responseModelMatches(responseModel, model.upstreamModelId, responseProvider) ||
    !Array.isArray(body.results) ||
    body.results.length > MAX_RERANK_DOCUMENTS * 4) {
    if (isRecord(value) && typeof value.model === "string" &&
      !responseModelMatches(value.model, model.upstreamModelId, responseProvider)) {
      throw new RerankAdapterError("rerank_response_model_mismatch");
    }
    throw new RerankAdapterError("rerank_response_invalid");
  }
  const scores: RerankScore[] = [];
  const seen = new Set<number>();
  for (const entry of body.results) {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.index)) continue;
    const index = Number(entry.index);
    const score = entry.relevance_score;
    if (index < 0 || index >= documents.length || seen.has(index) ||
      typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 1) {
      continue;
    }
    seen.add(index);
    scores.push({
      handle: documents[index]!.handle,
      index,
      relevanceScore: score
    });
  }
  if (scores.length < 1) throw new RerankAdapterError("rerank_response_invalid");
  return {
    model: responseModel,
    provider: responseProvider,
    requestId: boundedIdentifier(body.id) ?? headerRequestId,
    scores,
    usage: responseUsage(body.usage)
  };
}

export function createOpenRouterRerankAdapter(input: Readonly<{
  connection: ProviderConnectionConfiguration;
  model: ProviderModelConfiguration;
  network?: RerankNetworkOptions;
  secret: ProviderCredentialSource;
}>): RerankAdapter {
  const connection = normalizeProviderConnectionConfiguration(input.connection);
  const model = normalizeProviderModelConfiguration(input.model);
  if (model.modelClass !== "reranker" || model.adapterKind !== "openrouter_rerank" ||
    !model.openRouterRouting || providerAuthenticationMode(connection) !== "bearer") {
    throw new RerankAdapterError("rerank_input_invalid");
  }
  assertProviderCredentialSource(input.secret, "rerank_provider_request_failed");
  const fetchFn = input.network?.fetchFn ?? createProviderSafeFetch({ configuration: connection });
  const responseMaxBytes = Math.min(
    input.network?.responseMaxBytes ?? providerResponseMaxBytes(),
    MAX_RERANK_RESPONSE_BYTES
  );

  return Object.freeze({
    async rerank(request) {
      if (!boundedInput(request.query, MAX_RERANK_QUERY_CHARACTERS) ||
        request.instruction !== undefined && request.instruction !== null &&
          !boundedInput(request.instruction, MAX_RERANK_INSTRUCTION_CHARACTERS)) {
        throw new RerankAdapterError("rerank_input_invalid");
      }
      const documents = requestDocuments(request.documents);
      const routing = model.openRouterRouting!;
      const body = {
        documents: documents.map(({ text }) => text),
        model: model.upstreamModelId,
        provider: {
          allow_fallbacks: routing.mode === "automatic",
          data_collection: "deny",
          ...(routing.mode === "only_selected"
            ? { only: [...routing.providers], order: [...routing.providers] }
            : {})
        },
        query: request.instruction
          ? `${request.instruction}\n\n${request.query}`
          : request.query,
        top_n: documents.length
      };
      const serialized = JSON.stringify(body);
      if (Buffer.byteLength(serialized, "utf8") > MAX_RERANK_REQUEST_BYTES) {
        throw new RerankAdapterError("rerank_request_too_large");
      }
      const timeout = withTimeoutSignal(
        request.signal,
        effectiveProviderResponseTimeoutMs(connection, model)
      );
      try {
        const secret = await resolveProviderCredentialSource(
          input.secret,
          "rerank_provider_request_failed"
        );
        const response = await fetchFn(providerRequestEndpoint(
          connection,
          "openrouter_rerank"
        ), {
          body: serialized,
          headers: {
            accept: "application/json",
            authorization: `Bearer ${secret}`,
            "content-type": "application/json"
          },
          method: "POST",
          redirect: "error",
          signal: timeout.signal
        });
        const text = await readBoundedResponseText(response, {
          maxBytes: responseMaxBytes,
          signal: timeout.signal
        });
        if (!response.ok) {
          throw new RerankAdapterError("rerank_provider_http_error", {
            httpStatus: response.status,
            retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after"))
          });
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(text) as unknown;
        } catch {
          throw new RerankAdapterError("rerank_response_invalid");
        }
        return responseBody(
          parsed,
          documents,
          model,
          boundedIdentifier(response.headers.get("x-request-id"))
        );
      } catch (error) {
        if (error instanceof RerankAdapterError) throw error;
        if (error instanceof ProviderResponseTooLargeError) {
          throw new RerankAdapterError("rerank_response_too_large");
        }
        if (isProviderDeadlineExceededError(error) ||
          timeout.signal.aborted && isProviderDeadlineExceededError(timeout.signal.reason)) {
          throw new RerankAdapterError("rerank_request_timed_out");
        }
        throw new RerankAdapterError("rerank_provider_request_failed");
      } finally {
        timeout.clear();
      }
    }
  });
}
