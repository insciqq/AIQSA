import type { ModelRunSseEvent, ModelRunUsage } from "../../domain/modelRunEvents";
import type { ContextTruncationSummary } from "../../domain/contextBudget";
import type { SearchRunParamControls } from "../../domain/runParams";
import type { ModelToolCall, RunTool } from "../tools/types";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";

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
  streaming?: boolean;
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
  modelCapabilities: ProviderModelCapabilities;
  mcp?: McpRunPlanSnapshot;
  modelId: string;
  params: Record<string, unknown>;
  prompt: {
    developer: string | null;
    presetId: string | null;
    system: string | null;
  };
  provider: string;
  searchPolicy?: ProviderSearchPolicy;
  searchStrategy: string | null;
};

export type ProviderSearchPolicy = {
  controls: SearchRunParamControls;
  defaultParams: Record<string, unknown>;
  modelId: string;
  provider: "openrouter";
  strategyId: "perplexity-tool-search";
};

export type ProviderConversationMessage = {
  content: {
    blocks: unknown[];
  };
  id: string;
  role: "assistant" | "user";
};

export type ProviderRunRequest = NormalizedRunRequest & {
  attachments: ProviderAttachment[];
  forceNonStreaming?: boolean;
  parallelToolCalls?: boolean;
  previousProviderResponseId?: string;
  providerToolMessages?: unknown[];
  toolChoice?: "auto" | "none";
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

export type ProviderSearchRequest = ProviderRunRequest & {
  answerModelId: string;
  answerProvider: string;
  searchModelId: string;
  searchPolicy: ProviderSearchPolicy;
  strategyId: string;
};

export type ProviderSearchResult = {
  artifacts: ModelRunSseEvent[];
  finalProviderResponsePreview: Record<string, unknown>;
  finalText: string;
  providerResponseId?: string;
  requestPreview: Record<string, unknown>;
  usage: ModelRunUsage;
};

export type ProviderSearchOptions = {
  signal?: AbortSignal;
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
