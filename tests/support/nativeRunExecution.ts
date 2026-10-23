import { vi } from "vitest";
import type { ModelRunSseEvent } from "@/lib/domain/modelRunEvents";
import type { McpApprovalCard } from "@/lib/contracts/mcpApprovals";
import type { NativeEngineDeps } from "@/lib/server/engine/execution";
import type { NativeRunStore } from "@/lib/server/engine/runStore";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "@/lib/server/engine/toolCallStore";
import type { TranscriptItem } from "@/lib/server/engine/transcript";
import type { TranscriptRepository } from "@/lib/server/engine/transcriptRepository";
import type { McpRunPlanSnapshot } from "@/lib/server/mcp/runPlan";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "@/lib/server/providers/types";
import type { MaterializedPreparedRunData } from "@/lib/server/runs/runPreparation";

/**
 * One native run executed in memory (`createNativeRunExecutionResponse`): a
 * scripted answer model, the engine's stores, the run repository operations
 * the engine reads and writes, and an admitted request on the fake route.
 * Content is synthetic.
 */

/** One model response: its streamed text and the tool calls it makes. */
export type ScriptedStep = Readonly<{ calls?: ProviderRunResult["toolCalls"]; text?: string }>;

export const NATIVE_RUN_ORIGIN = Object.freeze({ model: "fake-qsa", provider: "connection-1" });

/** One Jira server: `get_issue` reads, `create_issue` writes. */
export const NATIVE_MCP_SNAPSHOT: McpRunPlanSnapshot = {
  servers: [{ fingerprint: "fp-1", revisionId: "rev-1", serverId: "jira", serverName: "Jira" }],
  tools: [
    { annotations: { readOnlyHint: true }, definitionHash: "a".repeat(64), description: "Read", inputSchema: { type: "object" },
      name: "get_issue", namespacedName: "mcp_jira_get_issue", originalName: "get_issue", serverId: "jira", serverName: "Jira" },
    { definitionHash: "b".repeat(64), description: "Create", inputSchema: { type: "object" },
      name: "create_issue", namespacedName: "mcp_jira_create_issue", originalName: "create_issue", serverId: "jira", serverName: "Jira" }
  ],
  version: 1
};

/** Answers from `steps` in order (the last repeats); `order` records "request" per request sent. */
export function scriptedNativeAdapter(steps: readonly ScriptedStep[], order: string[] = []) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      order.push("request");
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

/**
 * The engine's stores in memory. A call that needs its initiator's approval
 * is recorded gated with `approvalId` unless `allowed`.
 */
export function memoryNativeEngine(options: Readonly<{ allowed?: boolean; approvalId?: string }> = {}) {
  const transcriptRows: TranscriptItem[] = [];
  const rows = new Map<string, ToolCallRow>();
  let published: string | null = null;
  const transcripts = {
    append: vi.fn(async (_scope, _from, items: readonly TranscriptItem[]) => { transcriptRows.push(...items); }),
    approvalContinuationTurns: vi.fn(async () => new Set<string>()),
    loadRuns: vi.fn(async () => new Map<string, TranscriptItem[]>()),
    nativeRunsForAnswers: vi.fn(async () => new Map<string, string>()),
    nextSequence: vi.fn(async () => transcriptRows.length),
    runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => {
      const gated = Boolean(input.approval) && !options.allowed;
      const row: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal,
        providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: gated ? null : "now",
        state: gated ? "error" : "running", toolName: input.toolName };
      rows.set(row.id, row);
      return gated ? { approvalId: options.approvalId ?? "approval-1", kind: "gated", row } : { kind: "running", row };
    }),
    refuse: vi.fn(async (input): Promise<ToolCallRow | null> => ({ arguments: input.arguments as ToolCallRow["arguments"],
      id: `refused-${input.providerCallId}`, ordinal: input.ordinal, providerCallId: input.providerCallId, result: input.result,
      roundIndex: input.roundIndex, startedAt: null, state: "error", toolName: input.toolName })),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const runs = {
    applyUsageTotals: vi.fn(async () => undefined),
    complete: vi.fn(async () => true),
    publishAnswer: vi.fn(async (_scope, input: { text: string }) => { published = input.text; return true; }),
    recordDetachedCompaction: vi.fn(async () => true),
    saveStoppedText: vi.fn(async () => true),
    writeUsageRows: vi.fn(async () => undefined)
  } satisfies NativeRunStore;
  const engine: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null),
    mcpBindingRows: vi.fn(async () => [{ id: "binding-1", runtimeGenerationFingerprint: "fp-1", runtimeGenerationId: "gen-1" }]),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never), runs, savedResults: { read: vi.fn(async () => null) },
    toolCalls, transcripts
  };
  return { engine, published: () => published, runs, toolCalls, transcriptRows, transcripts };
}

/**
 * The run repository operations a native run uses; `cards` are the run's
 * approval cards. No earlier message is a turn the server wrote unless a test
 * says so (`loadSystemTurnMessageIds`, `loadScheduledPromptMessageIds`).
 */
export function nativeRunRepository(cards: readonly McpApprovalCard[] = []) {
  return {
    appendAssistantText: vi.fn(async () => undefined),
    appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event),
    failRun: vi.fn(async () => true),
    getChatUpdateForRun: vi.fn(async () => null),
    getRunControlForUser: vi.fn(async () => ({ status: "streaming" })),
    loadModelPricing: vi.fn(async () => null),
    loadProviderModelCostBasis: vi.fn(async () => null),
    loadRunMcpApprovalCards: vi.fn(async () => [...cards]),
    loadScheduledPromptMessageIds: vi.fn(async (): Promise<ReadonlySet<string>> => new Set<string>()),
    loadSystemTurnMessageIds: vi.fn(async (): Promise<ReadonlySet<string>> => new Set<string>()),
    markRunAnswerStarted: vi.fn(async () => undefined),
    recordMonitoringVerdict: vi.fn(async () => true)
  };
}

export const nativeSay = (id: string, role: "assistant" | "user", text: string) =>
  ({ content: { blocks: [{ text, type: "text" as const }] }, id, role });

/** An admitted run on the fake route (`fake-qsa` on `connection-1`), with the Jira binding accepted. */
export function nativePrepared(extra: Partial<ProviderRunRequest> = {}, data: Partial<MaterializedPreparedRunData> = {}): MaterializedPreparedRunData {
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text: "Check the release page", type: "text" }] },
    context: { messages: [nativeSay("current-user-message", "user", "Check the release page")], mode: "branch_path" as const },
    knowledgePlan: { baseIds: [], mode: "none" as const, sourceIds: [], version: 1 as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system: null }, provider: "fake",
    searchPlan: { mode: "all_selected" as const, options: [] }, toolMode: "auto" as const, ...extra
  } as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null,
    mcpBindings: [{ fingerprint: "fp-1", runtimeGenerationId: "gen-1", serverId: "jira" }],
    normalizedRequest: request, providerAdmissionPlan: { answer: { snapshot: { connection: { responseTimeoutMs: 60_000 },
      connectionId: "connection-1", model: { adapterKind: "fake", upstreamModelId: "fake-qsa" }, providerFamily: "fake",
      providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send", ...data
  };
}

/** A run stream's events, once it ended. */
export async function nativeSseEvents(response: Response): Promise<ModelRunSseEvent[]> {
  const text = await response.text();
  return text.split("\n\n").flatMap((block) => {
    const type = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    return type && data ? [{ data: JSON.parse(data), type } as ModelRunSseEvent] : [];
  });
}
