import type { ModelRunSseEvent, ModelRunUsage } from "@/lib/domain/modelRunEvents";
import type { ProviderRunRequest } from "@/lib/server/providers/types";

export type RunToolCapability = "mcp" | "web_search";

export type RunTool = {
  capability: RunToolCapability;
  description: string;
  inputSchema: Record<string, unknown>;
  name: string;
  strict?: boolean;
};

export type SerializedProviderTool = {
  provider: string;
  tool: Record<string, unknown>;
};

export type ModelToolCall = {
  arguments: Record<string, unknown>;
  id: string;
  name: string;
  raw?: unknown;
};

export type ToolExecutionContent =
  | {
      text: string;
      type: "text";
    }
  | {
      type: "json";
      value: unknown;
    };

export type ToolExecutionResult = {
  artifacts?: ModelRunSseEvent[];
  callId: string;
  content: ToolExecutionContent[];
  name: string;
  rawPreview?: Record<string, unknown>;
  status: "complete" | "error";
  usage?: ModelRunUsage;
};

export type ToolExecutionContext = {
  request: ProviderRunRequest;
  runId?: string;
};

export type ToolExecutor = {
  capability: RunToolCapability;
  execute(
    call: ModelToolCall,
    context: ToolExecutionContext,
    options?: { signal?: AbortSignal }
  ): Promise<ToolExecutionResult>;
  tool: RunTool;
};

export type ProviderToolSupportInput = {
  modelId: string;
  provider: string;
};

export type ProviderToolBridge = {
  appendToolResult(request: unknown, result: ToolExecutionResult): unknown;
  parseToolCalls(response: unknown): ModelToolCall[];
  provider: string;
  serializeAssistantToolCalls(input: Readonly<{
    calls: readonly ModelToolCall[];
    providerMessage?: unknown;
  }>): unknown[];
  serializeHostedTools?(request: ProviderRunRequest): readonly Record<string, unknown>[];
  serializeTool(tool: RunTool): SerializedProviderTool;
  supportsToolCalling(input: ProviderToolSupportInput): boolean;
};
