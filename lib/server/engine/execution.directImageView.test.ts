// @vitest-environment node
import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderHistoryItem } from "../providers/history";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { WorkspaceImageCaptures } from "../workspace/directImageView";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import { IMAGE_NOT_ATTACHED_NOTE, type TranscriptItem } from "./transcript";
import type { TranscriptRepository } from "./transcriptRepository";

/**
 * Direct view through the native engine: the run's next request carries the
 * preview as image content of its result, the transcript keeps only its
 * reference, and a later turn reads that reference without pixels.
 */

type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; text?: string }>;

function scriptedAdapter(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const adapter: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step = steps[Math.min(requests.length - 1, steps.length - 1)]!;
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter, requests };
}

function engine(earlier?: Readonly<{ answerId: string; items: readonly TranscriptItem[]; runId: string }>) {
  const recorded: TranscriptItem[] = [];
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
    append: vi.fn(async (_scope, _from, items: readonly TranscriptItem[]) => { recorded.push(...items); }),
    approvalContinuationTurns: vi.fn(async () => new Set<string>()),
    loadRuns: vi.fn(async () => new Map<string, TranscriptItem[]>(earlier ? [[earlier.runId, [...earlier.items]]] : [])),
    nativeRunsForAnswers: vi.fn(async () => new Map(earlier ? [[earlier.answerId, earlier.runId]] : [])),
    nativeRunsBeforeTurns: vi.fn(async () => []),
    nextSequence: vi.fn(async () => recorded.length),
    retiredRunEffects: vi.fn(async () => []),
    runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  const deps: NativeEngineDeps = {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never),
    runs: { applyUsageTotals: vi.fn(async () => undefined), complete: vi.fn(async () => true), publishAnswer: vi.fn(async () => true),
      recordDetachedCompaction: vi.fn(async () => true), saveStoppedText: vi.fn(async () => true), workDurationMs: vi.fn(async () => null),
      writeUsageRows: vi.fn(async () => undefined) },
    savedResults: { read: vi.fn(async () => null) }, toolCalls, transcripts
  };
  return { deps, recorded };
}

function workspace(): WorkspaceCoordinator {
  return {
    accepts: () => true,
    execute: vi.fn(),
    handoff: vi.fn(async () => ({ status: "ready" as const })),
    settle: vi.fn(async () => ({ quiesced: true, sessionSettled: true, stoppedVm: false })),
    tools: vi.fn(async () => [])
  } as unknown as WorkspaceCoordinator;
}

function captures(bytes: Buffer) {
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const owner = {
    create: vi.fn(async () => ({ files: [], id: "c".repeat(32), readiness: "captured" as const })),
    imageSource: vi.fn(async (reference: { captureId: string; relativePath: string }) => ({
      assertAccess: async () => undefined, byteSize: bytes.length, captureId: reference.captureId, checksum,
      open: async () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      relativePath: reference.relativePath
    })),
    release: vi.fn(async () => undefined)
  };
  return { load: async () => owner as unknown as WorkspaceImageCaptures, owner };
}

function prepared(messages: readonly Readonly<{ id: string; role: "assistant" | "user"; text: string }>[]): MaterializedPreparedRunData {
  const content = (text: string) => ({ blocks: [{ text, type: "text" }] });
  const request = {
    attachmentIds: [], attachments: [], chatId: "chat", content: content(messages.at(-1)!.text),
    context: { messages: messages.map((message) => ({ content: content(message.text), id: message.id, role: message.role })),
      mode: "branch_path" as const },
    modelCapabilities: { contextWindow: 400_000, nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true,
      vision: true },
    modelId: "gpt-6-astra", params: {}, prompt: { developer: null, system: "Be brief." }, provider: "openai",
    searchPlan: { mode: "all_selected" as const, options: [] }, toolMode: "auto" as const,
    workspace: { enabled: true, outputDirectory: "/workspace/output/run-1", syncToolTimeoutSeconds: 120, turnTimeoutSeconds: 900 },
    workspaceImageView: true as const
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, normalizedRequest: request,
    providerAdmissionPlan: { answer: { snapshot: { connection: { responseTimeoutMs: 60_000 }, connectionId: "connection-1",
      model: { adapterKind: "fake" }, providerFamily: "openai", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

const repository = () => ({
  appendAssistantText: vi.fn(async () => undefined), appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event),
  failRun: vi.fn(async () => true), getChatUpdateForRun: vi.fn(async () => null), getRunControlForUser: vi.fn(async () => ({ status: "streaming" })),
  loadModelPricing: vi.fn(async () => null), loadProviderModelCostBasis: vi.fn(async () => null), markRunAnswerStarted: vi.fn(async () => undefined)
}) as unknown as RunRepository;

async function done(response: Response): Promise<string> {
  return response.text();
}

const viewResult = (history: readonly ProviderHistoryItem[] | undefined) =>
  history?.find((item): item is Extract<ProviderHistoryItem, { type: "tool_result" }> => item.type === "tool_result" &&
    item.name === "view_workspace_image");

describe("direct view through the native engine", () => {
  it("shows the model its preview in the next request, keeps only the reference, and a later turn reads the reference", async () => {
    const png = await sharp({ create: { background: "#20305a", channels: 3, height: 600, width: 1600 } }).png().toBuffer();
    const owner = captures(png);
    const view = { arguments: { path: "/workspace/project/code.png" }, id: "call-view", name: "view_workspace_image" };
    const first = scriptedAdapter([{ calls: [view] }, { text: "The code is on the screenshot." }]);
    const turn1 = engine();
    const stream = await done(createNativeRunExecutionResponse({ adapter: first.adapter, created: { assistantMessageId: "answer-1",
      runId: "run-1", userMessageId: "question-1" }, engine: turn1.deps,
    prepared: prepared([{ id: "question-1", role: "user", text: "Read the code on the screenshot." }]), repository: repository(),
    services: { workspaceImageCaptures: owner.load }, userId: "user", workspace: workspace() }));
    expect(stream).toContain("\"status\":\"complete\"");

    expect(first.requests[0]!.tools?.map((tool) => tool.name)).toContain("view_workspace_image");
    expect(viewResult(first.requests[0]!.history)).toBeUndefined();
    const shown = viewResult(first.requests[1]!.history)!;
    expect(shown.output).toMatch(/^Preview of \/workspace\/project\/code\.png: 1024×384 pixels of the 1600×600 image\./u);
    expect(shown.images).toHaveLength(1);
    const pixels = Buffer.from(shown.images![0]!.data, "base64");
    expect(await sharp(pixels).metadata()).toMatchObject({ format: "png", height: 384, width: 1024 });
    expect(owner.owner.release).toHaveBeenCalledOnce();

    // The record holds the reference only: no pixels reach the transcript.
    const recorded = turn1.recorded.find((item) => item.kind === "tool_result" && item.name === "view_workspace_image");
    expect(recorded).toMatchObject({ image: { consumerKey: "row-0", descriptor: { height: 384, width: 1024 } }, kind: "tool_result",
      outcome: "complete" });
    expect(JSON.stringify(turn1.recorded)).not.toContain(shown.images![0]!.data.slice(0, 64));

    // The next turn rebuilds the conversation from the record: the result names its file, and its pixels stay with run-1.
    const second = scriptedAdapter([{ text: "Still the same code." }]);
    const turn2 = engine({ answerId: "answer-1", items: turn1.recorded, runId: "run-1" });
    await done(createNativeRunExecutionResponse({ adapter: second.adapter, created: { assistantMessageId: "answer-2", runId: "run-2",
      userMessageId: "question-2" }, engine: turn2.deps, prepared: prepared([
      { id: "question-1", role: "user", text: "Read the code on the screenshot." },
      { id: "answer-1", role: "assistant", text: "The code is on the screenshot." },
      { id: "question-2", role: "user", text: "And again?" }
    ]), repository: repository(), services: { workspaceImageCaptures: owner.load }, userId: "user", workspace: workspace() }));
    const later = viewResult(second.requests[0]!.history)!;
    expect(later.images).toBeUndefined();
    expect(later.output.endsWith(`\n\n${IMAGE_NOT_ATTACHED_NOTE}`)).toBe(true);
    // A fixed model's tool list is the same in both turns.
    expect(JSON.stringify(second.requests[0]!.tools)).toBe(JSON.stringify(first.requests[0]!.tools));
  });
});
