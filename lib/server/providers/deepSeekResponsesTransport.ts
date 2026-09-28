import { observeJsonParse } from "./providerObservability";
import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  providerResponseMaxBytes,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import {
  PROVIDER_CONTEXT_LENGTH_EXCEEDED,
  providerContextLengthRejection,
  type ProviderContextLengthCounts
} from "./responseFailure";

export type DeepSeekResponseObject = Record<string, unknown>;

export type DeepSeekResponsesClientRequestOptions = Readonly<{
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

export type DeepSeekResponsesClient = Readonly<{
  create(
    body: DeepSeekResponseObject,
    options?: DeepSeekResponsesClientRequestOptions
  ): Promise<DeepSeekResponseObject>;
  stream(
    body: DeepSeekResponseObject,
    options?: DeepSeekResponsesClientRequestOptions
  ): Promise<Response>;
}>;

const retryableHttpStatuses = new Set([408, 409, 429, 500, 502, 503, 504]);

export class DeepSeekHttpError extends Error {
  readonly retryable: boolean;
  readonly status: number;

  constructor(status: number) {
    super(providerHttpErrorMessage("DeepSeek", status));
    this.name = "DeepSeekHttpError";
    this.retryable = retryableHttpStatuses.has(status);
    this.status = status;
  }
}

export function deepSeekResponseError(error: unknown): Error {
  if (!(error instanceof Error) || !error.message.startsWith("openai_")) {
    return error instanceof Error ? error : new Error("deepseek_response_failed");
  }
  return new Error(error.message.replace(/^openai_/u, "deepseek_"));
}

async function parseJsonResponse(
  response: Response,
  signal: AbortSignal
): Promise<DeepSeekResponseObject> {
  const text = await readBoundedResponseText(response, { signal });
  let parsed: unknown;
  try {
    parsed = observeJsonParse(response, () => text ? JSON.parse(text) : {});
  } catch {
    throw new Error("deepseek_response_invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("deepseek_response_not_object");
  }
  return parsed as DeepSeekResponseObject;
}

/** Only reviewed error identities and context counts leave this bounded body. */
function rejectionFacts(text: string): Readonly<{
  contextLength: ProviderContextLengthCounts | null;
  invalidRequest: boolean;
}> {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return { contextLength: null, invalidRequest: false }; }
  const error = typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>).error : null;
  const record = typeof error === "object" && error !== null && !Array.isArray(error)
    ? error as Record<string, unknown> : null;
  return {
    contextLength: record ? providerContextLengthRejection(record) : null,
    invalidRequest: record?.type === "invalid_request_error" || record?.code === "invalid_request_error"
  };
}

async function throwHttpError(response: Response, signal: AbortSignal): Promise<never> {
  let contextLength: ProviderContextLengthCounts | null = null;
  let invalidRequest = false;
  try {
    const text = await readBoundedResponseText(response, { maxBytes: Math.min(providerResponseMaxBytes(), 64 * 1024), signal });
    if (response.status === 400) ({ contextLength, invalidRequest } = rejectionFacts(text));
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) throw error;
  }
  throw Object.assign(new DeepSeekHttpError(response.status),
    contextLength ? { code: PROVIDER_CONTEXT_LENGTH_EXCEEDED, ...contextLength }
      : invalidRequest ? { code: "provider_http_invalid_request" } : {});
}

export function createFetchDeepSeekResponsesClient(input: Readonly<{
  apiKey: string;
  apiRoot?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}>): DeepSeekResponsesClient {
  const apiRoot = input.apiRoot?.trim().replace(/\/+$/u, "") || "https://api.deepseek.com";
  const fetchFn = input.fetchFn ?? fetch;
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json"
  };

  async function post(
    body: DeepSeekResponseObject,
    options?: DeepSeekResponsesClientRequestOptions
  ): Promise<Readonly<{ response: Response; timeout: ReturnType<typeof withTimeoutSignal> }>> {
    const timeout = withTimeoutSignal(
      options?.signal,
      options?.timeoutMs ?? input.defaultTimeoutMs
    );
    try {
      const response = await fetchFn(`${apiRoot}/responses`, {
        body: JSON.stringify(body),
        headers,
        method: "POST",
        signal: timeout.signal
      });
      return { response, timeout };
    } catch (error) {
      timeout.clear();
      throw error;
    }
  }

  return {
    async create(body, options) {
      const exchange = await post(body, options);
      try {
        if (!exchange.response.ok) {
          return await throwHttpError(exchange.response, exchange.timeout.signal);
        }
        return await parseJsonResponse(exchange.response, exchange.timeout.signal);
      } finally {
        exchange.timeout.clear();
      }
    },
    async stream(body, options) {
      const exchange = await post(body, options);
      try {
        if (!exchange.response.ok) {
          return await throwHttpError(exchange.response, exchange.timeout.signal);
        }
        if (!exchange.response.body) {
          throw new Error("deepseek_stream_body_missing");
        }
        return exchange.response;
      } finally {
        exchange.timeout.clear();
      }
    }
  };
}
