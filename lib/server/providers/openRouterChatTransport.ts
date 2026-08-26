import {
  createFetchOpenAIChatCompletionClient,
  type OpenAICompatibleChatClient
} from "./openaiCompatibleChatTransport";

export type OpenRouterChatClient = Omit<
  OpenAICompatibleChatClient,
  "streamChatCompletion"
> & Readonly<{
  streamChatCompletion?: OpenAICompatibleChatClient["streamChatCompletion"];
}>;

function usesStrictOpenRouterTool(body: Readonly<Record<string, unknown>>): boolean {
  if (body.tool_choice === "none" || !Array.isArray(body.tools)) return false;
  return body.tools.some((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = (tool as Record<string, unknown>).function;
    return Boolean(
      fn && typeof fn === "object" && !Array.isArray(fn) &&
      (fn as Record<string, unknown>).strict === true
    );
  });
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

  return createFetchOpenAIChatCompletionClient({
    bodyMissingError: "openrouter_stream_body_missing",
    defaultTimeoutMs: input.defaultTimeoutMs,
    endpoint: `${baseUrl}/chat/completions`,
    fetchFn: input.fetchFn,
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
      ...(input.httpReferer ? { "HTTP-Referer": input.httpReferer } : {}),
      ...(input.appTitle ? { "X-Title": input.appTitle } : {})
    },
    headersForBody: (body): Readonly<Record<string, string>> => usesStrictOpenRouterTool(body)
      ? { "x-anthropic-beta": "structured-outputs-2025-11-13" }
      : {},
    invalidJsonError: "openrouter_response_invalid_json",
    notObjectError: "openrouter_response_not_object",
    providerName: "OpenRouter"
  });
}
