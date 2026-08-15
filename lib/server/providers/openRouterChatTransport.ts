import {
  createFetchOpenAIChatCompletionClient,
  type OpenAICompatibleChatClient,
  type OpenAICompatibleChatClientRequestOptions
} from "./openaiCompatibleChatTransport";

export type OpenRouterChatClientRequestOptions = OpenAICompatibleChatClientRequestOptions;

export type OpenRouterChatClient = Omit<
  OpenAICompatibleChatClient,
  "streamChatCompletion"
> & Readonly<{
  streamChatCompletion?: OpenAICompatibleChatClient["streamChatCompletion"];
}>;

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
    invalidJsonError: "openrouter_response_invalid_json",
    notObjectError: "openrouter_response_not_object",
    providerName: "OpenRouter"
  });
}
