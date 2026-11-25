/**
 * The engines the web search quality eval compares and the Codex LB model it
 * answers and judges with. Each client engine is the product's own Search
 * adapter (`lib/server/providers/*Search*.ts`) behind the product's Search
 * tool router, so the eval measures the requests, retries, parsing and the
 * tool result text users get; only the adapter's binding (source settings the
 * administrator would choose) is written here.
 *
 * Adding an engine: one `EngineDefinition` in `ENGINES` naming the
 * environment variables it reads and building its runtime from the product
 * adapter. Keys come from the environment only and are never printed.
 */
import { adminSearchExecutionDefaults, DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS } from "../../lib/contracts/adminSearch";
import type { SearchProtocol } from "../../lib/domain/search";
import { MODEL_CALL_UNATTENDED_RETRY, modelCallRetryDecision } from "../../lib/server/engine/modelCall";
import {
  createDeepSeekSearchApiAdapter,
  createFetchDeepSeekSearchApiClient,
  DEEPSEEK_SEARCH_API_MODEL_ID
} from "../../lib/server/providers/deepSeekSearchApi";
import { openAIResponseStatus } from "../../lib/server/providers/openaiResponsesResponse";
import { createOpenAIResponsesSearchAdapter } from "../../lib/server/providers/openaiResponsesSearch";
import { createFetchOpenAIResponsesClient, type OpenAIResponsesClient } from "../../lib/server/providers/openaiResponsesTransport";
import { providerRetryDelayMs, sleepWithSignal } from "../../lib/server/providers/providerRetry";
import { createProviderSafeFetch } from "../../lib/server/providers/providerSafeFetch";
import { providerResponseFailure } from "../../lib/server/providers/responseFailure";
import type { ProviderRuntimeBinding } from "../../lib/server/providers/runtimeFactory";
import { markProviderStreamDrop } from "../../lib/server/providers/streamDrop";
import type {
  NormalizedSearchPlanOption,
  ProviderAdapter,
  ProviderModelCapabilities,
  ProviderSearchAdapter
} from "../../lib/server/providers/types";
import { createSearchPlanToolRouter } from "../../lib/server/search/toolExecutor";
import type { PreparedEngine, ResponsesModel } from "./web-search-quality-support";

/** Everything an engine may need; `env` holds the keys. */
export type EngineSetup = Readonly<{
  /** Codex LB root without /v1, or null (dry run). */
  codexLbRoot: string | null;
  /** The technical model of OpenAI web search as a client engine. */
  clientSearchModel: string;
  env: Readonly<Record<string, string | undefined>>;
  /** Each engine call's deadline, as an administrator sets a source's timeout. */
  timeoutMs: number;
}>;

export type EngineDefinition = Readonly<{
  description: string;
  /** Environment variables the engine needs; a run refuses to start without them. */
  env: readonly string[];
  id: string;
  /** Needs `--root` or CODEX_LB_ROOT besides its key. */
  needsCodexLbRoot?: true;
  prepare(setup: EngineSetup): PreparedEngine;
}>;

/** The answer engine's response timeout, which bounds a source's own timeout (`searchExecutionConfiguration`). */
const RESPONSE_TIMEOUT_MS = 300_000;

function unusedAnswerAdapter(): ProviderAdapter {
  return {
    buildRequestPreview: () => ({}),
    // Never called: an eval engine binding carries only its Search adapter.
    async *stream() {
      throw new Error("eval_answer_adapter_unused");
    }
  };
}

/** A client engine: one source in an `all_selected` plan, as a chat with this one source selected sends it. */
export function clientEngine(input: Readonly<{
  adapter: ProviderSearchAdapter;
  config: Readonly<Record<string, unknown>>;
  displayName: string;
  modelId: string;
  protocol: SearchProtocol;
  provider: string;
}>): PreparedEngine {
  const option: NormalizedSearchPlanOption = {
    adapterKind: "provider_model_client",
    config: input.config,
    credentialMode: "provider_model",
    displayName: input.displayName,
    executionModes: ["all_selected"],
    modelId: input.modelId,
    optionId: `eval-${input.protocol}`,
    protocol: input.protocol,
    provider: input.provider,
    providerModelId: input.modelId,
    revisionId: "eval",
    searchStrategyRowId: "eval"
  };
  const runtime: ProviderRuntimeBinding = { adapter: unusedAnswerAdapter(), responseTimeoutMs: RESPONSE_TIMEOUT_MS, searchAdapter: input.adapter };
  const router = createSearchPlanToolRouter({ plan: { mode: "all_selected", options: [option] }, runtimes: { [option.optionId]: runtime } });
  if (!router) throw new Error("eval_engine_router_missing");
  return { kind: "client", router };
}

function safeFetch(apiRoot: string, timeoutMs: number): typeof fetch {
  return createProviderSafeFetch({
    configuration: { allowPrivateNetwork: false, apiRoot, authenticationMode: "bearer", responseTimeoutMs: timeoutMs }
  });
}

function required(env: EngineSetup["env"], name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`eval_env_missing:${name}`);
  return value;
}

/** A Codex LB Responses client configured as the product configures a Codex LB connection (`compatibleResponsesComponents`). */
export function codexLbClient(input: Readonly<{ apiKey: string; root: string; timeoutMs: number }>): OpenAIResponsesClient {
  const baseUrl = `${input.root}/v1`;
  return createFetchOpenAIResponsesClient({
    acceptStreamedCreate: true,
    apiKey: input.apiKey,
    baseUrl,
    defaultTimeoutMs: input.timeoutMs,
    fetchFn: safeFetch(baseUrl, input.timeoutMs),
    initialRequestRetry: { maxAttempts: 3 },
    requestIsolation: true,
    streamIdle: "keepalive"
  });
}

/** The technical model's capabilities as Admin › Search binds them; `lowest_supported` then asks for low effort. */
const CLIENT_SEARCH_MODEL_CAPABILITIES: ProviderModelCapabilities = {
  nativePdfInput: false, nativeSearch: true, pdf: false, reasoning: true, reasoningEfforts: ["low", "medium", "high", "xhigh"],
  streaming: true, toolCalling: true, vision: false
};

/**
 * Engines by id. OpenRouter's engines (`perplexity`, `parallel`, `exa`) and Gemini Google Search join with the slices that add
 * their adapters; see `PENDING_ENGINES`.
 */
export const ENGINES: Readonly<Record<string, EngineDefinition>> = {
  none: {
    description: "no search: the answer model alone (baseline)",
    env: [],
    id: "none",
    prepare: () => ({ kind: "none" })
  },
  "openai-in-answer": {
    description: "OpenAI web search inside the answer request (hosted `web_search` on the Codex LB answer model)",
    env: [],
    id: "openai-in-answer",
    prepare: () => ({ kind: "in_answer" })
  },
  "openai-client": {
    description: "OpenAI web search as a client engine: the technical model on Codex LB returns findings and sources " +
      "(`lib/server/providers/openaiResponsesSearch.ts`)",
    env: ["CODEX_LB_API_KEY"],
    id: "openai-client",
    needsCodexLbRoot: true,
    prepare(setup) {
      if (!setup.codexLbRoot) throw new Error("eval_argument_invalid:--root");
      const client = codexLbClient({ apiKey: required(setup.env, "CODEX_LB_API_KEY"), root: setup.codexLbRoot, timeoutMs: RESPONSE_TIMEOUT_MS });
      return clientEngine({
        adapter: createOpenAIResponsesSearchAdapter({ client, provider: "openai_compatible" }),
        config: { maxOutputTokens: 32_000, modelCapabilities: CLIENT_SEARCH_MODEL_CAPABILITIES,
          queryMaxCharacters: adminSearchExecutionDefaults.queryMaxCharacters, reasoningPolicy: "lowest_supported", timeoutMs: setup.timeoutMs },
        displayName: "OpenAI web search",
        modelId: setup.clientSearchModel,
        protocol: "openai_responses_web_search",
        provider: "openai_compatible"
      });
    }
  },
  deepseek: {
    description: "DeepSeek Search API (`lib/server/providers/deepSeekSearchApi.ts`), billed at its published per-request price",
    env: ["DEEPSEEK_API_KEY"],
    id: "deepseek",
    prepare(setup) {
      const apiRoot = setup.env.DEEPSEEK_API_ROOT?.trim() || "https://api.deepseek.com";
      const client = createFetchDeepSeekSearchApiClient({ apiKey: required(setup.env, "DEEPSEEK_API_KEY"), apiRoot,
        defaultTimeoutMs: setup.timeoutMs, fetchFn: safeFetch(apiRoot, setup.timeoutMs) });
      return clientEngine({
        adapter: createDeepSeekSearchApiAdapter({ client, rateLimitKey: "eval" }),
        config: { maxOutputTokens: 16, queryMaxCharacters: DEEPSEEK_SEARCH_API_QUERY_MAX_CHARACTERS, reasoningPolicy: "provider_default",
          timeoutMs: setup.timeoutMs },
        displayName: "DeepSeek Search",
        modelId: DEEPSEEK_SEARCH_API_MODEL_ID,
        protocol: "deepseek_search_api",
        provider: "deepseek"
      });
    }
  }
  // Registry slot for the OpenRouter engine slice (`lib/server/providers/openRouterWebSearch.ts`, task
  // `search-openrouter-engine`): add `perplexity`, `parallel` and `exa` here, each `env: ["OPENROUTER_API_KEY"]`, built with
  // `clientEngine({ adapter: <the product adapter for that engine>, ... })`, and remove them from `PENDING_ENGINES`. Do not
  // write the OpenRouter request here: the eval drives the product adapter. Gemini (`gemini`, GEMINI_API_KEY) joins the same way
  // once its engine slice lands; it is left out of the comparison for now (operator 2026-11-26).
};

/** Engines named in the plan whose product adapter has not landed yet. */
export const PENDING_ENGINES: Readonly<Record<string, string>> = {
  exa: "the OpenRouter engine slice (lib/server/providers/openRouterWebSearch.ts)",
  gemini: "the Gemini engine slice",
  parallel: "the OpenRouter engine slice (lib/server/providers/openRouterWebSearch.ts)",
  perplexity: "the OpenRouter engine slice (lib/server/providers/openRouterWebSearch.ts)"
};

/** The default comparison (task Decisions): in-answer OpenAI, the OpenAI client engine, OpenRouter Perplexity and DeepSeek. */
export const DEFAULT_ENGINES = ["openai-in-answer", "openai-client", "perplexity", "deepseek"] as const;

/**
 * Codex LB answer and judge requests: the product's Codex LB transport, and a failed request sent again exactly when a native
 * run's model call would be (`modelCallRetryDecision`, the unattended policy's attempts and backoff). A failed response is a
 * dropped stream as for the product's compatible adapter; any other unfinished response is a failure.
 */
export function codexLbResponsesModel(client: OpenAIResponsesClient, timeoutMs: number): ResponsesModel {
  return async (body, signal) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const response = await client.create({ ...body }, { signal, timeoutMs });
        const status = openAIResponseStatus(response);
        if (status === "completed") return response;
        const failure = providerResponseFailure(`compatible_response_${status}`, response);
        throw status === "failed" ? markProviderStreamDrop(failure, "response_failed") : failure;
      } catch (error) {
        const decision = modelCallRetryDecision(error, signal);
        const delayMs = decision && attempt < MODEL_CALL_UNATTENDED_RETRY.maxAttempts
          ? providerRetryDelayMs(attempt, decision.retryAfterMs, Math.random, MODEL_CALL_UNATTENDED_RETRY.backoff)
          : null;
        if (delayMs === null) throw error;
        await sleepWithSignal(delayMs, signal);
      }
    }
  };
}
