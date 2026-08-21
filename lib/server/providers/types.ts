import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import type { SearchRunParamControls } from "../../domain/runParams";
import type { ModelToolCall, RunTool } from "../tools/types";
import type { McpDiscoveryState, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { SearchSource } from "../search/evidence";
import type {
  SearchAdapterKind,
  SearchCredentialMode,
  SearchPlanMode,
  SearchProtocol,
  ValidatedSearchQuery
} from "../../domain/search";
import type { KnowledgePlan } from "../../contracts/knowledge";
import type { KnowledgeFocusedRequestV1 } from "../knowledge/focusedRequest";

export type NormalizedSearchPlanOption = Readonly<{
  adapterKind: SearchAdapterKind;
  config: Readonly<Record<string, unknown>>;
  credentialMode: SearchCredentialMode;
  displayName?: string;
  executionModes: readonly SearchPlanMode[];
  modelId: string | null;
  optionId: string;
  protocol: SearchProtocol;
  provider: string;
  providerModelId: string | null;
  revisionId: string;
  searchStrategyRowId: string;
}>;

export type NormalizedSearchPlan = Readonly<{
  mode: SearchPlanMode;
  options: readonly NormalizedSearchPlanOption[];
}>;

export type ProviderModelCapabilities = {
  backgroundStreaming?: boolean;
  contextWindow?: number;
  defaultMaxOutputTokens?: number;
  nativePdfInput: boolean;
  nativeBackground?: boolean;
  nativeImageGeneration?: boolean;
  nativeSearch: boolean;
  parallelToolCalls?: boolean;
  pdf: boolean;
  reasoning: boolean;
  defaultReasoningEffort?: string;
  defaultReasoningMode?: string;
  reasoningEfforts?: string[];
  reasoningModes?: string[];
  streaming?: boolean;
  /** Verified strict JSON Schema output for the exact active model/credential
   * tuple. Configuration normalization never trusts this field directly. */
  structuredOutput?: boolean;
  /** Opts a compatible Chat endpoint into `stream_options.include_usage`. */
  streamUsage?: boolean;
  toolCalling?: boolean;
  vision: boolean;
};

export type ProviderAttachment = {
  byteSize: number;
  base64Data?: string;
  dataUrl?: string;
  extractedText: string | null;
  fileName: string;
  id: string;
  kind: string;
  metadata: unknown;
  mimeType: string;
  status: string;
};

export type NormalizedRunRequest = {
  attachmentIds: string[];
  chatId: string;
  content: {
    blocks: unknown[];
  };
  context?: {
    messages: ProviderConversationMessage[];
    mode: "branch_path";
    summary?: {
      truncation?: ContextTruncationSummary;
    };
  };
  /** Exact immutable request for the single internal focused Knowledge
   * retrieval operation. It is never exposed as an answer-model tool. */
  knowledgeFocusedRequest?: KnowledgeFocusedRequestV1;
  knowledgePlan: KnowledgePlan;
  /** Model-driven tools. Mutation authority is minted at execution from the
   * exact accepted USER message and exact owned target/version. */
  memoryActionTools?: Readonly<{ version: "model-driven-v2" }>;
  /** Bounded first-party private-history tool. Its results remain untrusted
   * data and may coexist with admin-connected Search and tool capabilities. */
  memoryHistoryTool?: Readonly<{
    maxCalls: 2;
    pageSize: 20;
  }>;
  modelCapabilities: ProviderModelCapabilities;
  mcpDiscovery?: McpDiscoveryState;
  mcp?: McpRunPlanSnapshot;
  modelId: string;
  personalContext?: Readonly<{
    approxTokens: number;
    itemCount: number;
    memoryGeneration: number;
    memoryRevision: number;
    mode: "prefetched";
    text: string;
  }>;
  skills?: ReadonlyArray<Readonly<{
    name: string;
    revisionId: string;
    skillId: string;
  }>>;
  params: Record<string, unknown>;
  prompt: {
    /**
     * Exact standard-chat baseline evidence for ordinary runs: the resolved
     * zone and its source are recorded because the rendered text in `system`
     * must never depend on a live clock or mutable template after acceptance.
     * Assistant runs use their immutable revision instructions and omit this.
     */
    baseline?: {
      source: "standard_chat";
      timeZone: string;
      timeZoneSource: "client" | "utc_fallback";
    };
    developer: string | null;
    /** Server-minted fixed contract serialized after every other instruction
     * and untrusted personal-context block for one-shot Knowledge answers. */
    knowledgeAnswerContract?: 1;
    system: string | null;
  };
  provider: string;
  searchPlan: NormalizedSearchPlan;
  /** Exact installation tool-loop limits frozen when the run is accepted. */
  toolBudgets?: Readonly<{
    mcpAutoDiscoveryTimeoutSeconds?: number;
    maxMcpToolsPerDiscovery?: number;
    maxToolCalls: number;
    maxToolRounds: number;
  }>;
  /** Durable operator/client suppression for all client-side run tools. */
  toolMode: "auto" | "none";
};

export type ProviderSearchReasoningPolicy =
  | "lowest_supported"
  | "provider_default";

export type ProviderSearchPolicy =
  | Readonly<{
      controls: SearchRunParamControls;
      defaultParams: Record<string, unknown>;
      modelId: string;
      provider: "openrouter";
      strategyId: "perplexity-tool-search";
    }>
  | Readonly<{
      maxOutputTokens: number;
      modelCapabilities: ProviderModelCapabilities;
      modelId: string;
      provider: "openai" | "openai_compatible";
      reasoningPolicy: ProviderSearchReasoningPolicy;
      strategyId: "openai-responses-web-search";
    }>
  | Readonly<{
      maxOutputTokens: number;
      modelCapabilities: ProviderModelCapabilities;
      modelId: string;
      provider: "gemini";
      reasoningPolicy: ProviderSearchReasoningPolicy;
      strategyId: "gemini-google-search";
    }>
  | Readonly<{
      maxOutputTokens: number;
      modelCapabilities: ProviderModelCapabilities;
      modelId: string;
      provider: "anthropic";
      reasoningPolicy: ProviderSearchReasoningPolicy;
      strategyId: "anthropic-web-search";
    }>;

export type ProviderConversationMessage = {
  content: {
    blocks: unknown[];
  };
  id: string;
  /** Internal provider-facing context that is never rendered as a chat message. */
  purpose?: "knowledge_evidence" | "skill_context";
  role: "assistant" | "user";
};

export type ProviderRunRequest = NormalizedRunRequest & {
  attachments: ProviderAttachment[];
  forceNonStreaming?: boolean;
  parallelToolCalls?: boolean;
  previousProviderResponseId?: string;
  providerToolMessages?: unknown[];
  toolChoice?: "auto" | "none" | "required";
  tools?: RunTool[];
};

export type ProviderRunResult = {
  finalText: string;
  finalProviderResponsePreview: Record<string, unknown>;
  providerToolCallMessage?: unknown;
  providerResponseId?: string;
  toolCalls?: ModelToolCall[];
  usage: ModelRunUsage;
};

export type ProviderRunOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ProviderRunRefreshResult = {
  error?: {
    code: string;
    message: string;
  };
  events: ModelRunSseEvent[];
  providerResponseId?: string;
  result?: ProviderRunResult;
  status: string;
  terminal: boolean;
};

export type ProviderSearchRequest = Readonly<{
  correlationId: string;
  query: ValidatedSearchQuery;
  searchControls?: Readonly<Record<string, unknown>>;
  searchPolicy: ProviderSearchPolicy;
  strategyId: string;
}>;

export type ProviderSearchResult = {
  artifacts: ModelRunSseEvent[];
  finalProviderResponsePreview: Record<string, unknown>;
  findings: string;
  providerResponseId?: string;
  requestPreview: Record<string, unknown>;
  sources: readonly SearchSource[];
  usage: ModelRunUsage;
};

export type ProviderSearchExecutionFailure = Readonly<{
  artifacts: ModelRunSseEvent[];
  code: string;
  providerStatus?: string;
  reason?: string;
  usage: ModelRunUsage;
}>;

/** A typed, raw-payload-free provider failure that still carries already
 * observed usage and normalized Search operation evidence. */
export class ProviderSearchExecutionError extends Error {
  readonly artifacts: ModelRunSseEvent[];
  readonly code: string;
  readonly providerStatus?: string;
  readonly reason?: string;
  readonly usage: ModelRunUsage;

  constructor(failure: ProviderSearchExecutionFailure) {
    super(failure.code);
    this.name = "ProviderSearchExecutionError";
    this.artifacts = failure.artifacts;
    this.code = failure.code;
    this.providerStatus = failure.providerStatus;
    this.reason = failure.reason;
    this.usage = failure.usage;
  }
}

export function isProviderSearchExecutionError(
  value: unknown
): value is ProviderSearchExecutionError {
  return value instanceof ProviderSearchExecutionError;
}

export type ProviderSearchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ProviderAdapter = {
  buildRequestPreview(request: ProviderRunRequest): Record<string, unknown>;
  cancel?(providerResponseId: string): Promise<Record<string, unknown>>;
  refresh?(providerResponseId: string): Promise<ProviderRunRefreshResult>;
  retrieve?(providerResponseId: string): Promise<Record<string, unknown>>;
  stream(request: ProviderRunRequest, options?: ProviderRunOptions): AsyncGenerator<ModelRunSseEvent, ProviderRunResult>;
};

export type ProviderSearchAdapter = {
  buildRequestPreview(request: ProviderSearchRequest): Record<string, unknown>;
  search(request: ProviderSearchRequest, options?: ProviderSearchOptions): Promise<ProviderSearchResult>;
};
