import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";

export type OpenRouterChatClientRequestOptions = {
  signal?: AbortSignal;
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function valueAtPath(value: unknown, path: string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    if (!isRecord(current) || !(key in current)) {
      return undefined;
    }

    return current[key];
  }, value);
}

async function parseOpenRouterJsonResponse(
  response: Response,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, { signal });
  const parsed = text ? JSON.parse(text) : {};

  if (!isRecord(parsed)) {
    throw new Error("openrouter_response_not_object");
  }

  return parsed;
}

async function throwOpenRouterHttpError(response: Response, signal: AbortSignal): Promise<never> {
  let text = "";

  try {
    text = await readBoundedResponseText(response, { signal });
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
    text = error.code;
  }
  let message = `OpenRouter request failed with status ${response.status}`;

  if (text) {
    try {
      const body = JSON.parse(text) as unknown;
      const providerMessage = stringValue(valueAtPath(body, ["error", "message"]));
      message = providerMessage
        ? providerHttpErrorMessage("OpenRouter", response.status, providerMessage)
        : providerHttpErrorMessage("OpenRouter", response.status, text);
    } catch {
      message = providerHttpErrorMessage("OpenRouter", response.status, text);
    }
  }

  throw new Error(message);
}

export function createFetchOpenRouterChatClient(input: {
  apiKey: string;
  appTitle?: string;
  baseUrl?: string;
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
    const timeout = withTimeoutSignal(options?.signal);
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
