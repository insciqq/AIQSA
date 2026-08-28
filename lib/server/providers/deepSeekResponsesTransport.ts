import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";

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
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("deepseek_response_invalid_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("deepseek_response_not_object");
  }
  return parsed as DeepSeekResponseObject;
}

async function throwHttpError(response: Response, signal: AbortSignal): Promise<never> {
  try {
    await readBoundedResponseText(response, { signal });
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) throw error;
  }
  throw new DeepSeekHttpError(response.status);
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
