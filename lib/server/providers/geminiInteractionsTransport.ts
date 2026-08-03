import {
  ProviderResponseTooLargeError,
  providerHttpErrorMessage,
  readBoundedResponseText,
  withTimeoutSignal
} from "./network";

export type GeminiInteractionObject = Record<string, unknown>;

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
    parsed = text ? JSON.parse(text) as unknown : {};
  } catch {
    throw new Error("gemini_interactions_response_invalid_json");
  }
  if (!isRecord(parsed)) {
    throw new Error("gemini_interactions_response_not_object");
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

  throw new Error(providerHttpErrorMessage("Gemini", response.status));
}

export function createFetchGeminiInteractionsClient(input: Readonly<{
  apiKey: string;
  apiRoot?: string;
  fetchFn?: typeof fetch;
}>): GeminiInteractionsClient {
  const endpoint = deriveGeminiInteractionsEndpoint(
    input.apiRoot?.trim() || "https://generativelanguage.googleapis.com/v1"
  );
  const apiKey = requiredApiKey(input.apiKey);
  const fetchFn = input.fetchFn ?? fetch;
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    "x-goog-api-key": apiKey
  };

  async function post(
    body: Record<string, unknown>,
    options?: GeminiInteractionsClientRequestOptions
  ): Promise<Readonly<{ response: Response; timeout: ReturnType<typeof withTimeoutSignal> }>> {
    const timeout = withTimeoutSignal(options?.signal, options?.timeoutMs);
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
    async createInteraction(body, options) {
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
    async streamInteraction(body, options) {
      const exchange = await post(body, options);
      try {
        if (!exchange.response.ok) {
          return await throwHttpError(exchange.response, exchange.timeout.signal);
        }
        if (!exchange.response.body) {
          throw new Error("gemini_interactions_stream_body_missing");
        }
        return exchange.response;
      } finally {
        exchange.timeout.clear();
      }
    }
  };
}
