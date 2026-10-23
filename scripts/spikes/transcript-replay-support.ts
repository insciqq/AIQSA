import { contextTokenEstimator } from "../../lib/domain/tokenEstimate";
import { normalizeTokenUsage } from "../../lib/domain/usage";
import { contextAnchor, measureContext, type ContextAnchor, type ReasoningWeight } from "../../lib/server/engine/contextMeasure";
import {
  modelResponseItems,
  projectTranscript,
  sameTranscriptOrigin,
  type TranscriptItem,
  type TranscriptTarget,
  type TranscriptToolCallItem
} from "../../lib/server/engine/transcript";
import { createCompatibleResponsesAdapter } from "../../lib/server/providers/compatibleResponses";
import { createDeepSeekResponsesAdapter, createFetchDeepSeekResponsesClient } from "../../lib/server/providers/deepSeekResponses";
import { createFetchGeminiInteractionsClient, createGeminiInteractionsAdapter } from "../../lib/server/providers/geminiInteractions";
import type { ProviderHistoryItem } from "../../lib/server/providers/history";
import { createFetchOpenAIResponsesClient, createOpenAIResponsesAdapter } from "../../lib/server/providers/openaiResponses";
import { createFetchOpenRouterChatClient, createOpenRouterChatAdapter } from "../../lib/server/providers/openRouterChat";
import { providerErrorCode } from "../../lib/server/providers/providerErrorCode";
import { providerStreamDrop } from "../../lib/server/providers/streamDrop";
import type {
  ProviderAdapter,
  ProviderModelCapabilities,
  ProviderRunRequest,
  ProviderRunResult
} from "../../lib/server/providers/types";
import type { RunTool } from "../../lib/server/tools/types";

/**
 * Spike 1 of the native agent engine: one neutral transcript replayed to every
 * provider in scope through the existing adapters. Every request is built from
 * the stored transcript alone (a JSON round trip stands in for the database),
 * and every call prints one content-free JSON line: status, reported usage and
 * the anchored context estimate against it. Prompts, answers, tool payloads
 * and keys never leave the process.
 */

export const SPIKE_PROVIDERS = ["codex-lb", "openai", "openrouter", "gemini", "deepseek"] as const;
export type SpikeProvider = (typeof SPIKE_PROVIDERS)[number];
export const SPIKE_SCENARIOS = ["tools", "switch", "resume"] as const;
export type SpikeScenario = (typeof SPIKE_SCENARIOS)[number];

type ProviderProfile = Readonly<{
  apiKeyEnv: string;
  baseUrlEnv?: string;
  defaultBaseUrl?: string;
  defaultEffort: string;
  defaultModel: string;
  defaultPartner: SpikeProvider;
  /** `ProviderRunRequest.provider`: the catalog family. */
  family: string;
}>;

export const SPIKE_PROVIDER_PROFILES: Readonly<Record<SpikeProvider, ProviderProfile>> = {
  "codex-lb": { apiKeyEnv: "CODEX_LB_API_KEY", baseUrlEnv: "CODEX_LB_BASE_URL", defaultEffort: "low",
    defaultModel: "gpt-6-astra", defaultPartner: "openrouter", family: "openai_compatible" },
  openai: { apiKeyEnv: "OPENAI_API_KEY", defaultBaseUrl: "https://api.openai.com/v1", defaultEffort: "low",
    defaultModel: "gpt-6-luna", defaultPartner: "codex-lb", family: "openai" },
  openrouter: { apiKeyEnv: "OPENROUTER_API_KEY", defaultBaseUrl: "https://openrouter.ai/api/v1", defaultEffort: "low",
    defaultModel: "google/gemini-3.8-flash", defaultPartner: "codex-lb", family: "openrouter" },
  gemini: { apiKeyEnv: "GEMINI_API_KEY", defaultBaseUrl: "https://generativelanguage.googleapis.com/v1", defaultEffort: "low",
    defaultModel: "gemini-3.5-flash-lite", defaultPartner: "deepseek", family: "gemini" },
  deepseek: { apiKeyEnv: "DEEPSEEK_API_KEY", defaultBaseUrl: "https://api.deepseek.com", defaultEffort: "low",
    defaultModel: "deepseek-flash", defaultPartner: "gemini", family: "deepseek" }
};

export type SpikeTargetConfig = Readonly<{
  effort: string;
  model: string;
  provider: SpikeProvider;
  reasoningScope: "all" | "current_turn";
}>;

export type SpikeOptions = Readonly<{
  errorDetail: boolean;
  maxCallsPerProvider: number;
  maxOutputTokens: number;
  maxRounds: number;
  partners: Readonly<Record<SpikeProvider, SpikeProvider>>;
  providers: readonly SpikeProvider[];
  retries: number;
  scenarios: readonly SpikeScenario[];
  sequential: boolean;
  stream: boolean;
  targets: Readonly<Record<SpikeProvider, SpikeTargetConfig>>;
  timeoutMs: number;
}>;

export const SPIKE_USAGE = `Usage: npx tsx scripts/spikes/transcript-replay.ts [flags]

Environment (only the selected providers need theirs):
  CODEX_LB_API_KEY, CODEX_LB_BASE_URL (Codex root ending in /backend-api/codex)
  OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY

Flags:
  --providers a,b           ${SPIKE_PROVIDERS.join(",")} (default: all)
  --scenarios a,b           ${SPIKE_SCENARIOS.join(",")} (default: all)
  --model p=id              model per provider (repeatable)
  --effort p=level          reasoning effort per provider (default low)
  --partner p=q             model-switch partner of p (defaults: codex-lb=openrouter,
                            openai=codex-lb, openrouter=codex-lb, gemini=deepseek, deepseek=gemini)
  --reasoning-scope p=current_turn
                            replay only the current turn's reasoning to p
  --stream true|false       streamed requests (default true)
  --max-output-tokens N     per call (default 2048)
  --max-rounds N            model calls per turn (default 3)
  --max-calls N             calls a provider may serve in one run (default 24)
  --retries N               resends of a transient failure (default 2)
  --timeout-ms N            per call (default 180000)
  --sequential              one provider at a time (default: providers in parallel)
  --error-detail            add the provider's error message to rejected calls
                            (synthetic data only; off by default)`;

function invalidArgument(flag: string): never {
  throw new Error(`spike_argument_invalid:${flag}`);
}

function isSpikeProvider(value: string): value is SpikeProvider {
  return (SPIKE_PROVIDERS as readonly string[]).includes(value);
}

function integer(flag: string, value: string | undefined, minimum: number, maximum: number): number {
  const parsed = Number(value);
  if (!value || !/^\d+$/u.test(value) || parsed < minimum || parsed > maximum) invalidArgument(flag);
  return parsed;
}

function providerPair(flag: string, value: string | undefined): [SpikeProvider, string] {
  const separator = value?.indexOf("=") ?? -1;
  const provider = value?.slice(0, separator) ?? "";
  const setting = value?.slice(separator + 1) ?? "";
  if (separator <= 0 || !isSpikeProvider(provider) || !setting) invalidArgument(flag);
  return [provider, setting];
}

const VALUE_FLAGS = new Set([
  "--effort", "--max-calls", "--max-output-tokens", "--max-rounds", "--model", "--partner", "--providers",
  "--reasoning-scope", "--retries", "--scenarios", "--stream", "--timeout-ms"
]);

export function parseSpikeArguments(argv: readonly string[]): SpikeOptions | Readonly<{ help: true }> {
  let providers: SpikeProvider[] = [...SPIKE_PROVIDERS];
  let scenarios: SpikeScenario[] = [...SPIKE_SCENARIOS];
  const models = new Map<SpikeProvider, string>();
  const efforts = new Map<SpikeProvider, string>();
  const scopes = new Map<SpikeProvider, "all" | "current_turn">();
  const partners = new Map<SpikeProvider, SpikeProvider>();
  const settings = {
    errorDetail: false, maxCallsPerProvider: 24, maxOutputTokens: 2_048, maxRounds: 3, retries: 2,
    sequential: false, stream: true, timeoutMs: 180_000
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = VALUE_FLAGS.has(flag) ? argv[index + 1] : undefined;
    if (VALUE_FLAGS.has(flag)) index += 1;
    switch (flag) {
      case "--help":
      case "-h":
        return { help: true };
      case "--providers": {
        const list = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
        if (list.length === 0 || !list.every(isSpikeProvider)) invalidArgument(flag);
        providers = [...new Set(list as SpikeProvider[])];
        break;
      }
      case "--scenarios": {
        const list = (value ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
        if (list.length === 0 || !list.every((entry) => (SPIKE_SCENARIOS as readonly string[]).includes(entry))) invalidArgument(flag);
        scenarios = [...new Set(list as SpikeScenario[])];
        break;
      }
      case "--model": {
        const [provider, model] = providerPair(flag, value);
        if (!/^[\w./:-]{1,128}$/u.test(model)) invalidArgument(flag);
        models.set(provider, model);
        break;
      }
      case "--effort": {
        const [provider, effort] = providerPair(flag, value);
        if (!/^[a-z]{1,16}$/u.test(effort)) invalidArgument(flag);
        efforts.set(provider, effort);
        break;
      }
      case "--partner": {
        const [provider, partner] = providerPair(flag, value);
        if (!isSpikeProvider(partner) || partner === provider) invalidArgument(flag);
        partners.set(provider, partner);
        break;
      }
      case "--reasoning-scope": {
        const [provider, scope] = providerPair(flag, value);
        if (scope !== "all" && scope !== "current_turn") invalidArgument(flag);
        scopes.set(provider, scope);
        break;
      }
      case "--stream":
        if (value !== "true" && value !== "false") invalidArgument(flag);
        settings.stream = value === "true";
        break;
      case "--max-output-tokens":
        settings.maxOutputTokens = integer(flag, value, 64, 65_536);
        break;
      case "--max-rounds":
        settings.maxRounds = integer(flag, value, 1, 8);
        break;
      case "--max-calls":
        settings.maxCallsPerProvider = integer(flag, value, 1, 200);
        break;
      case "--retries":
        settings.retries = integer(flag, value, 0, 5);
        break;
      case "--timeout-ms":
        settings.timeoutMs = integer(flag, value, 30_000, 600_000);
        break;
      case "--sequential":
        settings.sequential = true;
        break;
      case "--error-detail":
        settings.errorDetail = true;
        break;
      default:
        invalidArgument(flag);
    }
  }
  const targets = Object.fromEntries(SPIKE_PROVIDERS.map((provider) => [provider, {
    effort: efforts.get(provider) ?? SPIKE_PROVIDER_PROFILES[provider].defaultEffort,
    model: models.get(provider) ?? SPIKE_PROVIDER_PROFILES[provider].defaultModel,
    provider,
    reasoningScope: scopes.get(provider) ?? "all"
  }])) as Record<SpikeProvider, SpikeTargetConfig>;
  const partnerMap = Object.fromEntries(SPIKE_PROVIDERS.map((provider) =>
    [provider, partners.get(provider) ?? SPIKE_PROVIDER_PROFILES[provider].defaultPartner])) as Record<SpikeProvider, SpikeProvider>;
  return { ...settings, partners: partnerMap, providers, scenarios, targets };
}

// ------------------------------------------------------------------ the task

export const SPIKE_SYSTEM_PROMPT = "You are running a synthetic replay test; every order is fictional. When the user " +
  "asks you to look up an order, call the lookup_order tool once for it. Keep every answer under 25 words.";

export const LOOKUP_ORDER_TOOL: RunTool = {
  capability: "mcp",
  description: "Look up one synthetic test order by its id and return its status as JSON.",
  inputSchema: {
    additionalProperties: false,
    properties: { order_id: { description: "Order id such as A-17.", type: "string" } },
    required: ["order_id"],
    type: "object"
  },
  name: "lookup_order"
};

const ORDERS: Readonly<Record<string, Readonly<{ carrier: string; eta_days: number; items: number; status: string }>>> = {
  "A-17": { carrier: "Northwind", eta_days: 3, items: 2, status: "shipped" },
  "B-42": { carrier: "Contoso", eta_days: 1, items: 1, status: "packing" },
  "C-5": { carrier: "Fabrikam", eta_days: 4, items: 3, status: "shipped" },
  "D-8": { carrier: "Northwind", eta_days: 2, items: 1, status: "in transit" },
  "E-3": { carrier: "Contoso", eta_days: 5, items: 4, status: "awaiting pickup" },
  "F-9": { carrier: "Fabrikam", eta_days: 6, items: 2, status: "delayed" }
};

export const INTERRUPTED_TOOL_RESULT = "The process stopped while this tool call ran; its outcome is unknown.";

function orderIdOf(argumentsText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    const value = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).order_id : undefined;
    return typeof value === "string" ? value.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

export function lookupOrder(argumentsText: string): Readonly<{ outcome: "complete" | "error"; output: string }> {
  const orderId = orderIdOf(argumentsText);
  const order = orderId ? ORDERS[orderId] : undefined;
  return order && orderId
    ? { outcome: "complete", output: JSON.stringify({ order_id: orderId, ...order, warehouse: "WH-3", note: "synthetic test record" }) }
    : { outcome: "error", output: JSON.stringify({ error: "order_not_found" }) };
}

function arrivesFirst(orderIds: readonly string[]): string {
  return [...orderIds].sort((left, right) => ORDERS[left]!.eta_days - ORDERS[right]!.eta_days)[0]!;
}

type TurnPlan = Readonly<{
  expectOrder?: string;
  expectRecall?: string;
  /** The process stops after the turn's first call was stored. */
  kill?: "execute" | "unknown";
  serve: "own" | "partner";
  text: string;
}>;

const SCENARIO_TURNS: Readonly<Record<SpikeScenario, readonly TurnPlan[]>> = {
  tools: [
    { expectOrder: "A-17", serve: "own", text: "Look up order A-17 and tell me its status in one short sentence." },
    { expectOrder: "B-42", serve: "own", text: "Now look up order B-42 the same way." },
    { expectRecall: arrivesFirst(["A-17", "B-42"]), serve: "own",
      text: "Without calling any tool, which of the two orders arrives first? Answer with its id in one short sentence." }
  ],
  switch: [
    { expectOrder: "C-5", serve: "own", text: "Look up order C-5 and tell me its status in one short sentence." },
    { expectOrder: "D-8", serve: "partner", text: "Now look up order D-8 the same way." },
    { expectRecall: arrivesFirst(["C-5", "D-8"]), serve: "own",
      text: "Without calling any tool, which of the two orders arrives first? Answer with its id in one short sentence." }
  ],
  resume: [
    { expectOrder: "E-3", kill: "execute", serve: "own", text: "Look up order E-3 and tell me its status in one short sentence." },
    { expectOrder: "F-9", kill: "unknown", serve: "own", text: "Now look up order F-9 the same way." }
  ]
};

// ----------------------------------------------------------------- transport

export type SpikeObservation = Readonly<{
  body: string | null;
  providerError?: Readonly<Record<string, number | string>>;
  status: number | null;
}>;

export type SpikeConnection = Readonly<{
  adapter: ProviderAdapter;
  /** The last physical request through this connection, once. */
  takeObservation(): SpikeObservation | null;
}>;

export type SpikeEnvironment = Readonly<{
  /** A new adapter instance for the provider, or null without credentials. */
  connect(provider: SpikeProvider): SpikeConnection | null;
  emit(line: Readonly<Record<string, unknown>>): void;
  now(): number;
  sleep(ms: number): Promise<void>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** Structural fields of a provider error body; the message only on request. */
async function providerErrorFields(response: Response, withMessage: boolean): Promise<Record<string, number | string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse((await response.text()).slice(0, 16_384));
  } catch {
    return { body: "unreadable" };
  }
  const root = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
  const error = isRecord(root) && isRecord(root.error) ? root.error : isRecord(root) ? root : {};
  const fields: Record<string, number | string> = {};
  for (const key of ["type", "code", "param", "status"]) {
    const value = error[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) fields[key] = value;
    else if (typeof value === "string" && /^[\w .:[\]/-]{1,120}$/u.test(value)) fields[key] = value;
  }
  if (withMessage && typeof error.message === "string") fields.message = error.message.replace(/\s+/gu, " ").slice(0, 400);
  return fields;
}

export function createObservedFetch(fetchFn: typeof fetch, errorDetail: boolean): Readonly<{
  fetch: typeof fetch;
  take(): SpikeObservation | null;
}> {
  let last: { body: string | null; providerError?: Record<string, number | string>; status: number | null } | null = null;
  const observed = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const current: { body: string | null; providerError?: Record<string, number | string>; status: number | null } = {
      body: typeof init?.body === "string" ? init.body : null,
      status: null
    };
    last = current;
    const response = await fetchFn(input, init);
    current.status = response.status;
    if (!response.ok) current.providerError = await providerErrorFields(response.clone(), errorDetail);
    return response;
  }) as typeof fetch;
  return {
    fetch: observed,
    take() {
      const value = last;
      last = null;
      return value;
    }
  };
}

function spikeAdapter(provider: SpikeProvider, input: Readonly<{
  apiKey: string;
  baseUrl: string;
  fetchFn: typeof fetch;
  timeoutMs: number;
}>): ProviderAdapter {
  const common = { defaultTimeoutMs: input.timeoutMs, fetchFn: input.fetchFn };
  switch (provider) {
    case "codex-lb":
      // As the runtime factory builds a Codex LB connection, without transport replays.
      return createCompatibleResponsesAdapter({ client: createFetchOpenAIResponsesClient({ ...common, acceptStreamedCreate: true,
        apiKey: input.apiKey, baseUrl: input.baseUrl, initialRequestRetry: { maxAttempts: 1 }, requestIsolation: true }) });
    case "openai":
      return createOpenAIResponsesAdapter({ client: createFetchOpenAIResponsesClient({ ...common, apiKey: input.apiKey, baseUrl: input.baseUrl }) });
    case "openrouter":
      return createOpenRouterChatAdapter({ client: createFetchOpenRouterChatClient({ ...common, apiKey: input.apiKey, baseUrl: input.baseUrl }) });
    case "gemini":
      return createGeminiInteractionsAdapter({ client: createFetchGeminiInteractionsClient({ ...common, apiKey: input.apiKey,
        apiRoot: input.baseUrl, initialRequestRetry: { maxAttempts: 1 } }) });
    case "deepseek":
      return createDeepSeekResponsesAdapter({ client: createFetchDeepSeekResponsesClient({ ...common, apiKey: input.apiKey, apiRoot: input.baseUrl }) });
  }
}

export function createSpikeConnection(provider: SpikeProvider, input: Readonly<{
  apiKey: string;
  baseUrl: string;
  errorDetail: boolean;
  fetchFn: typeof fetch;
  timeoutMs: number;
}>): SpikeConnection {
  const observed = createObservedFetch(input.fetchFn, input.errorDetail);
  return {
    adapter: spikeAdapter(provider, { apiKey: input.apiKey, baseUrl: input.baseUrl, fetchFn: observed.fetch, timeoutMs: input.timeoutMs }),
    takeObservation: observed.take
  };
}

// ------------------------------------------------------------------ requests

type TargetRuntime = Readonly<{
  config: SpikeTargetConfig;
  connection: SpikeConnection;
  estimate: (value: unknown) => number;
  fixedTokens: number;
  target: TranscriptTarget;
}>;

const BASE_CAPABILITIES: ProviderModelCapabilities = {
  nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, streaming: true, toolCalling: true, vision: false
};

function requestParams(config: SpikeTargetConfig, options: SpikeOptions): Record<string, unknown> {
  const maxOutputTokens = options.maxOutputTokens;
  switch (config.provider) {
    case "codex-lb":
      return { maxOutputTokens, reasoning: { effort: config.effort, summary: "auto" }, stream: options.stream };
    case "openai":
      // Stateless like Codex LB: reasoning comes back encrypted and replays by itself.
      return { background: false, maxOutputTokens, reasoning: { effort: config.effort, summary: "auto" }, store: false, stream: options.stream };
    case "openrouter":
      return { maxTokens: maxOutputTokens, reasoning: { effort: config.effort, enabled: true }, stream: options.stream };
    case "gemini":
    case "deepseek":
      return { maxOutputTokens, reasoning: { effort: config.effort }, stream: options.stream };
  }
}

function spikeRequest(runtime: TargetRuntime, history: readonly ProviderHistoryItem[], chatId: string, options: SpikeOptions): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId,
    // The conversation is `history`; `content` is unused on that path.
    content: { blocks: [] },
    history,
    modelCapabilities: runtime.config.provider === "gemini"
      ? { ...BASE_CAPABILITIES, reasoningEfforts: ["minimal", "low", "medium", "high"] }
      : BASE_CAPABILITIES,
    modelId: runtime.config.model,
    parallelToolCalls: false,
    params: requestParams(runtime.config, options),
    prompt: { developer: null, system: SPIKE_SYSTEM_PROMPT },
    provider: SPIKE_PROVIDER_PROFILES[runtime.config.provider].family,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "auto",
    toolMode: "auto",
    tools: [LOOKUP_ORDER_TOOL]
  };
}

async function complete(adapter: ProviderAdapter, request: ProviderRunRequest, timeoutMs: number): Promise<ProviderRunResult> {
  const stream = adapter.stream(request, { timeoutMs });
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

// ----------------------------------------------------------------- the store

type StoredChat = { anchors: Record<string, ContextAnchor>; items: TranscriptItem[]; nextId: number };

/** The only state a request is built from: the transcript as stored JSON. */
type ChatStore = Readonly<{ chatId: string; dump(): string; read(): StoredChat; write(chat: StoredChat): void }>;

function chatStore(chatId: string, stored = JSON.stringify({ anchors: {}, items: [], nextId: 1 } satisfies StoredChat)): ChatStore {
  let value = stored;
  return {
    chatId,
    dump: () => value,
    read: () => JSON.parse(value) as StoredChat,
    write(chat) {
      value = JSON.stringify(chat);
    }
  };
}

function anchorKey(target: TranscriptTarget): string {
  return `${target.provider}\u0000${target.model}`;
}

function pendingCalls(items: readonly TranscriptItem[]): TranscriptToolCallItem[] {
  const settled = new Set(items.flatMap((item) => item.kind === "tool_result" ? [item.callId] : []));
  return items.flatMap((item) => item.kind === "tool_call" && !settled.has(item.callId) ? [item] : []);
}

/** Settles every pending call: runs it, or records its outcome as unknown. */
function settlePending(chat: ChatStore, mode: "execute" | "unknown"): number {
  const stored = chat.read();
  const pending = pendingCalls(stored.items);
  for (const call of pending) {
    const result = mode === "execute" ? lookupOrder(call.arguments) : { outcome: "unknown" as const, output: INTERRUPTED_TOOL_RESULT };
    stored.items.push({ callId: call.callId, id: `i${stored.nextId++}`, kind: "tool_result", name: call.name, ...result });
  }
  chat.write(stored);
  return pending.length;
}

// ---------------------------------------------------------------- the runner

type CallRecord = Readonly<{
  anchored: boolean;
  errorPct: number | null;
  errorPctReported: number | null;
  ok: boolean;
  recall?: boolean;
  serving: SpikeProvider;
  status: number | null;
  toolArgs?: boolean;
}>;

type RunState = {
  calls: Map<SpikeProvider, number>;
  env: SpikeEnvironment;
  failedTurns: number;
  options: SpikeOptions;
  records: CallRecord[];
  skipped: number;
};

function percent(estimate: number | null, reported: number | null): number | null {
  if (estimate === null || reported === null || reported <= 0) return null;
  return Math.round((estimate - reported) / reported * 10_000) / 100;
}

function errorStatus(error: unknown): number | null {
  for (const key of ["status", "httpStatus"]) {
    const value = ownValue(error, key);
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  }
  return null;
}

function safeErrorCode(error: unknown): string {
  const code = ownValue(error, "code");
  if (typeof code === "string" && /^[A-Za-z][\w.:-]{0,127}$/u.test(code)) return code;
  const message = error instanceof Error ? error.message : "";
  if (/^[a-z][a-z0-9_:]{2,127}$/u.test(message)) return message;
  if (/ request failed with status \d{3}$/u.test(message)) return "http_status";
  return error instanceof Error && /^[A-Za-z]{1,64}$/u.test(error.name) ? `unclassified_${error.name}` : "unclassified";
}

function transientFailure(error: unknown, status: number | null): boolean {
  if (providerStreamDrop(error)) return true;
  if (status !== null && status >= 400) return status === 408 || status === 429 || status >= 500;
  const code = safeErrorCode(error);
  return code === "provider_request_outcome_unknown" || code === "provider_http_request_failed" ||
    code === "provider_http_tls_failed" || code === "provider_request_timed_out" || code === "unclassified_TypeError";
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Codex LB reports the input tokens of every replayed item
 * (`usage.attribution.items`, by item id); the Responses adapters keep the raw
 * usage in the response preview. Only counts and sums leave, never ids.
 */
function replayAttribution(preview: Record<string, unknown>, reasoningIds: ReadonlySet<string>): Record<string, number> | null {
  const usage = isRecord(preview.usage) ? preview.usage : null;
  const items = usage && isRecord(usage.attribution) ? usage.attribution.items : undefined;
  const entries: [string, number][] = [];
  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isRecord(item)) continue;
      const id = typeof item.id === "string" ? item.id : typeof item.item_id === "string" ? item.item_id : null;
      const tokens = tokenCount(item.input_tokens ?? item.tokens);
      if (id !== null && tokens !== null) entries.push([id, tokens]);
    }
  } else if (isRecord(items)) {
    for (const [id, value] of Object.entries(items)) {
      const tokens = tokenCount(isRecord(value) ? value.input_tokens ?? value.tokens : value);
      if (tokens !== null) entries.push([id, tokens]);
    }
  }
  if (entries.length === 0) return null;
  const reasoning = entries.filter(([id]) => reasoningIds.has(id));
  return {
    items: entries.length,
    reasoningItems: reasoning.length,
    reasoningTokens: reasoning.reduce((total, [, tokens]) => total + tokens, 0),
    totalTokens: entries.reduce((total, [, tokens]) => total + tokens, 0)
  };
}

function historyCounts(history: readonly ProviderHistoryItem[]): Record<ProviderHistoryItem["type"], number> {
  const counts = { assistant_text: 0, compaction: 0, reasoning: 0, tool_call: 0, tool_result: 0, user: 0 };
  for (const item of history) counts[item.type] += 1;
  return counts;
}

function runtimeFor(state: RunState, provider: SpikeProvider): TargetRuntime | null {
  const connection = state.env.connect(provider);
  if (!connection) return null;
  const config = state.options.targets[provider];
  const estimate = contextTokenEstimator({ modelId: config.model, provider: SPIKE_PROVIDER_PROFILES[provider].family });
  return {
    config,
    connection,
    estimate,
    fixedTokens: estimate(SPIKE_SYSTEM_PROMPT) + estimate(LOOKUP_ORDER_TOOL.description) +
      estimate(JSON.stringify(LOOKUP_ORDER_TOOL.inputSchema)) + 16,
    target: { model: config.model, provider, reasoningScope: config.reasoningScope }
  };
}

type TurnContext = Readonly<{
  chat: ChatStore;
  owner: SpikeProvider;
  plan: TurnPlan;
  runtime: TargetRuntime;
  scenario: SpikeScenario;
  turn: number;
  userItemId: string;
}>;

type RoundOutcome = Readonly<{ kind: "answer" | "budget" | "failed" | "tools" }>;

async function runRound(state: RunState, context: TurnContext, round: number): Promise<RoundOutcome> {
  const { env, options } = state;
  const { runtime } = context;
  const stored = context.chat.read();
  const history = projectTranscript(stored.items, runtime.target, { currentInputId: context.userItemId });
  const request = spikeRequest(runtime, history, context.chat.chatId, options);
  const measure = (reasoning: ReasoningWeight) => measureContext({
    anchor: stored.anchors[anchorKey(runtime.target)] ?? null,
    estimate: runtime.estimate,
    fixedTokens: runtime.fixedTokens,
    items: stored.items,
    reasoning,
    target: runtime.target
  });
  const opaque = measure("opaque");
  const reported = measure("reported");
  const anchorInputTokens = opaque.anchored ? stored.anchors[anchorKey(runtime.target)]?.inputTokens ?? null : null;
  const sentReasoningIds = new Set(history.flatMap((item) => {
    const id = item.type === "reasoning" ? item.native.fields.id : undefined;
    return typeof id === "string" ? [id] : [];
  }));
  const base = {
    foreignReasoningDropped: stored.items.filter((item) =>
      item.kind === "reasoning" && !sameTranscriptOrigin(item.origin, runtime.target)).length,
    model: runtime.config.model,
    owner: context.owner,
    provider: runtime.config.provider,
    scenario: context.scenario,
    sent: historyCounts(history),
    step: `t${context.turn}.r${round}`
  };

  for (let attempt = 1; ; attempt += 1) {
    const used = state.calls.get(runtime.config.provider) ?? 0;
    if (used >= options.maxCallsPerProvider) {
      env.emit({ kind: "budget_exhausted", ...base, attempt });
      return { kind: "budget" };
    }
    state.calls.set(runtime.config.provider, used + 1);
    const started = env.now();
    let result: ProviderRunResult;
    try {
      result = await complete(runtime.connection.adapter, request, options.timeoutMs);
    } catch (error) {
      const observation = runtime.connection.takeObservation();
      const observed = observation?.status ?? null;
      const status = observed !== null && observed >= 400 ? observed : errorStatus(error) ?? observed;
      const transient = transientFailure(error, status);
      env.emit({
        kind: "call", ...base, attempt, error: safeErrorCode(error), latencyMs: Math.round(env.now() - started), ok: false,
        ...(providerErrorCode(error) ? { providerErrorCode: providerErrorCode(error) } : {}),
        ...(observation?.providerError ? { providerError: observation.providerError } : {}),
        requestBytes: observation?.body ? Buffer.byteLength(observation.body) : null, status, transient
      });
      state.records.push({ anchored: opaque.anchored, errorPct: null, errorPctReported: null, ok: false,
        serving: runtime.config.provider, status });
      if (transient && attempt <= options.retries) {
        await env.sleep(attempt === 1 ? 2_000 : 5_000);
        continue;
      }
      return { kind: "failed" };
    }
    const observation = runtime.connection.takeObservation();
    const usage = normalizeTokenUsage(result.usage);
    const naive = observation?.body ? runtime.estimate(observation.body) : null;
    const produced = result.history ?? [];
    const calls = produced.flatMap((item) => item.type === "tool_call" ? [item] : []);
    const checks = {
      ...(context.plan.expectOrder && round === 1 && calls.length > 0
        ? { toolArgs: calls.some((call) => orderIdOf(call.arguments) === context.plan.expectOrder) } : {}),
      ...(context.plan.expectRecall && calls.length === 0 ? { recall: result.finalText.includes(context.plan.expectRecall) } : {})
    };
    const record: CallRecord = {
      anchored: opaque.anchored,
      errorPct: percent(opaque.tokens, usage.inputTokens),
      errorPctReported: percent(reported.tokens, usage.inputTokens),
      ok: true,
      serving: runtime.config.provider,
      status: observation?.status ?? null,
      ...checks
    };
    state.records.push(record);
    const attribution = replayAttribution(result.finalProviderResponsePreview, sentReasoningIds);
    env.emit({
      kind: "call",
      ...base,
      answerChars: result.finalText.length,
      attempt,
      ...(attribution ? { attribution } : {}),
      checks,
      estimate: {
        addedItems: opaque.addedItems,
        anchorInputTokens,
        anchored: opaque.anchored,
        errorPct: record.errorPct,
        naive,
        naiveErrorPct: percent(naive, usage.inputTokens),
        reasoningReported: reported.tokens,
        reasoningReportedErrorPct: record.errorPctReported,
        removedItems: opaque.removedItems,
        tokens: opaque.tokens
      },
      latencyMs: Math.round(env.now() - started),
      ok: true,
      produced: historyCounts(produced),
      requestBytes: observation?.body ? Buffer.byteLength(observation.body) : null,
      status: record.status,
      toolCalls: calls.length,
      usage: {
        cached: usage.cachedInputTokens,
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.reasoningTokens
      }
    });

    const itemCount = stored.items.length;
    let nextId = stored.nextId;
    stored.items.push(...modelResponseItems({
      estimate: runtime.estimate,
      history: produced,
      nextId: () => `i${nextId++}`,
      origin: runtime.target,
      usage
    }));
    stored.nextId = nextId;
    const anchor = contextAnchor({ itemCount, target: runtime.target, usage });
    if (anchor) stored.anchors[anchorKey(runtime.target)] = anchor;
    context.chat.write(stored);
    return { kind: calls.length > 0 ? "tools" : "answer" };
  }
}

async function runTurn(state: RunState, input: Readonly<{
  chat: ChatStore;
  owner: SpikeProvider;
  plan: TurnPlan;
  runtime: TargetRuntime;
  scenario: SpikeScenario;
  turn: number;
}>): Promise<Readonly<{ chat: ChatStore; ok: boolean }>> {
  let chat = input.chat;
  let runtime = input.runtime;
  const stored = chat.read();
  const userItemId = `i${stored.nextId++}`;
  stored.items.push({ id: userItemId, kind: "user", text: input.plan.text });
  chat.write(stored);
  for (let round = 1; round <= state.options.maxRounds; round += 1) {
    const outcome = await runRound(state, { ...input, chat, runtime, userItemId }, round);
    if (outcome.kind === "answer") return { chat, ok: true };
    if (outcome.kind !== "tools") return { chat, ok: false };
    if (input.plan.kill && round === 1) {
      // The process dies with the tool call stored: only the stored transcript
      // survives. A fresh store and a fresh adapter instance pick it up.
      chat = chatStore(chat.chatId, chat.dump());
      const fresh = runtimeFor(state, runtime.config.provider);
      if (!fresh) return { chat, ok: false };
      runtime = fresh;
      const settled = settlePending(chat, input.plan.kill);
      state.env.emit({
        kind: "restart", owner: input.owner, provider: runtime.config.provider,
        recovery: input.plan.kill === "execute" ? "result_recorded_after_restart" : "outcome_unknown",
        scenario: input.scenario, settledCalls: settled, step: `t${input.turn}.r${round}`
      });
      continue;
    }
    settlePending(chat, "execute");
  }
  state.env.emit({ kind: "round_limit", owner: input.owner, provider: runtime.config.provider, scenario: input.scenario,
    step: `t${input.turn}` });
  return { chat, ok: false };
}

async function runScenario(state: RunState, owner: SpikeProvider, scenario: SpikeScenario): Promise<void> {
  const partner = state.options.partners[owner];
  const needsPartner = SCENARIO_TURNS[scenario].some((plan) => plan.serve === "partner");
  const own = runtimeFor(state, owner);
  const other = needsPartner ? runtimeFor(state, partner) : null;
  if (!own || (needsPartner && !other)) {
    state.skipped += 1;
    state.env.emit({ kind: "skipped", provider: owner, reason: own ? "partner_missing_credentials" : "missing_credentials",
      scenario, ...(needsPartner ? { partner } : {}) });
    return;
  }
  let chat = chatStore(`spike-${owner}-${scenario}-${Date.now().toString(36)}`);
  for (const [index, plan] of SCENARIO_TURNS[scenario].entries()) {
    const turn = await runTurn(state, {
      chat, owner, plan, runtime: plan.serve === "partner" && other ? other : own, scenario, turn: index + 1
    });
    chat = turn.chat;
    if (!turn.ok) {
      state.failedTurns += 1;
      return;
    }
  }
}

export type SpikeSummary = Readonly<{ failedTurns: number; http4xx: number; pass: boolean; skipped: number }>;

function summaryLine(state: RunState, provider: SpikeProvider): Record<string, unknown> {
  const records = state.records.filter((record) => record.serving === provider);
  const anchored = records.filter((record) => record.ok && record.anchored);
  const mean = (values: readonly number[]) => values.length
    ? Math.round(values.reduce((left, right) => left + right, 0) / values.length * 100) / 100 : null;
  const stats = (values: readonly (number | null)[]) => {
    const signed = values.flatMap((value) => value === null ? [] : [value]);
    const known = signed.map(Math.abs);
    return {
      /** Mean signed error: positive overestimates. */
      bias: mean(signed),
      max: known.length ? Math.max(...known) : null,
      mean: mean(known),
      within5Pct: `${known.filter((value) => value <= 5).length}/${known.length}`
    };
  };
  const ratio = (key: "recall" | "toolArgs") => {
    const checked = records.filter((record) => record[key] !== undefined);
    return `${checked.filter((record) => record[key] === true).length}/${checked.length}`;
  };
  const opaque = stats(anchored.map((record) => record.errorPct));
  const reported = stats(anchored.map((record) => record.errorPctReported));
  return {
    kind: "summary",
    anchoredCalls: anchored.length,
    calls: records.length,
    estimateOpaque: opaque,
    estimateReasoningReported: reported,
    failed: records.filter((record) => !record.ok).length,
    http4xx: records.filter((record) => record.status !== null && record.status >= 400 && record.status < 500).length,
    http5xx: records.filter((record) => record.status !== null && record.status >= 500).length,
    model: state.options.targets[provider].model,
    provider,
    recall: ratio("recall"),
    toolArgs: ratio("toolArgs"),
    within5Pct: opaque.max !== null && opaque.max <= 5 ? "opaque" : reported.max !== null && reported.max <= 5 ? "reasoning_reported" : "no"
  };
}

export async function runTranscriptReplaySpike(options: SpikeOptions, env: SpikeEnvironment): Promise<SpikeSummary> {
  const state: RunState = { calls: new Map(), env, failedTurns: 0, options, records: [], skipped: 0 };
  const partnerCalls = (provider: SpikeProvider) => options.scenarios.includes("switch")
    ? options.providers.filter((owner) => options.partners[owner] === provider).length * 2 : 0;
  env.emit({
    kind: "plan",
    maxOutputTokens: options.maxOutputTokens,
    providers: options.providers.map((provider) => ({
      effort: options.targets[provider].effort,
      model: options.targets[provider].model,
      partner: options.partners[provider],
      plannedCalls: {
        asPartner: partnerCalls(provider),
        own: (options.scenarios.includes("tools") ? 5 : 0) + (options.scenarios.includes("switch") ? 3 : 0) +
          (options.scenarios.includes("resume") ? 4 : 0)
      },
      provider,
      reasoningScope: options.targets[provider].reasoningScope
    })),
    scenarios: options.scenarios,
    stream: options.stream
  });
  const runProvider = async (provider: SpikeProvider) => {
    for (const scenario of options.scenarios) await runScenario(state, provider, scenario);
  };
  if (options.sequential) {
    for (const provider of options.providers) await runProvider(provider);
  } else {
    await Promise.all(options.providers.map(runProvider));
  }
  const serving = SPIKE_PROVIDERS.filter((provider) => state.records.some((record) => record.serving === provider));
  for (const provider of serving) env.emit(summaryLine(state, provider));
  const http4xx = state.records.filter((record) => record.status !== null && record.status >= 400 && record.status < 500).length;
  const summary = { failedTurns: state.failedTurns, http4xx, pass: http4xx === 0 && state.failedTurns === 0 && state.skipped === 0,
    skipped: state.skipped };
  env.emit({ kind: "total", ...summary, calls: state.records.length });
  return summary;
}
