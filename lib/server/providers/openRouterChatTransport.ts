import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";

export type OpenRouterChatClientRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type OpenRouterChatClient = {
  createChatCompletion(
    body: Record<string, unknown>,
    options?: OpenRouterChatClientRequestOptions
  ): Promise<Record<string, unknown>>;
  streamChatCompletion?(
    body: Record<string, unknown>,
    options?: OpenRouterChatClientRequestOptions
  ): Promise<Response>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseOpenRouterJsonResponse(
  response: Response,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, { signal });
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new Error("openrouter_response_invalid_json");
  }

  if (!isRecord(parsed)) {
    throw new Error("openrouter_response_not_object");
  }

  return parsed;
}

async function throwOpenRouterHttpError(response: Response, signal: AbortSignal): Promise<never> {
  try {
    await readBoundedResponseText(response, { signal });
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
  }

  throw new Error(providerHttpErrorMessage("OpenRouter", response.status));
}

export function createFetchOpenRouterChatClient(input: {
  apiKey: string;
  appTitle?: string;
  baseUrl?: string;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
  httpReferer?: string;
}): OpenRouterChatClient {
  const baseUrl = (input.baseUrl?.trim() || "https://openrouter.ai/api/v1").replace(/\/+$/, "");
  const fetchFn = input.fetchFn ?? fetch;
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.apiKey}`,
    "content-type": "application/json",
    ...(input.httpReferer ? { "HTTP-Referer": input.httpReferer } : {}),
    ...(input.appTitle ? { "X-Title": input.appTitle } : {})
  };

  async function postChatCompletion(
    body: Record<string, unknown>,
    options?: OpenRouterChatClientRequestOptions
  ) {
    const timeout = withTimeoutSignal(
      options?.signal,
      options?.timeoutMs ?? input.defaultTimeoutMs
    );
    try {
      const response = await fetchFn(`${baseUrl}/chat/completions`, {
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
    async createChatCompletion(body, options) {
      const exchange = await postChatCompletion(body, options);

      try {
        if (!exchange.response.ok) {
          return await throwOpenRouterHttpError(exchange.response, exchange.timeout.signal);
        }

        return await parseOpenRouterJsonResponse(exchange.response, exchange.timeout.signal);
      } finally {
        exchange.timeout.clear();
      }
    },
    async streamChatCompletion(body, options) {
      const exchange = await postChatCompletion(body, options);

      try {
        if (!exchange.response.ok) {
          return await throwOpenRouterHttpError(exchange.response, exchange.timeout.signal);
        }

        if (!exchange.response.body) {
          throw new Error("openrouter_stream_body_missing");
        }

        return exchange.response;
      } finally {
        exchange.timeout.clear();
      }
    }
  };
}
