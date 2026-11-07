// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { createFakeComputerOps, type FakeComputerOps } from "../connect/computerPort";
import type { ProviderAdapter, ProviderRunRequest, ProviderRunResult } from "../providers/types";
import { activeRunControllerRegistry } from "../runs/activeRunControllerRegistry";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { computerTurnGuidance, freezeComputerBinding, type FrozenComputerBinding } from "../tools/computerBinding";
import { createNativeRunExecutionResponse, type NativeEngineDeps } from "./execution";
import type { ToolCallBeginResult, ToolCallRow, ToolCallStore } from "./toolCallStore";
import type { TranscriptRepository } from "./transcriptRepository";

const USER = "user-1";
const DEVICE = "0b6f1c2e-6a49-4c3e-9a51-3f1f0d2b7c11";
const binding = freezeComputerBinding({ cwd: "~/work", deviceId: DEVICE }, { arch: "arm64", name: "MacBook", online: true, os: "darwin" })!;
let runs = 0;

type Step = Readonly<{ calls?: ProviderRunResult["toolCalls"]; text?: string }>;

function adapter(steps: readonly Step[]) {
  const requests: ProviderRunRequest[] = [];
  const value: ProviderAdapter = {
    buildRequestPreview: () => ({}),
    async *stream(request): AsyncGenerator<ModelRunSseEvent, ProviderRunResult> {
      requests.push(request);
      const step: Step = steps[requests.length - 1] ?? { text: "Done." };
      if (step.text) yield { data: { delta: step.text }, type: "token" };
      return { finalProviderResponsePreview: {}, finalText: step.text ?? "", toolCalls: [...(step.calls ?? [])],
        usage: { inputTokens: 100, outputTokens: 10 } };
    }
  };
  return { adapter: value, requests };
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
    retiredRunEffects: vi.fn(async () => []), runLive: vi.fn(async () => true)
  } satisfies TranscriptRepository;
  return {
    approvedCall: vi.fn(async () => null), mcpBindingRows: vi.fn(async () => []),
    observations: vi.fn(async () => ({ withReservation: vi.fn() }) as never),
    runs: { workDurationMs: vi.fn(async () => null), applyUsageTotals: vi.fn(async () => undefined), complete: vi.fn(async () => true),
      publishAnswer: vi.fn(async () => true), recordDetachedCompaction: vi.fn(async () => true), saveStoppedText: vi.fn(async () => true),
      writeUsageRows: vi.fn(async () => undefined) },
    savedResults: { read: vi.fn(async () => null) }, toolCalls, transcripts
  };
}

function prepared(computer: FrozenComputerBinding | undefined): MaterializedPreparedRunData {
  const line = computer ? computerTurnGuidance(computer) : null;
  const request = {
    ...(computer ? { computer } : {}),
    attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ text: "List my reports", type: "text" }] },
    context: { messages: [{ content: { blocks: [{ text: "List my reports", type: "text" }] }, id: "current-user-message", role: "user" as const }],
      mode: "branch_path" as const },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: false, reasoning: true, toolCalling: true, vision: false },
    modelId: "fake-qsa", params: {}, prompt: { developer: null, system: ["Be brief.", line].filter(Boolean).join("\n\n"),
      ...(line ? { turnGuidance: [line] } : {}) }, provider: "fake",
    searchPlan: { mode: "all_selected" as const, options: [] }, toolMode: "auto" as const
  } as unknown as ProviderRunRequest;
  return {
    contextTruncation: null, defaults: null, expectedActiveLeafId: null, normalizedRequest: request,
    providerAdmissionPlan: { answer: { modelConfiguration: { adapterKind: "fake", capabilities: request.modelCapabilities, defaultParams: {} },
      snapshot: { connection: { responseTimeoutMs: 60_000 }, connectionId: "connection-1",
        model: { adapterKind: "fake", upstreamModelId: "fake-qsa" }, providerFamily: "fake", providerModelId: "model-1" } } } as never,
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

function start(ops: FakeComputerOps, steps: readonly Step[], options: Readonly<{ computer?: FrozenComputerBinding | null; telegram?: true }> = {}) {
  runs += 1;
  const runId = `run-computer-${runs}`;
  const model = adapter(steps);
  const response = createNativeRunExecutionResponse({ adapter: model.adapter, created: { assistantMessageId: `answer-${runs}`, runId,
    userMessageId: `question-${runs}` }, engine: engine(), prepared: prepared(options.computer === null ? undefined : options.computer ?? binding),
  repository: repository() as unknown as RunRepository, services: { computer: ops }, ...(options.telegram ? { telegram: true } : {}),
  userId: USER });
  return { model, response, runId };
}

async function events(response: Response): Promise<ModelRunSseEvent[]> {
  return (await response.text()).split("\n\n").flatMap((block) => {
    const type = /^event: (.+)$/mu.exec(block)?.[1];
    const data = /^data: (.+)$/mu.exec(block)?.[1];
    return type && data ? [{ data: JSON.parse(data), type } as ModelRunSseEvent] : [];
  });
}

const listCall = { arguments: { background: null, command: "ls ~/work", timeoutSeconds: null }, id: "call-1", name: "computer_shell" };

describe("a run bound to the user's computer", () => {
  it("offers the computer tools, sends the call for its run, puts the computer in the turn context and ends its run once", async () => {
    const ops = createFakeComputerOps();
    ops.enqueue({ ok: true, result: { durationMs: 5, exitCode: 0, stderr: "", stderrBytes: 0, stdout: "q3.xlsx\n", stdoutBytes: 8,
      truncated: false } }, "shell");
    const run = start(ops, [{ calls: [listCall] }, { text: "You have q3.xlsx." }]);
    const result = await events(run.response);
    expect(result.at(-1)).toEqual({ data: { runId: run.runId, status: "complete" }, type: "done" });
    const [first, second] = run.model.requests;
    expect(first!.tools?.map((tool) => tool.name)).toEqual(expect.arrayContaining(["computer_shell", "computer_read", "computer_job_stop"]));
    // The computer's facts ride in the turn context, never in the system prompt.
    expect(first!.prompt.system).not.toContain("The user's computer");
    expect(JSON.stringify(first!.history ?? first!.context)).toContain("The user's computer \\\"MacBook\\\" is connected for this chat");
    expect(ops.calls).toEqual([expect.objectContaining({ args: expect.objectContaining({ command: "ls ~/work", cwd: "~/work" }),
      deviceId: DEVICE, runId: run.runId, userId: USER })]);
    expect(JSON.stringify(second!.history)).toContain("Exit code: 0");
    expect(ops.endedRuns).toEqual([{ deviceId: DEVICE, runId: run.runId, userId: USER }]);
  });

  it("aborts a running command when the user stops the answer, and ends the run on the computer once", async () => {
    const ops = createFakeComputerOps();
    let stopped = false;
    ops.enqueue((sent) => {
      // Stop arrives while the command runs.
      queueMicrotask(() => {
        stopped = true;
        activeRunControllerRegistry.abort(sent.runId);
      });
      return new Promise(() => undefined);
    }, "shell");
    const run = start(ops, [{ calls: [{ ...listCall, arguments: { ...listCall.arguments, command: "sleep 600" } }] }]);
    const result = await events(run.response);
    expect(stopped).toBe(true);
    expect(result.at(-1)).toEqual({ data: { runId: run.runId, status: "cancelled" }, type: "done" });
    expect(ops.calls).toEqual([expect.objectContaining({ aborted: true })]);
    expect(ops.endedRuns).toEqual([{ deviceId: DEVICE, runId: run.runId, userId: USER }]);
  });

  it("offers nothing of the computer to a run without a binding or to a Telegram turn", async () => {
    for (const options of [{ computer: null }, { telegram: true as const }]) {
      const ops = createFakeComputerOps();
      const run = start(ops, [{ text: "Hello." }], options);
      await events(run.response);
      expect(run.model.requests[0]!.tools?.some((tool) => tool.name.startsWith("computer_")) ?? false).toBe(false);
      expect(ops.calls).toEqual([]);
    }
  });
});
