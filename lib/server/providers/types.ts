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
import type { MemoryActionAnswerResult } from "./memoryActionAnswer";
import type { KnowledgeAnswerPolicySnapshot } from "../knowledge/answerPolicy";
import type { KnowledgeAnswerRoute } from "../knowledge/fullContext";
import type { ArtifactResourcePolicy } from "../artifacts/resourcePolicy";

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
  /** Installation-declared limits for this exact model configuration. They
   * constrain document requests and never grant image-input authority. */
  imageInputLimits?: Readonly<{ imageBytes: number; imageCount: number; imagePixels: number; payloadBytes: number }>;
  backgroundStreaming?: boolean;
  contextWindow?: number;
  defaultMaxOutputTokens?: number;
  /** Declared per-model output ceiling, independent of its default answer length. */
  maxOutputTokens?: number;
  /** Legacy/internal declared flag in mutable model configuration. Catalog and
   * run admission replace it with the evidence-backed effective capability. */
  nativePdfInput: boolean;
  nativeBackground?: boolean;
  nativeImageGeneration?: boolean;
  imageGeneration?: boolean;
  imageEditing?: boolean;
  nativeSearch: boolean;
  /** Native Codex /alpha/search, independent of AIQSA Search. */
  codexStandaloneWebSearch?: boolean;
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
  /** Verified support for one forced strict function call on the exact active
   * model/credential/route tuple. Configuration normalization never trusts
   * this field directly. */
  forcedToolCalling?: boolean;
  /** Verified strict tool result using automatic wire choice. This proves the
   * validated application contract, never provider-forced selection. */
  validatedAutoToolCalling?: boolean;
  /** Model/route restriction only. False disables native forced selection;
   * true or absence never grants a verified tool capability. */
  nativeForcedToolChoice?: boolean;
  /** Opts a compatible Chat endpoint into `stream_options.include_usage`. */
  streamUsage?: boolean;
  toolCalling?: boolean;
  vision: boolean;
};

export type ProviderAttachment = {
  /** Frozen preprocessing wins over the answer model's native PDF capability. */
  pdfDelivery?: "prepared_text";
  byteSize: number;
  base64Data?: string;
  dataUrl?: string;
  extractedText: string | null;
  fileName: string;
  id: string;
  /** Server-only source of vision pixels, set only when images from earlier
   * messages accompany the request; builders caption each image with it. */
  imageProvenance?: ProviderImageProvenance;
  kind: string;
  metadata: unknown;
  mimeType: string;
  status: string;
};

export type ProviderImageProvenance = Readonly<
  | { role: "current_message" }
  | { role: "earlier_message"; messageId: string }
>;

/** Server-owned immutable Workspace snapshot. It is persisted with the run
 * and is never accepted from the browser as configuration. */
export type NormalizedRunWorkspace = Readonly<{
  enabled: true;
  /** Guest code of this Internet-On, non-Agent run can reach the run gateway,
   * with these code-call budgets. Absent: no code token (older runs too). */
  codeMcp?: import("../workspace/codeMcp").NormalizedWorkspaceCodeMcp;
  /** Absent historical turns retain their inline-guide Agent contract. */
  guidanceVersion?: 1;
  imageRef: string;
  inboxIndexPath: string;
  internetEnabled: boolean;
  mcpVersion: string;
  maxToolCalls: number;
  maxToolRounds: number;
  messageManifestPath: string;
  outputDirectory: string;
  projectDirectory: string;
  runtimeVersion: string;
  sessionId: string;
  syncToolTimeoutSeconds: number;
  toolCatalogHash: string;
  turnTimeoutSeconds: number;
}>;

export type NormalizedRunRequest = {
  /** Preparation keeps room for accepted clarifications. Released at execution. */
  followupContextReserveTokens?: number;
  agent?: import("../agents/config").NormalizedRunAgent;
  /** Server-admitted provider-neutral browser artifact tool. */
  artifactTool?: true;
  /** Exact private tool guidance from the resource policy at admission. */
  artifactToolDescription?: string;
  artifactResourcePolicy?: ArtifactResourcePolicy;
  artifactIntent?: "create";
  artifactFocus?: import("../../contracts/artifacts").ArtifactReference;
  /** Exact owner-authorized edit bases whose source was supplied at admission. */
  artifactReferences?: readonly import("../../contracts/artifacts").ArtifactReference[];
  /** Explicit user target, revalidated against the chat binding at admission. */
  artifactEdit?: import("../../contracts/artifacts").ArtifactEdit;
  /** Owner selection fenced at initial acceptance; texts live in prompt. */
  instructionPreset?: Readonly<{ presetId: string | null; revision: number | null; selectionVersion: number }>;
  /** Verified image-input and supported Responses tool-output route, frozen at admission. */
  workspaceImageView?: true;
  workspaceCheckpoints?: true;
  /** Exact server-owned tool text; absent accepted rows use the legacy text. */
  workspaceCheckpointToolDescription?: string;
  /** System Vision frozen at admission: Workspace files with a Workspace;
   * otherwise conversation images for an answer model without vision, admitted
   * only as an available plan (the chat form of `analyze_image`). */
  visionAnalysis?: import("../providerRuntime/visionAnalysis").AcceptedVisionAnalysisPlan;
  imagePlan?: import("../providerRuntime/imageModelRole").AcceptedImageGenerationPlan;
  imageReferences?: import("../../contracts/imageGeneration").ConversationImageReference[];
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
  /** Accepted branch/prefix identity captured before provider-facing trimming. */
  contextCompactionPolicy?: import("../../contracts/contextCompaction").ConversationContextPolicy;
  /** Exact immutable request for the single internal focused Knowledge
   * retrieval operation. It is never exposed as an answer-model tool. */
  knowledgeFocusedRequest?: KnowledgeFocusedRequestV1;
  /** Exact answer route and policy frozen at acceptance. Full-context evidence
   * itself lives in the private context plus durable evidence rows. */
  knowledgeAnswering?: Readonly<{
    answerPolicy: KnowledgeAnswerPolicySnapshot;
    approximateDocumentTokens: number;
    evidenceCount?: number;
    exactDocumentTokens?: number;
    route: KnowledgeAnswerRoute;
    version: 1;
  }>;
  /** Durable evidence-packing policy for Knowledge tool-loop recovery. Older
   * accepted requests omit it and retain chronological V1 packing. V5 also
   * reserves reviewed correction premises when packing a retrieval revision. */
  knowledgeEvidencePackingVersion?: 2 | 3 | 4 | 5;
  /** Frozen instructions, Scope anchor projection and publication rendering.
   * Omission preserves the previously accepted Knowledge workflow. */
  knowledgeAnswerWorkflowVersion?: 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
  /** Closed review-field validation feedback. Omission preserves historical
   * prompts and rejection receipts; only evidence-review workflow 11 uses it. */
  knowledgeReviewRepairFeedbackVersion?: 1;
  /** Admitted utility allowance for workflow 11; omission retains historical requests. */
  knowledgeGenerationBudget?: import("./modelOutputAllowance").ModelGenerationBudget;
  /** Workflow 11 only: the frozen route describing the current message's images
   * once before the grounded answer. Absent without images (and on older runs). */
  knowledgeImageObservation?: import("../knowledge/imageObservation").KnowledgeImageObservationPlan;
  /** Accepted model output allowance used by internal compaction utilities. */
  generationBudget?: import("./modelOutputAllowance").ModelGenerationBudget;
  /** Frozen retrieval instructions, independent of answer-stage versions.
   * V2 pins the tool descriptor; V3 also pins the retrieval system contract.
   * Omission retains historical descriptor and workflow-based selection. */
  knowledgeSearchInstructionVersion?: 2 | 3;
  /** Bounded original-question projection for retrieval. Omission retains
   * historical rejection of overlong anchors during execution/recovery. */
  knowledgeQueryAnchorVersion?: 2;
  knowledgePlan: KnowledgePlan;
  /** @deprecated Decode-only marker for pre-v1 persisted snapshots. New
   * admission rejects it and execution/recovery terminalize it. */
  memoryActionTools?: Readonly<{ version: "model-driven-v2" }>;
  /** @deprecated Decode-only marker for pre-v1 persisted snapshots. New
   * admission rejects it and execution/recovery terminalize it. */
  memoryHistoryTool?: Readonly<{
    maxCalls: 2;
    pageSize: 20;
  }>;
  /** Frozen local standing-context admission; independent of tool support. */
  memoryStandingVersion?: 1;
  memorySearch?: import("../memory/search/contract").MemorySearchSnapshot;
  modelCapabilities: ProviderModelCapabilities;
  mcpDiscovery?: McpDiscoveryState;
  mcp?: McpRunPlanSnapshot;
  /** Server-owned admission marker of a run that a monitoring task's
   * scheduled occurrence admitted: it offers `report_monitoring_result`,
   * reserved outside the tool budgets. Never set from a request field. */
  monitoringVerdictTool?: true;
  modelId: string;
  personalContext?: Readonly<{
    approxTokens: number;
    itemCount: number;
    memoryGeneration: number;
    memoryRevision: number;
    mode: "prefetched" | "standing-v1";
    text: string;
  }>;
  skills?: import("../skills/runManifest").FrozenSkillManifest | import("../skills/runManifest").LegacySkillManifest;
  params: Record<string, unknown>;
  /** Provider-neutral reasoning control frozen at admission. Historical
   * accepted requests may omit it and are decoded from their exact params. */
  reasoningEffort?: string | null;
  prompt: {
    personalInstructions?: string;
    responseReminder?: string;
    /**
     * Exact baseline evidence: the resolved zone and its source are recorded
     * because the rendered text in `system` must never depend on a live clock
     * or mutable template after acceptance. Ordinary runs use the standard-chat
     * baseline; Assistant runs use its date and time sentence without the
     * persona and render their own instructions with the same zone. Historical
     * Assistant runs omit this.
     */
    baseline?: {
      source: "standard_chat" | "assistant_chat";
      timeZone: string;
      timeZoneSource: "client" | "utc_fallback";
    };
    developer: string | null;
    /** Server-minted fixed contract serialized after every other instruction
     * and untrusted personal-context block for one-shot Knowledge answers. */
    /** @deprecated Decode-only compatibility for accepted V1 requests. */
    knowledgeAnswerContract?: 1;
    knowledgeAnswerDraftContract?: 7 | 8;
    knowledgeGroundedSelectorContract?: 5 | 6;
    /** Server-owned, content-free result of the bounded Memory control/action
     * stage. Provider adapters render the corresponding fixed answer contract. */
    memoryActionAnswerResult?: MemoryActionAnswerResult;
    system: string | null;
  };
  provider: string;
  /** Server-owned admission marker of an ordinary personal run (never a
   * scheduled, temporary, Project, Assistant, Agent or Knowledge run) whose
   * tool-calling model may create one scheduled task through
   * `create_scheduled_task`: the settings such a task takes, frozen from this
   * admission. `modelId` and `provider` are the catalog identity the run
   * admitted (not the execution identity above); `toolsEnabled` is the run's
   * MCP selection other than Off; `memoryEnabled` is whether this run was
   * admitted to read Memory, absent on runs accepted before tasks had Memory
   * (their task reads none). Never set from a request field. */
  scheduledTaskTool?: Readonly<{
    modelId: string;
    provider: string;
    searchEnabled: boolean;
    toolsEnabled: boolean;
    workspaceEnabled: boolean;
    memoryEnabled?: boolean;
  }>;
  /** Server-owned admission marker beside `scheduledTaskTool` when the owner
   * had a saved task: the run may manage the owner's tasks through
   * `manage_scheduled_task`. `chatTask` is the task whose own chat this is, as
   * admission read it; the tool text names it as data. `userUrlDigests` is the
   * run's frozen `FetchUrlPlan.userUrlDigests`: besides the task's stored
   * snapshot, the only links a prompt the tool rewrites may keep for its
   * scheduled runs. Runs accepted without it authorize none. */
  scheduledTaskManagementTool?: Readonly<{
    chatTask: Readonly<{ taskId: string; title: string }> | null;
    userUrlDigests?: readonly string[];
  }>;
  searchPlan: NormalizedSearchPlan;
  /** Server-owned admission marker of an interactive personal chat with
   * Workspace on, or a personal Agent run: the model may save one Workspace
   * folder per answer as a personal Skill through `save_skill` (never a
   * scheduled, temporary, Project, Assistant or Knowledge run). Never set
   * from a request field. */
  skillSaveTool?: true;
  /** Server-owned admission marker of a tool-calling run that may read pages
   * through `fetch_url`, with its frozen link authority: digests of links in
   * user-authored text on the visible branch, or a scheduled run's task
   * snapshot. Same-run Search URLs are read at each call. Never set from a
   * request field. */
  fetchUrl?: import("../tools/fetchUrlPlan").FetchUrlPlan;
  /** Server-owned admission marker; old runs retain their accepted tool set. */
  sessionStatusTool?: true;
  /** Server-owned admission marker for `read_tool_call`, independent of the
   * observation policy. Old runs retain their accepted tool set. */
  toolCallReader?: true;
  /** Cross-turn tool history frozen at admission: references and digests of
   * the branch's eligible calls only, never their arguments or results. Its
   * presence also makes this run's own calls eligible for later turns. */
  toolHistory?: import("../../contracts/toolHistory").ToolHistorySnapshot;
  /** Frozen store/reader policy. Absent on accepted historical runs; 0 is a
   * newly accepted explicit Off mode and 1 is the observation-store contract. */
  toolObservationVersion?: 0 | 1;
  /** Exact installation tool-loop limits frozen when the run is accepted.
   * Older accepted requests may also carry the retired router allowances
   * `mcpAutoDiscoveryTimeoutSeconds` and `mcpAutoDiscoveryMaxOutputTokens`. */
  toolBudgets?: Readonly<{
    maxMcpToolsPerDiscovery?: number;
    maxToolCalls: number;
    maxToolRounds: number;
  }>;
  /** Durable operator/client suppression for all client-side run tools. */
  toolMode: "auto" | "none";
  workspace?: NormalizedRunWorkspace;
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
      provider: "deepseek";
      reasoningPolicy: ProviderSearchReasoningPolicy;
      strategyId: "deepseek-responses-web-search";
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
  /** Keeps clarifications with their original question during history trimming. */
  contextTurnId?: string;
  content: {
    blocks: unknown[];
  };
  id: string;
  /** Provider-only third class: a server-rendered tool-call record of its
   * turn. Neither a pin (`purpose`) nor a chat message; never persisted in
   * the frozen context, previews, Memory control or utility prompts. */
  historyClass?: "tool_history";
  /** Internal provider-facing context that is never rendered as a chat message. */
  purpose?: "knowledge_evidence" | "skill_context" | "skill_catalog";
  role: "assistant" | "user";
  /** Ephemeral render data of a `tool_history` message. */
  toolHistory?: import("../../contracts/toolHistory").ToolHistoryMessageData;
};

export type ProviderRunRequest = NormalizedRunRequest & {
  attachments: ProviderAttachment[];
  /** Ephemeral server-owned planner measurement. It is never accepted from a
   * browser or written into the normalized run snapshot. */
  contextCompaction?: import("../../contracts/contextCompaction").ContextPlanMeasurement;
  /** Ephemeral model-derived notes produced under the accepted hybrid policy;
   * never accepted from a browser or copied into the normalized request. */
  contextCompactionSummary?: import("../../contracts/contextCompaction").ContextSummary;
  /** Bounded attempt receipts carried into the next durable tool-loop fence. */
  contextCompactionSummaryAttempts?: readonly import("../../contracts/contextCompaction").ContextSummaryAttempt[];
  /** Ephemeral server-owned record of the run's one context-rejection
   * rebuild. Its tightened budget applies to the rebuilt round and every later
   * round; tool-loop checkpoints carry it so recovery re-derives the budget. */
  contextCompactionRebuild?: import("../../contracts/contextCompaction").ContextRejectionRebuild;
  forceNonStreaming?: boolean;
  /** Ephemeral server-owned name of the advertised tool a `required` round
   * exists to obtain. Only `toolChoice: "required"` rounds carry it. Adapters
   * that can restrict a forced choice narrow it to this tool; others keep
   * their ordinary `required` mapping over every advertised tool. Incompatible
   * models use wire `auto` while the application retains this obligation. */
  forcedToolName?: string;
  parallelToolCalls?: boolean;
  previousProviderResponseId?: string;
  providerToolMessages?: unknown[];
  /** Ephemeral server-minted index of this run's persisted calls by provider
   * call id: the only authority for a summary's `call_ref` provenance of a
   * transcript result. Never accepted from a browser or persisted. */
  toolCallRefs?: readonly import("../../contracts/toolHistory").ToolCallRefEntry[];
  toolChoice?: "auto" | "none" | "required";
  tools?: RunTool[];
};

export type ProviderRunResult = {
  /** USD the provider reported for this call (OpenRouter `usage.cost`, with
   * the upstream charge of a BYOK call); absent when it reported none usable. */
  costUsd?: number;
  finalText: string;
  finalProviderResponsePreview: Record<string, unknown>;
  providerToolCallMessage?: unknown;
  providerResponseId?: string;
  toolCalls?: ModelToolCall[];
  /** Adapter detected forbidden native tool markup; finalText/events contain only its safe prefix. */
  synthesisToolCallForbidden?: true;
  usage: ModelRunUsage;
};

/** Private parser observation; never a run/SSE event or persistence payload. */
export type ProviderToolArgumentEvent = Readonly<{ callIndex: number; callId?: string; name?: string; delta?: string; snapshot?: string | Record<string, unknown> }>;
export type ProviderToolArgumentObserver = (event: ProviderToolArgumentEvent) => Promise<void>;

export type ProviderRunOptions = {
  onToolArguments?: ProviderToolArgumentObserver;
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
  generationBudget?: import("./modelOutputAllowance").ModelGenerationBudget;
  correlationId: string;
  query: ValidatedSearchQuery;
  searchControls?: Readonly<Record<string, unknown>>;
  searchPolicy: ProviderSearchPolicy;
  strategyId: string;
}>;

export type ProviderSearchResult = {
  artifacts: ModelRunSseEvent[];
  /** USD the provider reported for this search (OpenRouter `usage.cost`, with
   * the upstream charge of a BYOK call); absent or null when it reported none. */
  costUsd?: number | null;
  finalProviderResponsePreview: Record<string, unknown>;
  findings: string;
  providerResponseId?: string;
  requestPreview: Record<string, unknown>;
  /** Omitted by legacy/test adapters means normal source attribution. Only
   * the dedicated DeepSeek adapter may emit `provider_unavailable`. */
  sourceAttribution?: "available" | "provider_unavailable";
  sources: readonly SearchSource[];
  usage: ModelRunUsage;
};

export type ProviderSearchExecutionFailure = Readonly<{
  artifacts: ModelRunSseEvent[];
  code: string;
  /** USD the provider reported for the failed search; absent or null when none. */
  costUsd?: number | null;
  providerStatus?: string;
  reason?: string;
  usage: ModelRunUsage;
}>;

/** A typed, raw-payload-free provider failure that still carries already
 * observed usage and normalized Search operation evidence. */
export class ProviderSearchExecutionError extends Error {
  readonly artifacts: ModelRunSseEvent[];
  readonly code: string;
  readonly costUsd: number | null;
  readonly providerStatus?: string;
  readonly reason?: string;
  readonly usage: ModelRunUsage;

  constructor(failure: ProviderSearchExecutionFailure) {
    super(failure.code);
    this.name = "ProviderSearchExecutionError";
    this.artifacts = failure.artifacts;
    this.code = failure.code;
    this.costUsd = failure.costUsd ?? null;
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
  dispatch?: import("./searchDispatch").ProviderSearchDispatch;
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
