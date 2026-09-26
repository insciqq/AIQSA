/**
 * Bounded real check of provider context-length rejections. Opt-in and paid
 * only if a provider unexpectedly accepts the request.
 *
 * For every protocol whose credential is present, sends ONE deliberately
 * oversized request (a repeated one-token filler far beyond the model's
 * window, a 16-token output limit) through the production transport and
 * adapter, and prints one JSON line with only the provider, the observed HTTP
 * status, the classified stable code and whether the stated prompt and
 * maximum token counts were extracted. A provider without its credential is
 * reported as skipped. Exits non-zero when any checked provider yields
 * anything other than `provider_context_length_exceeded`; a provider that
 * accepts the request (and bills its input) is reported as `accepted`.
 *
 * Environment (also read from a local .env):
 * - OPENAI_API_KEY, AIQSA_CONTEXT_REJECTION_OPENAI_MODEL (default gpt-5.5)
 * - ANTHROPIC_API_KEY, AIQSA_CONTEXT_REJECTION_ANTHROPIC_MODEL (default claude-sonnet-5)
 * - GEMINI_API_KEY, AIQSA_CONTEXT_REJECTION_GEMINI_MODEL (default gemini-3.6-flash)
 * - DEEPSEEK_API_KEY, AIQSA_CONTEXT_REJECTION_DEEPSEEK_MODEL (default deepseek-flash)
 * - CODEX_LB_API_KEY with the codex-lb route and model of ~/.codex/config.toml
 *   (the profile smoke:workspace-user-paid reads)
 * - AIQSA_CONTEXT_REJECTION_PROVIDERS: optional comma list restricting the
 *   check to openai, anthropic, gemini, deepseek and/or codex-lb
 * - AIQSA_CONTEXT_REJECTION_FILLER_TOKENS: filler tokens for every provider
 *   (defaults: 2,200,000 for Gemini, 1,200,000 otherwise)
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createAnthropicMessagesAdapter, createFetchAnthropicMessagesClient } from "../lib/server/providers/anthropicMessages";
import { createCompatibleResponsesAdapter } from "../lib/server/providers/compatibleResponses";
import { createDeepSeekResponsesAdapter, createFetchDeepSeekResponsesClient } from "../lib/server/providers/deepSeekResponses";
import { createFetchGeminiInteractionsClient, createGeminiInteractionsAdapter } from "../lib/server/providers/geminiInteractions";
import { createFetchOpenAIResponsesClient, createOpenAIResponsesAdapter } from "../lib/server/providers/openaiResponses";
import { observedFailure, providerContextRejection } from "../lib/server/providers/providerObservability";
import type { ProviderAdapter, ProviderRunRequest } from "../lib/server/providers/types";
import { codexLbRoute } from "./workspace-user-paid-support";

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  return (trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ? trimmed.slice(1, -1) : trimmed;
}

function loadLocalEnv(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) continue;
    const key = trimmed.slice(0, separatorIndex).trim();
    if (!process.env[key]) process.env[key] = unquoteEnvValue(trimmed.slice(separatorIndex + 1));
  }
}

loadLocalEnv();

const PROVIDERS = ["openai", "anthropic", "gemini", "deepseek", "codex-lb"] as const;
type ProviderName = (typeof PROVIDERS)[number];
const REQUEST_TIMEOUT_MS = 180_000;
const OUTPUT_TOKENS = 16;
// " the" is one token for every current tokenizer, so the count is predictable.
const FILLER = " the";

const env = (name: string) => process.env[name]?.trim() ?? "";
const selected = new Set(env("AIQSA_CONTEXT_REJECTION_PROVIDERS").split(",").map((value) => value.trim()).filter(Boolean));
const fillerOverride = Number(env("AIQSA_CONTEXT_REJECTION_FILLER_TOKENS"));

function fillerTokens(provider: ProviderName): number {
  if (Number.isSafeInteger(fillerOverride) && fillerOverride > 0) return fillerOverride;
  // Beyond every published window of the default models, including 2M-token Gemini variants.
  return provider === "gemini" ? 2_200_000 : 1_200_000;
}

function oversizedRequest(provider: string, modelId: string, params: Record<string, unknown>, tokens: number): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "context-rejection-smoke",
    content: { blocks: [{ text: `Reply with OK.${FILLER.repeat(tokens)}`, type: "text" }] },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, streaming: true, vision: false },
    modelId,
    params,
    prompt: { developer: null, system: "Bounded AIQSA context-length rejection check." },
    provider,
    searchPlan: { mode: "all_selected", options: [] },
    toolMode: "none"
  };
}

type Check = Readonly<{ adapter: ProviderAdapter; request: ProviderRunRequest }>;

/** Null when the protocol's credential or route is absent. */
function configured(provider: ProviderName, fetchFn: typeof fetch): Check | null {
  const tokens = fillerTokens(provider);
  switch (provider) {
    case "openai": {
      const apiKey = env("OPENAI_API_KEY");
      if (!apiKey) return null;
      return {
        adapter: createOpenAIResponsesAdapter({ client: createFetchOpenAIResponsesClient({ apiKey,
          defaultTimeoutMs: REQUEST_TIMEOUT_MS, fetchFn }) }),
        request: oversizedRequest("openai", env("AIQSA_CONTEXT_REJECTION_OPENAI_MODEL") || "gpt-5.5",
          { background: false, maxOutputTokens: OUTPUT_TOKENS, store: false, stream: true }, tokens)
      };
    }
    case "anthropic": {
      const apiKey = env("ANTHROPIC_API_KEY");
      if (!apiKey) return null;
      return {
        adapter: createAnthropicMessagesAdapter({ client: createFetchAnthropicMessagesClient({ apiKey,
          defaultTimeoutMs: REQUEST_TIMEOUT_MS, fetchFn }) }),
        request: oversizedRequest("anthropic", env("AIQSA_CONTEXT_REJECTION_ANTHROPIC_MODEL") || "claude-sonnet-5",
          { maxTokens: OUTPUT_TOKENS, stream: true, thinking: { enabled: false } }, tokens)
      };
    }
    case "gemini": {
      const apiKey = env("GEMINI_API_KEY");
      if (!apiKey) return null;
      return {
        adapter: createGeminiInteractionsAdapter({ client: createFetchGeminiInteractionsClient({ apiKey,
          defaultTimeoutMs: REQUEST_TIMEOUT_MS, fetchFn }) }),
        request: oversizedRequest("gemini", env("AIQSA_CONTEXT_REJECTION_GEMINI_MODEL") || "gemini-3.6-flash",
          { maxTokens: OUTPUT_TOKENS, reasoning: { effort: "minimal" }, stream: true }, tokens)
      };
    }
    case "deepseek": {
      const apiKey = env("DEEPSEEK_API_KEY");
      if (!apiKey) return null;
      return {
        adapter: createDeepSeekResponsesAdapter({ client: createFetchDeepSeekResponsesClient({ apiKey,
          defaultTimeoutMs: REQUEST_TIMEOUT_MS, fetchFn }) }),
        request: oversizedRequest("deepseek", env("AIQSA_CONTEXT_REJECTION_DEEPSEEK_MODEL") || "deepseek-flash",
          { maxOutputTokens: OUTPUT_TOKENS, reasoning: { effort: "none" }, stream: true }, tokens)
      };
    }
    case "codex-lb": {
      const apiKey = env("CODEX_LB_API_KEY");
      const config = join(homedir(), ".codex", "config.toml");
      if (!apiKey || !existsSync(config)) return null;
      const route = codexLbRoute(readFileSync(config, "utf8"));
      return {
        // The production compatible-Responses client and adapter, as runtimeFactory builds them.
        adapter: createCompatibleResponsesAdapter({ client: createFetchOpenAIResponsesClient({ acceptStreamedCreate: true,
          apiKey, baseUrl: route.apiRoot, defaultTimeoutMs: REQUEST_TIMEOUT_MS, fetchFn }) }),
        request: oversizedRequest("openai-compatible", route.model, { maxOutputTokens: OUTPUT_TOKENS, stream: true }, tokens)
      };
    }
  }
}

type Evidence = Readonly<{
  code: string;
  httpStatus: number | null;
  maximumTokensExtracted: boolean;
  promptTokensExtracted: boolean;
  provider: ProviderName;
}>;

async function check(provider: ProviderName): Promise<Evidence | null> {
  let httpStatus: number | null = null;
  const fetchFn: typeof fetch = async (...args) => {
    const response = await fetch(...args);
    httpStatus = response.status;
    return response;
  };
  const target = configured(provider, fetchFn);
  if (!target) return null;
  try {
    const stream = target.adapter.stream(target.request, { timeoutMs: REQUEST_TIMEOUT_MS });
    let next = await stream.next();
    while (!next.done) next = await stream.next();
    return { code: "accepted", httpStatus, maximumTokensExtracted: false, promptTokensExtracted: false, provider };
  } catch (error) {
    // Only the reviewed stable code and the presence of the two bounded
    // counts are reported; provider messages and bodies never are.
    const rejection = providerContextRejection(error);
    return {
      code: observedFailure(error).code,
      httpStatus,
      maximumTokensExtracted: rejection?.maximumTokens !== undefined,
      promptTokensExtracted: rejection?.promptTokens !== undefined,
      provider
    };
  }
}

async function main(): Promise<void> {
  let failed = false;
  for (const provider of PROVIDERS) {
    if (selected.size > 0 && !selected.has(provider)) continue;
    let evidence: Evidence | null;
    try {
      evidence = await check(provider);
    } catch {
      // A local configuration failure (for example an invalid codex-lb profile).
      evidence = { code: "smoke_configuration_invalid", httpStatus: null, maximumTokensExtracted: false,
        promptTokensExtracted: false, provider };
    }
    if (!evidence) {
      console.log(JSON.stringify({ provider, status: "skipped" }));
      continue;
    }
    console.log(JSON.stringify(evidence));
    if (evidence.code !== "provider_context_length_exceeded") failed = true;
  }
  process.exitCode = failed ? 1 : 0;
}

void main().catch(() => {
  console.log(JSON.stringify({ status: "failed", code: "smoke_unexpected_failure" }));
  process.exitCode = 1;
});
