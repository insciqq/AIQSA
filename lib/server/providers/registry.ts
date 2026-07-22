import { createAnthropicMessagesAdapter, createFetchAnthropicMessagesClient } from "./anthropicMessages";
import { createFakeProviderAdapter } from "./fakeProvider";
import {
  createFetchOpenRouterChatClient,
  createOpenRouterChatAdapter,
  createOpenRouterPerplexitySearchAdapter
} from "./openRouterChat";
import { createFetchOpenAIResponsesClient, createOpenAIResponsesAdapter } from "./openaiResponses";
import { isTestModeAllowedEnv } from "../auth/csrf";
import type { ProviderAdapter, ProviderSearchAdapter } from "./types";

export type ProviderRegistryEnv = Record<string, string | undefined> & {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENROUTER_API_KEY?: string;
  OPENROUTER_APP_TITLE?: string;
  OPENROUTER_BASE_URL?: string;
  OPENROUTER_HTTP_REFERER?: string;
};

function present(value: string | undefined): value is string {
  return Boolean(value?.trim());
}

function fakeProviderEnabled(env: ProviderRegistryEnv): boolean {
  return isTestModeAllowedEnv(env);
}

export function createProviderAdaptersFromEnv(env: ProviderRegistryEnv = process.env): Record<string, ProviderAdapter> {
  const providers: Record<string, ProviderAdapter> = {};

  if (fakeProviderEnabled(env)) {
    providers.fake = createFakeProviderAdapter();
  }

  if (present(env.OPENAI_API_KEY)) {
    providers.openai = createOpenAIResponsesAdapter({
      client: createFetchOpenAIResponsesClient({
        apiKey: env.OPENAI_API_KEY,
        baseUrl: env.OPENAI_BASE_URL
      })
    });
  }

  if (present(env.ANTHROPIC_API_KEY)) {
    providers.anthropic = createAnthropicMessagesAdapter({
      client: createFetchAnthropicMessagesClient({
        apiKey: env.ANTHROPIC_API_KEY,
        baseUrl: env.ANTHROPIC_BASE_URL
      })
    });
  }

  if (present(env.OPENROUTER_API_KEY)) {
    providers.openrouter = createOpenRouterChatAdapter({
      client: createFetchOpenRouterChatClient({
        apiKey: env.OPENROUTER_API_KEY,
        appTitle: env.OPENROUTER_APP_TITLE ?? "AIQSA",
        baseUrl: env.OPENROUTER_BASE_URL,
        httpReferer: env.OPENROUTER_HTTP_REFERER
      })
    });
  }

  return providers;
}

export function createSearchProviderAdaptersFromEnv(
  env: ProviderRegistryEnv = process.env
): Record<string, ProviderSearchAdapter> {
  if (!present(env.OPENROUTER_API_KEY)) {
    return {};
  }

  return {
    openrouter: createOpenRouterPerplexitySearchAdapter({
      client: createFetchOpenRouterChatClient({
        apiKey: env.OPENROUTER_API_KEY,
        appTitle: env.OPENROUTER_APP_TITLE ?? "AIQSA",
        baseUrl: env.OPENROUTER_BASE_URL,
        httpReferer: env.OPENROUTER_HTTP_REFERER
      })
    })
  };
}
