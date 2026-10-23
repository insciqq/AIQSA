// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ThreadWorkspaceActivityEntry } from "@/lib/contracts/workspace";
import { mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { summarizeMessageRunWorkspaceActivity } from "../chats/prismaRepository";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { appendRunOutputEvents } from "../runs/prismaRepositoryToolLoop";
import { isRunOutputArtifactEvent, type RunOutputArtifactEvent } from "../runs/runOutputEvents";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { WORKSPACE_ACTIVITY_SNAPSHOT } from "../runs/workspaceActivityPersistence";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { projectWorkspaceActivity, workspaceActivityEvent, workspaceLifecycleActivity } from "../workspace/activityProjection";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { TranscriptRepository } from "./transcriptRepository";

const RUN = "run-1";
const SHELL = namespacedWorkspaceToolName("sandbox_shell");

/** `ModelRunEvent` rows in memory, matched as PostgreSQL compares JSON: by path and by content, whatever the key order. */
function eventStore() {
  const rows: { eventType: string; modelRunId: string; payload: unknown; sequence: number }[] = [];
  const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object" ? `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}` : JSON.stringify(value);
  const at = (value: unknown, path: readonly string[]) => path.reduce<unknown>((node, key) =>
    node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined, value);
  type Where = { eventType?: string; modelRunId?: string; payload?: { equals: unknown; path?: string[] } };
  const matches = (row: typeof rows[number], where: Where) => (where.eventType === undefined || row.eventType === where.eventType) &&
    (where.modelRunId === undefined || row.modelRunId === where.modelRunId) &&
    (!where.payload || canonical(where.payload.path ? at(row.payload, where.payload.path) : row.payload) === canonical(where.payload.equals));
  const modelRunEvent = {
    aggregate: async () => ({ _max: { sequence: Math.max(-1, ...rows.map((row) => row.sequence)) } }),
    createMany: async ({ data }: { data: typeof rows }) => { rows.push(...data); },
    findFirst: async ({ where }: { where: Where }) => rows.find((row) => matches(row, where)) ?? null,
    findMany: async ({ where }: { where: Where }) => rows.filter((row) => matches(row, where)),
    findUnique: async ({ where }: { where: { modelRunId_sequence: { modelRunId: string; sequence: number } } }) =>
      rows.find((row) => row.modelRunId === where.modelRunId_sequence.modelRunId && row.sequence === where.modelRunId_sequence.sequence) ?? null,
    upsert: async ({ create, update, where }: { create: typeof rows[number]; update: { payload: unknown };
      where: { modelRunId_sequence: { modelRunId: string; sequence: number } } }) => {
      const existing = rows.find((row) => row.modelRunId === where.modelRunId_sequence.modelRunId && row.sequence === where.modelRunId_sequence.sequence);
      if (existing) existing.payload = update.payload;
      else rows.push(create);
    }
  };
  const tx = { modelRunEvent } as unknown as Prisma.TransactionClient;
  return {
    /** The run's own save, as `appendRunOutputEvent` makes it under the run's lock. */
    append: async (runId: string, event: RunOutputArtifactEvent) => {
      if (!isRunOutputArtifactEvent(event)) throw new Error("run_output_event_invalid");
      const [published] = await appendRunOutputEvents(tx, runId, [event]);
      return published!;
    },
    /** The events a thread's reload reads (`lib/server/chats/prismaRepository.ts`). */
    reloadEvents: () => rows.filter((row) => ["artifact", "grounding_display", WORKSPACE_ACTIVITY_SNAPSHOT].includes(row.eventType))
      .sort((left, right) => left.sequence - right.sequence),
    rows
  };
}

/** A Workspace whose first call starts the VM, reporting as the real coordinator does: lifecycle and the step live, the settled step with the result. */
function fakeWorkspace() {
  let started = false;
  const coordinator = {
    accepts: () => true,
    execute: vi.fn(async ({ call, modelRunToolCallId, onActivity, runId }: { call: ModelToolCall; modelRunToolCallId: string;
      onActivity?: (entry: ThreadWorkspaceActivityEntry) => Promise<void>; runId: string }): Promise<ToolExecutionResult> => {
      if (!started) {
        started = true;
        const startedAt = new Date();
        await onActivity?.(workspaceLifecycleActivity({ kind: "workspace_start", phase: "running", runId, startedAt }));
        await onActivity?.(workspaceLifecycleActivity({ durationMs: 850, kind: "workspace_start", phase: "succeeded", runId, startedAt }));
      }
      const step = { arguments: call.arguments, callId: modelRunToolCallId, originalName: "sandbox_shell" as const, runId, startedAt: new Date() };
      const running = projectWorkspaceActivity(step, "running");
      if (running) await onActivity?.(running);
      const result: ToolExecutionResult = { callId: call.id, content: [{ text: JSON.stringify({ data: { exitCode: 0, stdout: "chart saved" }, ok: true }),
        type: "text" }], name: call.name, rawPreview: { exitCode: 0 }, status: "complete" };
      const settled = projectWorkspaceActivity({ ...step, durationMs: 1_200, result }, "settled");
      return { ...result, artifacts: settled ? [workspaceActivityEvent(settled)] : [] };
    }),
    handoff: vi.fn(async ({ onActivity, runId }: { onActivity?: (entry: ThreadWorkspaceActivityEntry) => Promise<void>; runId: string }) => {
      await onActivity?.(workspaceLifecycleActivity({ kind: "execution_status", phase: "closed", runId }));
      return { status: "ready" as const };
    }),
    settle: vi.fn(async () => ({ quiesced: true, sessionSettled: true, stoppedVm: false })),
    tools: vi.fn(async () => [{ capability: "workspace" as const, description: "Run a command through a shell.", inputSchema: { type: "object" },
      name: SHELL }])
  };
  return coordinator as unknown as WorkspaceCoordinator;
}

function scriptedAdapter(steps: readonly Readonly<{ calls?: ProviderRunResult["toolCalls"]; text?: string }>[]): ProviderAdapter {
  let request = 0;
  return {
    buildRequestPreview: () => ({}),
    async *stream(): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      const step = steps[Math.min(request, steps.length - 1)]!;
      request += 1;
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
}

function engine(): NativeEngineDeps {
  const rows = new Map<string, ToolCallRow>();
  const toolCalls = {
    begin: vi.fn(async (input): Promise<ToolCallBeginResult> => {
      const row: ToolCallRow = { arguments: input.arguments as ToolCallRow["arguments"], id: `row-${rows.size}`, ordinal: input.ordinal,
        providerCallId: input.providerCallId, result: null, roundIndex: input.roundIndex, startedAt: "now", state: "running", toolName: input.toolName };
      rows.set(row.id, row);
      return { kind: "running", row };
    }),
    refuse: vi.fn(async () => null),
    settle: vi.fn(async () => true)
  } satisfies ToolCallStore;
  const transcripts = {
    append: vi.fn(async () => undefined), approvalContinuationTurns: vi.fn(async () => new Set<string>()), loadRuns: vi.fn(async () => new Map()),
    nativeRunsForAnswers: vi.fn(async () => new Map()), nextSequence: vi.fn(async () => 0), nativeRunsBeforeTurns: vi.fn(async () => []),
    retiredRunEffects: vi.fn(async () => []),
    runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  return {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never),
    runs: { workDurationMs: vi.fn(async () => null), applyUsageTotals: vi.fn(async () => undefined), complete: vi.fn(async () => true), publishAnswer: vi.fn(async () => true),
      recordDetachedCompaction: vi.fn(async () => true), saveStoppedText: vi.fn(async () => true),
      writeUsageRows: vi.fn(async () => undefined) },
    savedResults: { read: vi.fn(async () => null) }, toolCalls, transcripts
  };
}

function prepared(): MaterializedPreparedRunData {
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text: "Chart the margins", type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text: "Chart the margins", type: "text" }] }, id: "current-user-message", role: "user" as const }],
      mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system: "Be brief." }, provider: "fake",
    searchPlan: { mode: "all_selected" as const, options: [] }, toolMode: "auto" as const,
    workspace: { enabled: true, syncToolTimeoutSeconds: 120, turnTimeoutSeconds: 900 }
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, normalizedRequest: request,
    providerAdmissionPlan: { answer: { snapshot: { connection: { responseTimeoutMs: 60_000 }, connectionId: "connection-1",
      model: { adapterKind: "fake" }, providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

async function liveEvents(response: Response): Promise<ModelRunSseEvent[]> {
  return (await response.text()).split("\n\n").flatMap((block) => {
    const type = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    return type && data ? [{ data: JSON.parse(data), type } as ModelRunSseEvent] : [];
  });
}

const facts = (entries: readonly ThreadWorkspaceActivityEntry[]) => entries.map((entry) => [entry.kind, entry.id, entry.phase]);

describe("native Workspace activity on record", () => {
  it("keeps the VM start, the step and the retirement, so a reload shows what the live answer showed", async () => {
    const store = eventStore();
    const repository = {
      appendAssistantText: vi.fn(async () => undefined), appendRunOutputEvent: vi.fn(store.append), failRun: vi.fn(async () => true),
      getChatUpdateForRun: vi.fn(async () => null), getRunControlForUser: vi.fn(async () => ({ status: "streaming" })),
      loadModelPricing: vi.fn(async () => null), loadProviderModelCostBasis: vi.fn(async () => null), markRunAnswerStarted: vi.fn(async () => undefined)
    } as unknown as RunRepository;
    const adapter = scriptedAdapter([{ calls: [{ arguments: { command: "python3 chart.py" }, id: "call-1", name: SHELL }] },
      { text: "The chart is saved." }]);
    const events = await liveEvents(createNativeRunExecutionResponse({ adapter, created: { assistantMessageId: "answer-1", runId: RUN,
      userMessageId: "question-1" }, engine: engine(), prepared: prepared(), repository, services: {}, userId: "user",
    workspace: fakeWorkspace() }));
    expect(events.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });

    // Every Workspace entry the stream carried was saved first, with its durable sequence.
    const streamed = events.flatMap((event) => event.type === "artifact" && event.data.artifactType === "workspace_activity"
      ? [event.data.payload as ThreadWorkspaceActivityEntry] : []);
    expect(streamed.map((entry) => entry.kind)).toEqual(["workspace_start", "workspace_start", "command", "command", "execution_status"]);
    expect(streamed.every((entry) => Number.isSafeInteger(entry.sequence))).toBe(true);

    const reloaded = summarizeMessageRunWorkspaceActivity({ events: store.reloadEvents(), status: "complete" })!;
    expect(facts(reloaded.entries)).toEqual(facts(mergeWorkspaceActivity(null, { entries: streamed })!.entries));
    expect(reloaded.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ durationMs: 850, kind: "workspace_start", phase: "succeeded" }),
      expect.objectContaining({ command: expect.objectContaining({ preview: "python3 chart.py" }), kind: "command", phase: "succeeded" }),
      expect.objectContaining({ kind: "execution_status", phase: "closed" })
    ]));
    // The saved rows are a value-free receipt per update plus the one snapshot a reload reads; no legacy artifact rows.
    expect(store.rows.filter((row) => row.eventType === "workspace_activity_receipt")).toHaveLength(streamed.length);
    expect(store.rows.filter((row) => row.eventType === WORKSPACE_ACTIVITY_SNAPSHOT)).toHaveLength(1);
  });
});
