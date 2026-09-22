import { observeJsonParse } from "./providerObservability";
import { providerResponseFailure } from "./responseFailure";
import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  providerStreamTimingLimits,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import {
  executeWithProviderRetry,
  isRetryableProviderNetworkError,
  type ProviderRetryOptions
} from "./providerRetry";
import { parseRetryAfterMs } from "../retryAfter";
import { randomUUID } from "node:crypto";
import { parseSseStream } from "./sse";

export type OpenAIResponseObject = Record<string, unknown>;

export type OpenAIResponsesClientRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type OpenAIResponsesClient = {
  cancel(responseId: string): Promise<OpenAIResponseObject>;
  create(body: OpenAIResponseObject, options?: OpenAIResponsesClientRequestOptions): Promise<OpenAIResponseObject>;
  retrieve(responseId: string, options?: OpenAIResponsesClientRequestOptions): Promise<OpenAIResponseObject>;
  stream?(body: OpenAIResponseObject, options?: OpenAIResponsesClientRequestOptions): Promise<Response>;
};

export type OpenAIRetryableErrorPayload = {
  message: string;
  retryable: true;
  status: number;
};

const retryableHttpStatuses = new Set([408, 409, 429, 500, 502, 503, 504]);

class OpenAIHttpError extends Error {
  readonly retryAfterMs: number | null;
  readonly retryable: boolean;
  readonly status: number;

  constructor(message: string, status: number, retryAfterMs: number | null) {
    super(message);
    this.name = "OpenAIHttpError";
    this.retryAfterMs = retryAfterMs;
    this.retryable = retryableHttpStatuses.has(status);
    this.status = status;
  }
}

async function parseOpenAIJsonResponse(
  response: Response,
  signal: AbortSignal
): Promise<OpenAIResponseObject> {
  const text = await readBoundedResponseText(response, { signal });
  let parsed: unknown;
  try {
    parsed = observeJsonParse(response, () => text ? JSON.parse(text) : {});
  } catch {
    throw new Error("openai_response_invalid_json");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("openai_response_not_object");
  }

  return parsed as OpenAIResponseObject;
}

/** Some compatible roots always stream, even for stream:false. Assemble only
 * provider-issued completed items, under explicit terminal proof, without a retry. */
async function collectStreamedResponse(response: Response, signal: AbortSignal, timeoutMs?: number): Promise<OpenAIResponseObject> {
  if (!response.body) throw new Error("openai_stream_body_missing");
  const items = new Map<number, OpenAIResponseObject>();
  for await (const event of parseSseStream(response.body, { signal, maxBytes: 16 * 1024 * 1024,
    maxEventBytes: 16 * 1024 * 1024, ...providerStreamTimingLimits(timeoutMs) })) {
    if (event.data === "[DONE]") break;
    let value: unknown;
    try { value = JSON.parse(event.data); } catch { throw new Error("openai_response_invalid_json"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("openai_response_invalid_json");
    const payload = value as Record<string, unknown>;
    if (payload.type === "response.output_item.done") {
      if (!Number.isSafeInteger(payload.output_index) || Number(payload.output_index) < 0 || Number(payload.output_index) >= 1024 ||
        !payload.item || typeof payload.item !== "object" || Array.isArray(payload.item) || items.has(Number(payload.output_index))) {
        throw new Error("openai_response_invalid_output");
      }
      items.set(Number(payload.output_index), payload.item as OpenAIResponseObject);
    }
    if (["response.completed", "response.failed", "response.incomplete"].includes(String(payload.type))) {
      if (!payload.response || typeof payload.response !== "object" || Array.isArray(payload.response)) throw new Error("openai_response_invalid_json");
      const terminal = payload.response as OpenAIResponseObject;
      if (`response.${String(terminal.status)}` !== payload.type) throw new Error("openai_response_invalid_terminal");
      return { ...terminal, output: Array.isArray(terminal.output) && terminal.output.length ? terminal.output
        : [...items.entries()].sort(([a], [b]) => a - b).map(([, item]) => item) };
    }
    if (payload.type === "error") throw new Error("openai_response_stream_failed");
  }
  throw new Error("openai_response_not_completed");
}

async function throwOpenAIHttpError(response: Response, signal: AbortSignal): Promise<never> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  let failureCode: string | undefined;
  let unsupportedInput = false;
  let capabilityFailureReason: "refusal" | "budget_exhausted" | undefined;
  try {
    const text = await readBoundedResponseText(response, { signal });
    try {
      const parsed: unknown = observeJsonParse(response, () => JSON.parse(text));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const failure = providerResponseFailure("provider_response_failed", parsed as Record<string, unknown>);
        failureCode = "code" in failure && typeof failure.code === "string" ? failure.code : undefined;
        unsupportedInput = "unsupportedInput" in failure && failure.unsupportedInput === true;
        if ("capabilityFailureReason" in failure && (failure.capabilityFailureReason === "refusal" || failure.capabilityFailureReason === "budget_exhausted")) capabilityFailureReason = failure.capabilityFailureReason;
      }
    } catch { /* An undecodable error body never changes the HTTP classification. */ }
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
  }

  throw Object.assign(new OpenAIHttpError(
    providerHttpErrorMessage("OpenAI", response.status),
    response.status,
    retryAfterMs
  ), failureCode && response.status !== 401 && response.status !== 403
    ? { code: failureCode, ...(unsupportedInput ? { unsupportedInput: true } : {}), ...(capabilityFailureReason ? { capabilityFailureReason } : {}) }
    : {});
}

function initialRequestRetryDecision(
  error: unknown,
  signal: AbortSignal
): Readonly<{ retryAfterMs: number | null }> | null {
  if (signal.aborted) return null;
  if (error instanceof OpenAIHttpError && error.retryable) {
    return { retryAfterMs: error.retryAfterMs };
  }
  return isRetryableProviderNetworkError(error) ? { retryAfterMs: null } : null;
}

export function openAIRetryableErrorPayload(error: unknown): OpenAIRetryableErrorPayload | null {
  if (!(error instanceof OpenAIHttpError) || !error.retryable) {
    return null;
  }

  return {
    message: error.message,
    retryable: true,
    status: error.status
  };
}

export function createFetchOpenAIResponsesClient(input: {
  apiKey: string | null;
  baseUrl?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
  /**
   * Opt-in only for stateless/replayable Responses requests. Native
   * background Responses deliberately leave this unset because a failed
   * create can have crash-ambiguous provider state without a response id.
   */
  initialRequestRetry?: ProviderRetryOptions;
  /** Adds a fresh opaque routing key to every physical compatible POST. */
  requestIsolation?: boolean;
  /** Compatible Responses may deliver an SSE representation of a nonstream create. */
  acceptStreamedCreate?: boolean;
}): OpenAIResponsesClient {
  const baseUrl = input.baseUrl?.trim() || "https://api.openai.com/v1";
  const fetchFn = input.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    "content-type": "application/json"
  };
  if (input.apiKey !== null) {
    headers.authorization = `Bearer ${input.apiKey}`;
  }

  async function postResponse(
    body: OpenAIResponseObject,
    options?: OpenAIResponsesClientRequestOptions
  ) {
    const timeout = withTimeoutSignal(
      options?.signal,
      options?.timeoutMs ?? input.defaultTimeoutMs
    );
    try {
      const operation = async () => {
        // Generate inside the retry operation: each physical POST, including an
        // explicitly allowed replay, receives a distinct routing identity.
        const requestBody = input.requestIsolation
          ? { ...body, prompt_cache_key: randomUUID() }
          : body;
        const response = await fetchFn(`${baseUrl}/responses`, {
          body: JSON.stringify(requestBody),
          headers,
          method: "POST",
          signal: timeout.signal
        });
        if (!response.ok) {
          return await throwOpenAIHttpError(response, timeout.signal);
        }
        return response;
      };
      const response = input.initialRequestRetry
        ? await executeWithProviderRetry({
            operation,
            options: input.initialRequestRetry,
            shouldRetry: (error) => initialRequestRetryDecision(error, timeout.signal),
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
    async cancel(responseId) {
      const timeout = withTimeoutSignal(undefined, input.defaultTimeoutMs);
      try {
        const response = await fetchFn(`${baseUrl}/responses/${responseId}/cancel`, {
          body: "{}",
          headers,
          method: "POST",
          signal: timeout.signal
        });

        if (!response.ok) {
          return await throwOpenAIHttpError(response, timeout.signal);
        }

        return await parseOpenAIJsonResponse(response, timeout.signal);
      } finally {
        timeout.clear();
      }
    },
    async create(body, options) {
      const exchange = await postResponse(body, options);

      try {
        if (input.acceptStreamedCreate && exchange.response.headers.get("content-type")?.includes("text/event-stream")) {
          return await collectStreamedResponse(exchange.response, exchange.timeout.signal, options?.timeoutMs ?? input.defaultTimeoutMs);
        }
        return await parseOpenAIJsonResponse(exchange.response, exchange.timeout.signal);
      } finally {
        exchange.timeout.clear();
      }
    },
    async retrieve(responseId, options) {
      const timeout = withTimeoutSignal(
        options?.signal,
        options?.timeoutMs ?? input.defaultTimeoutMs
      );
      try {
        const response = await fetchFn(`${baseUrl}/responses/${responseId}`, {
          headers,
          method: "GET",
          signal: timeout.signal
        });

        if (!response.ok) {
          return await throwOpenAIHttpError(response, timeout.signal);
        }

        return await parseOpenAIJsonResponse(response, timeout.signal);
      } finally {
        timeout.clear();
      }
    },
    async stream(body, options) {
      const exchange = await postResponse(body, options);

      try {
        if (!exchange.response.body) {
          throw new Error("openai_stream_body_missing");
        }

        return exchange.response;
      } finally {
        exchange.timeout.clear();
      }
    }
  };
}
