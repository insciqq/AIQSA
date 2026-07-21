import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";

export type OpenAIResponseObject = Record<string, unknown>;

export type OpenAIResponsesClientRequestOptions = {
  signal?: AbortSignal;
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
  readonly retryable: boolean;
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OpenAIHttpError";
    this.retryable = retryableHttpStatuses.has(status);
    this.status = status;
  }
}

function valueAtPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (typeof current !== "object" || current === null || !(key in current)) {
      return undefined;
    }

    return (current as Record<string, unknown>)[key];
  }, value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function parseOpenAIJsonResponse(
  response: Response,
  signal: AbortSignal
): Promise<OpenAIResponseObject> {
  const text = await readBoundedResponseText(response, { signal });
  const parsed = text ? JSON.parse(text) : {};

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("openai_response_not_object");
  }

  return parsed as OpenAIResponseObject;
}

async function throwOpenAIHttpError(response: Response, signal: AbortSignal): Promise<never> {
  let message = `OpenAI request failed with status ${response.status}`;
  let text = "";

  try {
    text = await readBoundedResponseText(response, { signal });
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
    text = error.code;
  }

  try {
    const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    const providerMessage = stringValue(valueAtPath(body, ["error", "message"]));
    if (providerMessage) {
      message = providerHttpErrorMessage("OpenAI", response.status, providerMessage);
    }
  } catch {
    if (text) {
      message = providerHttpErrorMessage("OpenAI", response.status, text);
    }
  }

  throw new OpenAIHttpError(message, response.status);
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
  apiKey: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): OpenAIResponsesClient {
  const baseUrl = input.baseUrl?.trim() || "https://api.openai.com/v1";
  const fetchFn = input.fetchFn ?? fetch;
  const headers = {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json"
  };

  async function postResponse(
    body: OpenAIResponseObject,
    options?: OpenAIResponsesClientRequestOptions
  ) {
    const timeout = withTimeoutSignal(options?.signal);
    try {
      const response = await fetchFn(`${baseUrl}/responses`, {
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
    async cancel(responseId) {
      const timeout = withTimeoutSignal();
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
        if (!exchange.response.ok) {
          return await throwOpenAIHttpError(exchange.response, exchange.timeout.signal);
        }

        return await parseOpenAIJsonResponse(exchange.response, exchange.timeout.signal);
      } finally {
        exchange.timeout.clear();
      }
    },
    async retrieve(responseId, options) {
      const timeout = withTimeoutSignal(options?.signal);
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
        if (!exchange.response.ok) {
          return await throwOpenAIHttpError(exchange.response, exchange.timeout.signal);
        }

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
