import { observeJsonParse } from "./providerObservability";
import { GeminiInteractionsStreamError } from "./geminiInteractionsStreamError";
import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  providerResponseMaxBytes,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import {
  executeWithProviderRetry,
  initialRequestTransportFailure,
  ownsInitialRequestReplay,
  type ProviderRetryDecision,
  type ProviderRetryOptions
} from "./providerRetry";
import { providerRequestNotSent } from "./providerSafeFetch";
import { providerContextLengthRejection, type ProviderContextLengthCounts } from "./responseFailure";
import { parseRetryAfterMs } from "../retryAfter";

export type GeminiInteractionObject = Record<string, unknown>;

const GEMINI_HTTP_ERROR_CODES = [
  "malformed_tool_call", "malformed_function_call", "invalid_request", "parameter_unknown",
  // Derived from the reviewed context-length classification of a 400 (its
  // message names the input token count exceeding the maximum). The
  // Interactions API's own answer to an oversized input, observed 2026-09-27,
  // is the generic `invalid_request` "Invalid input received." envelope, the
  // same as for a rejected tool schema, so this identity triggers only on the
  // reviewed sentences and Gemini gets no rebuild on this API.
  "context_length_exceeded"
] as const;
export type GeminiHttpErrorCode = (typeof GEMINI_HTTP_ERROR_CODES)[number];

// Type-only counts merged into the class: they declare no class field, so the
// properties stay absent unless the provider stated them.
export interface GeminiHttpError {
  readonly reportedMaximumTokens?: number;
  readonly reportedPromptTokens?: number;
}

/** Only reviewed error identities cross the transport boundary; never retain
 * provider messages, arguments or the error envelope. A context-length
 * identity also carries the token counts the provider stated, and
 * `retryAfterMs` is the parsed Retry-After header (null when absent). */
export class GeminiHttpError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code?: GeminiHttpErrorCode,
    counts?: ProviderContextLengthCounts,
    readonly retryAfterMs: number | null = null
  ) {
    super(providerHttpErrorMessage("Gemini", httpStatus));
    this.name = "GeminiHttpError";
    if (code === "context_length_exceeded" && counts) Object.assign(this, counts);
  }
}

/**
 * Initial-request replay classification owned by the native Gemini
 * Interactions path. Every Interactions body is sent with `store: false` and
 * without `previous_interaction_id`, so a replay cannot duplicate stored
 * interaction state; the only remaining risk is a duplicate billed generation.
 *
 * - Proven-unsent transport failures (`providerRequestNotSent`) never reached
 *   Google.
 * - 429 RESOURCE_EXHAUSTED and 503 UNAVAILABLE, with or without Retry-After,
 *   are the errors Google names to retry with exponential backoff
 *   (https://ai.google.dev/gemini-api/docs/troubleshooting), and a request that
 *   fails with a 400 or 500 error is not charged for tokens, although it counts
 *   against quota (https://ai.google.dev/gemini-api/docs/billing); the bounded
 *   attempt limit keeps that quota cost small. Both pages rechecked 2026-10-02.
 * - 408 is replayed only when its Retry-After explicitly asks for a new attempt.
 *
 * 500, 502 and 504 are not named retry-eligible (a 500 from an oversized
 * context is usually deterministic), and 4xx rejections are final: none of them
 * is replayed. An aborted signal is never replayed.
 */
function geminiInitialRequestRetryDecision(error: unknown, signal: AbortSignal): ProviderRetryDecision | null {
  if (signal.aborted) return null;
  if (error instanceof GeminiHttpError) {
    if (error.httpStatus === 429 || error.httpStatus === 503) return { retryAfterMs: error.retryAfterMs };
    return error.httpStatus === 408 && error.retryAfterMs !== null ? { retryAfterMs: error.retryAfterMs } : null;
  }
  return providerRequestNotSent(error) ? { retryAfterMs: null } : null;
}

function geminiHttpErrorIdentity(text: string, httpStatus: number): Readonly<{
  code?: GeminiHttpErrorCode;
  counts?: ProviderContextLengthCounts;
}> {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return {}; }
  // Google streaming endpoints may wrap the one error envelope in an array.
  const value = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  if (!isRecord(value) || !isRecord(value.error)) return {};
  const counts = httpStatus === 400 ? providerContextLengthRejection(value.error) : null;
  if (counts) return { code: "context_length_exceeded", counts };
  const candidate = value.error.code;
  return { code: GEMINI_HTTP_ERROR_CODES.find((code) => code !== "context_length_exceeded" && code === candidate) };
}

export type GeminiInteractionsClientRequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type GeminiInteractionsClient = {
  createInteraction(
    body: Record<string, unknown>,
    options?: GeminiInteractionsClientRequestOptions
  ): Promise<GeminiInteractionObject>;
  streamInteraction(
    body: Record<string, unknown>,
    options?: GeminiInteractionsClientRequestOptions
  ): Promise<Response>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredApiKey(value: string): string {
  const apiKey = value.trim();
  if (!apiKey) {
    throw new Error("gemini_interactions_api_key_required");
  }
  return apiKey;
}

export function deriveGeminiInteractionsEndpoint(apiRoot: string): string {
  const root = apiRoot.trim();
  if (!root) {
    throw new Error("gemini_interactions_api_root_required");
  }
  if (/[\u0000-\u001f\u007f]/u.test(root)) {
    throw new Error("gemini_interactions_api_root_invalid");
  }

  let parsed: URL;
  try {
    parsed = new URL(root);
  } catch {
    throw new Error("gemini_interactions_api_root_invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !parsed.hostname ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("gemini_interactions_api_root_invalid");
  }

  return `${root.replace(/\/+$/u, "")}/interactions`;
}

async function parseJsonResponse(
  response: Response,
  signal: AbortSignal
): Promise<GeminiInteractionObject> {
  const text = await readBoundedResponseText(response, { signal });
  let parsed: unknown;
  try {
    parsed = observeJsonParse(response, () => text ? JSON.parse(text) as unknown : {});
  } catch {
    throw new Error("gemini_interactions_response_invalid_json");
  }
  if (!isRecord(parsed)) {
    throw new Error("gemini_interactions_response_not_object");
  }
  return parsed;
}

async function throwHttpError(response: Response, signal: AbortSignal): Promise<never> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  let identity: ReturnType<typeof geminiHttpErrorIdentity> = {};
  try {
    identity = geminiHttpErrorIdentity(await readBoundedResponseText(response, {
      signal, maxBytes: Math.min(providerResponseMaxBytes(), 16_384)
    }), response.status);
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
  }

  throw new GeminiHttpError(response.status, identity.code, identity.counts, retryAfterMs);
}

export function createFetchGeminiInteractionsClient(input: Readonly<{
  apiKey: string;
  apiRoot?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
  /**
   * Opt-in bounded replay of the initial POST. It replays only failures that
   * prove Google did not accept the request (`geminiInitialRequestRetryDecision`)
   * and, unless `maxAttempts` is 1, reports any other transport loss as
   * `provider_request_outcome_unknown`. Without it every request is sent once
   * and transport failures keep their raw identity. A 2xx response is never
   * replayed, whatever its body or stream later does.
   */
  initialRequestRetry?: ProviderRetryOptions;
}>): GeminiInteractionsClient {
  const endpoint = deriveGeminiInteractionsEndpoint(
    input.apiRoot?.trim() || "https://generativelanguage.googleapis.com/v1"
  );
  const apiKey = requiredApiKey(input.apiKey);
  const fetchFn = input.fetchFn ?? fetch;
  const transportOwnsReplay = ownsInitialRequestReplay(input.initialRequestRetry);
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "x-goog-api-key": apiKey
  };

  async function post(
    body: Record<string, unknown>,
    options?: GeminiInteractionsClientRequestOptions
  ): Promise<Readonly<{ response: Response; timeout: ReturnType<typeof withTimeoutSignal> }>> {
    const timeout = withTimeoutSignal(
      options?.signal,
      options?.timeoutMs ?? input.defaultTimeoutMs
    );
    try {
      // One serialization: every attempt, including an admitted replay, sends
      // byte-identical content under the one request deadline above.
      const requestBody = JSON.stringify(body);
      const operation = async () => {
        let response: Response;
        try {
          response = await fetchFn(endpoint, {
            body: requestBody,
            headers,
            method: "POST",
            redirect: "error",
            signal: timeout.signal
          });
        } catch (error) {
          throw transportOwnsReplay ? initialRequestTransportFailure(error, timeout.signal) : error;
        }
        if (!response.ok) {
          return await throwHttpError(response, timeout.signal);
        }
        return response;
      };
      const response = input.initialRequestRetry
        ? await executeWithProviderRetry({
            operation,
            options: input.initialRequestRetry,
            shouldRetry: (error) => geminiInitialRequestRetryDecision(error, timeout.signal),
            signal: timeout.signal
          })
        : await operation();
      return { response, timeout };
    } catch (error) {
      timeout.clear();
      throw error;
    }
  }

  return {
    async createInteraction(body, options) {
      const exchange = await post(body, options);
      try {
        return await parseJsonResponse(exchange.response, exchange.timeout.signal);
      } finally {
        exchange.timeout.clear();
      }
    },
    async streamInteraction(body, options) {
      const exchange = await post(body, options);
      try {
        if (!exchange.response.body) {
          throw new GeminiInteractionsStreamError("gemini_interactions_stream_body_missing");
        }
        return exchange.response;
      } finally {
        exchange.timeout.clear();
      }
    }
  };
}
