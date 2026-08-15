import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";
import { isOpenAIChatRecord } from "./openaiChatCompletions";

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
  signal: AbortSignal,
  errors: Readonly<{ invalidJson: string; notObject: string }>
): Promise<Record<string, unknown>> {
  const text = await readBoundedResponseText(response, { signal });
  let parsed: unknown;
  try {
    parsed = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    throw new Error(errors.invalidJson);
  }

  if (!isOpenAIChatRecord(parsed)) {
    throw new Error(errors.notObject);
  }

  return parsed;
}

async function throwHttpError(
  response: Response,
  signal: AbortSignal,
  providerName: string
): Promise<never> {
  try {
    await readBoundedResponseText(response, { signal });
  } catch (error) {
    if (!(error instanceof ProviderResponseTooLargeError)) {
      throw error;
    }
  }

  throw new Error(providerHttpErrorMessage(providerName, response.status));
}

export function createFetchOpenAIChatCompletionClient(input: Readonly<{
  bodyMissingError: string;
  defaultTimeoutMs?: number;
  endpoint: string;
  fetchFn?: typeof fetch;
  headers: Readonly<Record<string, string>>;
  invalidJsonError: string;
  notObjectError: string;
  providerName: string;
  redirect?: RequestRedirect;
}>): OpenAICompatibleChatClient {
  const fetchFn = input.fetchFn ?? fetch;

  async function post(
    body: Record<string, unknown>,
    options?: OpenAICompatibleChatClientRequestOptions
  ) {
    const timeout = withTimeoutSignal(
      options?.signal,
      options?.timeoutMs ?? input.defaultTimeoutMs
    );
    try {
      const response = await fetchFn(input.endpoint, {
        body: JSON.stringify(body),
        headers: input.headers,
        method: "POST",
        ...(input.redirect ? { redirect: input.redirect } : {}),
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
          return await throwHttpError(
            exchange.response,
            exchange.timeout.signal,
            input.providerName
          );
        }

        return await parseJsonResponse(exchange.response, exchange.timeout.signal, {
          invalidJson: input.invalidJsonError,
          notObject: input.notObjectError
        });
      } finally {
        exchange.timeout.clear();
      }
    },
    async streamChatCompletion(body, options) {
      const exchange = await post(body, options);

      try {
        if (!exchange.response.ok) {
          return await throwHttpError(
            exchange.response,
            exchange.timeout.signal,
            input.providerName
          );
        }
        if (!exchange.response.body) {
          throw new Error(input.bodyMissingError);
        }

        return exchange.response;
      } finally {
        exchange.timeout.clear();
      }
    }
  };
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
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (bearerToken) headers.authorization = `Bearer ${bearerToken}`;

  return createFetchOpenAIChatCompletionClient({
    bodyMissingError: "openai_compatible_chat_stream_body_missing",
    defaultTimeoutMs: input.defaultTimeoutMs,
    endpoint,
    fetchFn: input.fetchFn,
    headers,
    invalidJsonError: "openai_compatible_chat_response_invalid_json",
    notObjectError: "openai_compatible_chat_response_not_object",
    providerName: "OpenAI-compatible",
    redirect: "error"
  });
}
