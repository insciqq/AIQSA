import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import {
  executeWithProviderRetry,
  isRetryableProviderNetworkError,
  type ProviderRetryOptions
} from "./providerRetry";
import { parseRetryAfterMs } from "../retryAfter";

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
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("openai_response_invalid_json");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("openai_response_not_object");
  }

  return parsed as OpenAIResponseObject;
}

async function throwOpenAIHttpError(response: Response, signal: AbortSignal): Promise<never> {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  try {
    await readBoundedResponseText(response, { signal });
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
  }

  throw new OpenAIHttpError(
    providerHttpErrorMessage("OpenAI", response.status),
    response.status,
    retryAfterMs
  );
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
      const serializedBody = JSON.stringify(body);
      const operation = async () => {
        const response = await fetchFn(`${baseUrl}/responses`, {
          body: serializedBody,
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
