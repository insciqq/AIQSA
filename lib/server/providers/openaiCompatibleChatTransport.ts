import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";

export type OpenAICompatibleChatClientRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type OpenAICompatibleChatClient = {
  createChatCompletion(
    body: Record<string, unknown>,
    options?: OpenAICompatibleChatClientRequestOptions
  ): Promise<Record<string, unknown>>;
  streamChatCompletion(
    body: Record<string, unknown>,
    options?: OpenAICompatibleChatClientRequestOptions
  ): Promise<Response>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredBearerToken(value: string | null | undefined): string {
  if (typeof value !== "string") {
    throw new Error("openai_compatible_chat_bearer_token_required");
  }
  const token = value.trim();
  if (!token) {
    throw new Error("openai_compatible_chat_bearer_token_required");
  }

  return token;
}

export function deriveOpenAICompatibleChatEndpoint(apiRoot: string): string {
  const root = apiRoot.trim();
  if (!root) {
    throw new Error("openai_compatible_chat_api_root_required");
  }
  if (/[\u0000-\u001F\u007F]/.test(root)) {
    throw new Error("openai_compatible_chat_api_root_invalid");
  }

  let parsed: URL;
  try {
    parsed = new URL(root);
  } catch {
    throw new Error("openai_compatible_chat_api_root_invalid");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("openai_compatible_chat_api_root_invalid");
  }

  return `${root.replace(/\/+$/, "")}/chat/completions`;
}

async function parseJsonResponse(
  response: Response,
  signal: AbortSignal
): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, { signal });
  let parsed: unknown;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    throw new Error("openai_compatible_chat_response_invalid_json");
  }

  if (!isRecord(parsed)) {
    throw new Error("openai_compatible_chat_response_not_object");
  }

  return parsed;
}

async function throwHttpError(response: Response, signal: AbortSignal): Promise<never> {
  try {
    await readBoundedResponseText(response, { signal });
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
  }

  throw new Error(providerHttpErrorMessage("OpenAI-compatible", response.status));
}

export function createFetchOpenAICompatibleChatClient(input: {
  apiRoot: string;
  authenticationMode?: "bearer" | "none";
  bearerToken?: string | null;
  defaultTimeoutMs?: number;
  fetchFn?: typeof fetch;
}): OpenAICompatibleChatClient {
  const endpoint = deriveOpenAICompatibleChatEndpoint(input.apiRoot);
  const authenticationMode = input.authenticationMode ?? "bearer";
  if (authenticationMode !== "bearer" && authenticationMode !== "none") {
    throw new Error("openai_compatible_chat_authentication_invalid");
  }
  const bearerToken = authenticationMode === "bearer"
    ? requiredBearerToken(input.bearerToken)
    : null;
  if (
    authenticationMode === "none" &&
    input.bearerToken !== null &&
    input.bearerToken !== undefined
  ) {
    throw new Error("openai_compatible_chat_authentication_invalid");
  }
  const fetchFn = input.fetchFn ?? fetch;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  async function post(
    body: Record<string, unknown>,
    options?: OpenAICompatibleChatClientRequestOptions
  ) {
    const timeout = withTimeoutSignal(
      options?.signal,
      options?.timeoutMs ?? input.defaultTimeoutMs
    );
    try {
      const response = await fetchFn(endpoint, {
        body: JSON.stringify(body),
        headers,
        method: "POST",
        redirect: "error",
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
    async streamChatCompletion(body, options) {
      const exchange = await post(body, options);

      try {
        if (!exchange.response.ok) {
          return await throwHttpError(exchange.response, exchange.timeout.signal);
        }
        if (!exchange.response.body) {
          throw new Error("openai_compatible_chat_stream_body_missing");
        }

        return exchange.response;
      } finally {
        exchange.timeout.clear();
      }
    }
  };
}
