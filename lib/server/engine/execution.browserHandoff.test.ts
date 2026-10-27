// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_TIME_LIMIT_FAILURE } from "../../contracts/runs";
import type { BrowserLiveStateEvent } from "@/lib/contracts/browserLive";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { BROWSER_HANDOFF_TOOL_NAME } from "../tools/browserHandoff";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { browserLiveRelay, type BrowserLiveView } from "../workspace/browserLive";
import { fakeLiveGuest, recordingWriter, until } from "../workspace/browserLive.testFixtures";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { TranscriptRepository } from "./transcriptRepository";

const EXEC = namespacedWorkspaceToolName("sandbox_exec");
const owner = { authSessionId: "session-1", userId: "user" };
let runs = 0;

function workspace(guest = fakeLiveGuest()) {
  const order: string[] = [];
  const coordinator = {
    accepts: () => true,
    browserLive: vi.fn(async ({ request }: { request: Parameters<typeof guest.channel>[0] }) => guest.channel(request)),
    browserSaveBack: vi.fn(async () => true),
    execute: vi.fn(async ({ call }: { call: ModelToolCall }): Promise<ToolExecutionResult> => ({ callId: call.id,
      content: [{ text: "ok", type: "text" }], name: call.name, status: "complete" })),
    handoff: vi.fn(async () => {
      order.push(browserLiveRelay().find(currentChat, "user") ? "handoff:live-open" : "handoff");
      return { status: "ready" as const };
    }),
    settle: vi.fn(async () => {
      order.push(browserLiveRelay().find(currentChat, "user") ? "settle:live-open" : "settle");
      return { quiesced: true, sessionSettled: true, stoppedVm: false };
    }),
    tools: vi.fn(async () => [{ capability: "workspace" as const, description: "Run a program.", inputSchema: { type: "object" }, name: EXEC }])
  };
  return { coordinator: coordinator as unknown as WorkspaceCoordinator, guest, order };
}

let currentChat = "chat";

function adapter(calls: ProviderRunResult["toolCalls"]) {
  const requests: ProviderRunRequest[] = [];
  const value: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const first = requests.length === 1;
      if (!first) yield { data: { delta: "Done." }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: first ? "" : "Done.", toolCalls: first ? [...(calls ?? [])] : [],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter: value, requests };
}

function engine(now?: () => number): NativeEngineDeps {
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
    retiredRunEffects: vi.fn(async () => []), runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  return {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []), ...(now ? { now } : {}),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never),
    runs: { workDurationMs: vi.fn(async () => null), applyUsageTotals: vi.fn(async () => undefined), complete: vi.fn(async () => true),
      publishAnswer: vi.fn(async () => true), recordDetachedCompaction: vi.fn(async () => true), saveStoppedText: vi.fn(async () => true),
      writeUsageRows: vi.fn(async () => undefined) },
    savedResults: { read: vi.fn(async () => null) }, toolCalls, transcripts
  };
}

function prepared(chatId: string, turnTimeoutSeconds = 900): MaterializedPreparedRunData {
  const request = {
    attachmentIds: [], attachments: [], chatId, content: { blocks: [{ text: "Order from the shop", type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text: "Order from the shop", type: "text" }] }, id: "current-user-message", role: "user" as const }],
      mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system: "Be brief." }, provider: "fake",
    searchPlan: { mode: "all_selected" as const, options: [] }, toolMode: "auto" as const,
    workspace: { enabled: true, syncToolTimeoutSeconds: 120, turnTimeoutSeconds }
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, normalizedRequest: request,
    providerAdmissionPlan: { answer: { snapshot: { connection: { responseTimeoutMs: 60_000 }, connectionId: "connection-1",
      model: { adapterKind: "fake" }, providerFamily: "fake", providerModelId: "model-1" } } } as never,
    providerRequest: request, providerRequestPreview: {}, sourceKind: "send"
  };
}

function repository() {
  return {
    appendAssistantText: vi.fn(async () => undefined), appendRunOutputEvent: vi.fn(async (_runId: string, event: unknown) => event),
    failRun: vi.fn(async () => true), getChatUpdateForRun: vi.fn(async () => null), getRunControlForUser: vi.fn(async () => ({ status: "streaming" })),
    loadModelPricing: vi.fn(async () => null), loadProviderModelCostBasis: vi.fn(async () => null), markRunAnswerStarted: vi.fn(async () => undefined)
  };
}

const handoffCall = { arguments: { message: "Please sign in to the shop and press Done.", reason: "sign_in" }, id: "call-1",
  name: BROWSER_HANDOFF_TOOL_NAME };

function start(options: Readonly<{ now?: () => number; scheduled?: true; telegram?: true; turnTimeoutSeconds?: number }> = {}) {
  runs += 1;
  currentChat = `chat-${runs}`;
  const runId = `run-${runs}`;
  const space = workspace();
  const model = adapter([handoffCall]);
  const repo = repository();
  const response = createNativeRunExecutionResponse({ adapter: model.adapter, created: { assistantMessageId: `answer-${runs}`, runId,
    userMessageId: `question-${runs}` }, engine: engine(options.now), prepared: prepared(currentChat, options.turnTimeoutSeconds),
  repository: repo as unknown as RunRepository, ...(options.scheduled ? { scheduled: true } : {}),
  ...(options.telegram ? { telegram: true } : {}), services: {}, userId: "user", workspace: space.coordinator });
  return { chatId: currentChat, model, repo, response, runId, space };
}

async function events(response: Response): Promise<ModelRunSseEvent[]> {
  return (await response.text()).split("\n\n").flatMap((block) => {
    const type = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    return type && data ? [{ data: JSON.parse(data), type } as ModelRunSseEvent] : [];
  });
}

/** The panel the owner opens once the run shows its live browser, and the pending handoff it then shows. */
async function openPanel(chatId: string) {
  let view: BrowserLiveView | null = null;
  await until(() => (view = browserLiveRelay().find(chatId, "user")) !== null);
  const tab = recordingWriter();
  await view!.watch(owner, tab.writer);
  await until(() => Boolean(tab.last<BrowserLiveStateEvent>("state")?.handoff));
  return { handoff: tab.last<BrowserLiveStateEvent>("state")!.handoff!, tab, view: view! };
}

function handoffResult(requests: readonly ProviderRunRequest[]): Record<string, unknown> {
  const item = requests[1]!.history!.find((entry) => entry.type === "tool_result");
  return JSON.parse((item as { output: string }).output) as Record<string, unknown>;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("browser_handoff in a native run", () => {
  it("waits inside the turn for Done, tells the model only the outcome and page, and ends the live browser before the hand-off", async () => {
    const run = start();
    const reading = events(run.response);
    const panel = await openPanel(run.chatId);
    expect(panel.handoff).toMatchObject({ message: "Please sign in to the shop and press Done.", reason: "sign_in" });
    // The tool time of a 15-minute Workspace turn caps the wait below the ten-minute limit (`turnDeadline.ts`).
    const waits = Date.parse(panel.handoff.expiresAt) - Date.parse(panel.handoff.startedAt);
    expect(waits).toBeLessThanOrEqual(480_000);
    expect(waits).toBeGreaterThan(470_000);
    expect(await panel.view.input(owner, { kind: "text", text: "zz-typed-4242" })).toBeNull();
    expect(panel.view.answerHandoff(owner, { action: "done", handoffId: panel.handoff.id })).toBeNull();
    const result = await reading;
    expect(result.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
    expect(handoffResult(run.model.requests)).toMatchObject({ outcome: "completed",
      page: { title: "Sign in", url: "https://shop.example/login" }, signInSavedAfterAnswer: "shop.example" });
    expect(JSON.stringify(run.model.requests[1]!.history)).not.toContain("zz-typed-4242");
    expect(run.space.order).toEqual(["handoff"]);
    expect(panel.tab.closed()).toEqual({ data: { reason: "run_finished" }, event: "end" });
    expect(run.space.guest.received.filter((message) => message.t === "handoff").map((message) => message.outcome))
      .toEqual([undefined, "completed"]);
    // The tool status the panel opens on names the tool.
    expect(result.some((event) => event.type === "artifact" && event.data.artifactType === "tool_call" &&
      (event.data.payload as { name?: string }).name === BROWSER_HANDOFF_TOOL_NAME)).toBe(true);
  });

  it("returns cancelled when the user cancels", async () => {
    const run = start();
    const reading = events(run.response);
    const panel = await openPanel(run.chatId);
    panel.view.answerHandoff(owner, { action: "cancel", handoffId: panel.handoff.id });
    await reading;
    expect(handoffResult(run.model.requests)).toMatchObject({ outcome: "cancelled" });
    expect(handoffResult(run.model.requests).signInSavedAfterAnswer).toBeUndefined();
  });

  it("returns timed_out once the wait capped at the turn's tool time ran out", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    const run = start();
    const reading = events(run.response);
    await openPanel(run.chatId);
    await vi.advanceTimersByTimeAsync(480_000);
    await reading;
    expect(handoffResult(run.model.requests)).toMatchObject({ outcome: "timed_out" });
  });

  it("is ended by Stop: the run is cancelled and the guest's handoff ends with it", async () => {
    const run = start();
    const reading = events(run.response);
    await openPanel(run.chatId);
    expect(activeRunControllerRegistry.abort(run.runId)).toBe(true);
    const result = await reading;
    expect(result.at(-1)).toMatchObject({ data: { status: "cancelled" }, type: "done" });
    expect(run.space.order).toEqual(["settle"]);
    await until(() => run.space.guest.received.some((message) => message.t === "handoff" && message.action === "end"));
    expect(browserLiveRelay().find(run.chatId, "user")).toBeNull();
  });

  it("is ended by the run's deadline", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
    // A clock that reads the run as just started gives the handoff its whole ten minutes; the five-minute turn ends first.
    const startedAt = Date.now();
    let reads = 0;
    const run = start({ now: () => (reads++ === 0 ? startedAt : startedAt - 3_600_000), turnTimeoutSeconds: 300 });
    const reading = events(run.response);
    const panel = await openPanel(run.chatId);
    expect(Date.parse(panel.handoff.expiresAt) - Date.parse(panel.handoff.startedAt)).toBe(600_000);
    await vi.advanceTimersByTimeAsync(300_000);
    const result = await reading;
    expect(result.at(-1)).toMatchObject({ data: { code: RUN_TIME_LIMIT_FAILURE.code }, type: "error" });
    expect(run.repo.failRun).toHaveBeenCalled();
    expect(run.space.order).toEqual(["settle"]);
  });

  it("answers a stable unavailable code in an unattended run and points a Telegram turn to the web chat", async () => {
    const scheduled = start({ scheduled: true });
    await events(scheduled.response);
    expect(handoffResult(scheduled.model.requests)).toMatchObject({ error: "browser_handoff_unavailable" });
    expect(scheduled.space.guest.started()).toBe(0);
    const telegram = start({ telegram: true });
    await events(telegram.response);
    const result = handoffResult(telegram.model.requests);
    expect(result).toMatchObject({ error: "browser_handoff_unavailable" });
    expect(String(result.chatUrl)).toContain(`/c/${telegram.chatId}`);
    expect(telegram.space.guest.started()).toBe(0);
  });
});
