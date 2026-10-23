// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  memoryNativeEngine, NATIVE_MCP_SNAPSHOT, NATIVE_RUN_ORIGIN, nativePrepared, nativeRunRepository, nativeSay, nativeSseEvents,
  scriptedNativeAdapter
} from "@/tests/support/nativeRunExecution";
import { resolveAssistantChatBaseline } from "../../domain/promptTemplates";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import type { ProviderRunRequest } from "../providers/types";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import type { RunRepository } from "../runs/runRepositoryContract";
import { monitoringCheckInstruction, monitoringVerdictReservedInstruction } from "../tools/monitoringVerdict";
import type { WorkspaceCoordinator } from "../workspace/coordinator";
import type { RunSecretSource } from "../workspace/secrets/runSecrets";
import { createNativeRunExecutionResponse } from "./execution";
import { nativeRunResponse, type NativeEngineHandlerDeps } from "./handlerSupport";
import { NEUTRAL_FAMILY_PROMPT } from "./prompts/neutral";
import { parseNativeEngineUsers } from "./routing";
import type { TranscriptItem } from "./transcript";

/**
 * The native engine on the runs the rollout moves to it: a scheduled
 * monitoring check reporting its verdict (through the reserved round when its
 * budget ran out), a scheduled run's flat context, a rotation's carried
 * Workspace, an answer review step's card, an Assistant's instructions, and
 * the tools each kind of run is offered.
 */
const VERDICT = "report_monitoring_result";
const created = { assistantMessageId: "answer-1", runId: "run-1", userMessageId: "question-1" };
const toolNames = (request: ProviderRunRequest | undefined) => (request?.tools ?? []).map((tool) => tool.name);
const asRepository = (repo: ReturnType<typeof nativeRunRepository>) => repo as unknown as RunRepository;

describe("a scheduled monitoring check on the native engine", () => {
  it("reports its verdict through the reserved tool, which only its own run records", async () => {
    const instruction = monitoringCheckInstruction({ previousResult: false });
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: { status: "update" }, id: "v1", name: VERDICT }] },
      { text: "Version 2.0 is out." }
    ]);
    const memory = memoryNativeEngine();
    const repo = nativeRunRepository();
    const result = await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ monitoringVerdictTool: true, prompt: { developer: null, system: instruction } }),
      repository: asRepository(repo), scheduled: true, services: {}, userId: "owner" }));
    expect(result.at(-1)).toEqual({ data: { runId: "run-1", status: "complete" }, type: "done" });
    expect(toolNames(requests[0])).toContain(VERDICT);
    // The check's own instruction follows the family prompt.
    expect(requests[0]!.prompt.system!.startsWith(NEUTRAL_FAMILY_PROMPT)).toBe(true);
    expect(requests[0]!.prompt.system).toContain(instruction);
    expect(repo.recordMonitoringVerdict).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", userId: "owner", verdict: "update" });
    expect(memory.published()).toBe("Version 2.0 is out.");
    expect(memory.transcriptRows.find((item) => item.kind === "tool_result")).toMatchObject({ callId: "v1", outcome: "complete" });
  });

  it("is asked for its verdict alone once its call budget ran out, and the instruction never enters the transcript", async () => {
    const reserved = monitoringVerdictReservedInstruction();
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: { key: "A-1" }, id: "c1", name: "mcp_jira_get_issue" }] },
      { calls: [{ arguments: { key: "A-2" }, id: "c2", name: "mcp_jira_get_issue" }] },
      { calls: [{ arguments: { status: "no_update" }, id: "v1", name: VERDICT }, { arguments: { key: "A-3" }, id: "c3",
        name: "mcp_jira_get_issue" }] },
      { text: "Nothing new." }
    ]);
    const memory = memoryNativeEngine();
    const repo = nativeRunRepository();
    const callTool = vi.fn(async () => ({ isError: false, text: ["open"], unsupportedContentTypes: [] }));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      mcpRuntime: () => ({ callTool, ensureAcceptedGeneration: async () => true }) as never,
      prepared: nativePrepared({ mcp: NATIVE_MCP_SNAPSHOT, monitoringVerdictTool: true,
        toolBudgets: { maxMcpToolsPerDiscovery: 5, maxToolCalls: 1, maxToolRounds: 8 } }),
      repository: asRepository(repo), scheduled: true, services: {}, userId: "owner" }));
    expect(requests).toHaveLength(4);
    expect(callTool).toHaveBeenCalledTimes(1);
    // Round 3 is the reserved one: tools stay declared, its last input asks for the verdict only.
    expect(requests[2]!.toolChoice).toBe("auto");
    expect(requests[2]!.history!.at(-1)).toEqual({ text: reserved, type: "user" });
    expect(requests[1]!.history!.some((item) => item.type === "user" && item.text === reserved)).toBe(false);
    expect(requests[3]!.toolChoice).toBe("none");
    expect(requests[3]!.history!.some((item) => item.type === "user" && item.text === reserved)).toBe(false);
    expect(repo.recordMonitoringVerdict).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", userId: "owner", verdict: "no_update" });
    expect(memory.transcriptRows.some((item) => item.kind === "user" && item.text === reserved)).toBe(false);
    expect(memory.published()).toBe("Nothing new.");
  });

  it("tells the model when its occurrence can no longer take a verdict", async () => {
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: { status: "goal_reached" }, id: "v1", name: VERDICT }] }, { text: "Done." }
    ]);
    const memory = memoryNativeEngine();
    const repo = nativeRunRepository();
    repo.recordMonitoringVerdict.mockResolvedValue(false);
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ monitoringVerdictTool: true }), repository: asRepository(repo), scheduled: true, services: {},
      userId: "owner" }));
    expect(requests[1]!.history!.find((item) => item.type === "tool_result")).toMatchObject({ isError: true,
      output: expect.stringContaining("can no longer record") });
  });
});

describe("a scheduled run's flat context on the native engine", () => {
  const previous: TranscriptItem[] = [
    { id: "p0", kind: "compaction", origin: NATIVE_RUN_ORIGIN, summary: "SYNTHETIC OLDER RESULTS" },
    { arguments: "{\"key\":\"A-1\"}", callId: "pc1", id: "p1", kind: "tool_call", name: "mcp_jira_get_issue", origin: NATIVE_RUN_ORIGIN },
    { callId: "pc1", id: "p2", kind: "tool_result", name: "mcp_jira_get_issue", outcome: "complete", output: "A-1: open" },
    { id: "p3", kind: "assistant_text", origin: NATIVE_RUN_ORIGIN, text: "A-1 is open." }
  ];
  const context = { messages: [nativeSay("previous-user", "user", "Check A-1"), nativeSay("previous-answer", "assistant", "A-1 is open."),
    nativeSay("current-user-message", "user", "Check A-1")], mode: "branch_path" as const };

  async function firstHistory(scheduled: boolean) {
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Still open." }]);
    const memory = memoryNativeEngine();
    memory.transcripts.nativeRunsForAnswers.mockResolvedValue(new Map([["previous-answer", "run-0"]]));
    memory.transcripts.loadRuns.mockResolvedValue(new Map([["run-0", previous]]));
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine, prepared: nativePrepared({ context }),
      repository: asRepository(nativeRunRepository()), ...(scheduled ? { scheduled: true as const } : {}), services: {}, userId: "owner" }));
    return requests[0]!.history!;
  }

  it("carries the previous result's own items, never a compaction of what came before it", async () => {
    const flat = await firstHistory(true);
    expect(flat.map((item) => item.type)).toEqual(["user", "tool_call", "tool_result", "assistant_text", "user"]);
    expect(JSON.stringify(flat)).not.toContain("SYNTHETIC OLDER RESULTS");
    // An ordinary chat continues from the compaction.
    expect(JSON.stringify(await firstHistory(false))).toContain("SYNTHETIC OLDER RESULTS");
  });
});

describe("a monthly rotation's carried Workspace on the native engine", () => {
  it("is restored before the first request", async () => {
    const order: string[] = [];
    const { adapter } = scriptedNativeAdapter([{ text: "Report ready." }], order);
    const memory = memoryNativeEngine();
    const workspace = {
      accepts: () => false,
      handoff: vi.fn(async () => ({ status: "ready" })),
      prepareCarryover: vi.fn(async () => { order.push("carryover"); }),
      settle: vi.fn(async () => undefined),
      tools: vi.fn(async () => [])
    };
    const result = await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ workspace: { enabled: true, syncToolTimeoutSeconds: 30, turnTimeoutSeconds: 600 } as ProviderRunRequest["workspace"] }),
      repository: asRepository(nativeRunRepository()), scheduled: true, services: {}, userId: "owner",
      workspace: workspace as unknown as WorkspaceCoordinator }));
    expect(result.at(-1)).toMatchObject({ data: { status: "complete" }, type: "done" });
    expect(workspace.prepareCarryover).toHaveBeenCalledWith(expect.objectContaining({ runId: "run-1", userId: "owner" }));
    expect(order).toEqual(["carryover", "request"]);
  });
});

describe("an answer review step on the native engine", () => {
  const step = { kind: "review" as const, modelName: "Fake reviewer", reviewer: 0, round: 1, sessionId: "session-1", step: 0, version: 1 as const };

  it("publishes the step's card from its first report and refuses a second one", async () => {
    const review = { findings: [], verdict: "clean" };
    const { adapter, requests } = scriptedNativeAdapter([
      { calls: [{ arguments: review, id: "r1", name: "submit_answer_review" }, { arguments: review, id: "r2", name: "submit_answer_review" }] },
      { text: "The answer holds." }
    ]);
    const memory = memoryNativeEngine();
    const repo = nativeRunRepository();
    await nativeSseEvents(createNativeRunExecutionResponse({ adapter, created, engine: memory.engine,
      prepared: nativePrepared({ answerReviewStep: step }), repository: asRepository(repo), services: {}, userId: "user" }));
    expect(toolNames(requests[0])).toContain("submit_answer_review");
    const cards = repo.appendRunOutputEvent.mock.calls.map(([, event]) => event as ModelRunSseEvent)
      .filter((event) => event.type === "artifact" && event.data.artifactType === "answer_review");
    expect(cards).toEqual([{ data: { artifactType: "answer_review", payload: { findings: [], reviewer: 0, reviewerName: "Fake reviewer",
      round: 1, verdict: "clean", version: 1 } }, type: "artifact" }]);
    const results = memory.transcriptRows.filter((item) => item.kind === "tool_result");
    expect(results.map((item) => item.kind === "tool_result" && [item.callId, item.outcome])).toEqual([["r1", "complete"], ["r2", "error"]]);
    expect(memory.published()).toBe("The answer holds.");
  });
});

describe("the tools a native run is offered by kind", () => {
  const secrets: RunSecretSource = { list: vi.fn(async () => []), read: vi.fn() };
  const native = (memory: ReturnType<typeof memoryNativeEngine>): NativeEngineHandlerDeps => ({
    allowlist: () => parseNativeEngineUsers("*"),
    engine: memory.engine,
    findOrphans: async () => [],
    tools: { secrets, selfService: { assistants: {} as never, db: {} as never, storage: {} as never } }
  });

  async function offered(data: Partial<MaterializedPreparedRunData>, extra: Partial<ProviderRunRequest> = {}, scheduled = false) {
    const { adapter, requests } = scriptedNativeAdapter([{ text: "Hi." }]);
    const memory = memoryNativeEngine();
    await nativeSseEvents(nativeRunResponse(native(memory), { adapter, created, prepared: nativePrepared(extra, data),
      repository: asRepository(nativeRunRepository()), ...(scheduled ? { scheduled: true } : {}), services: {}, userId: "user" }));
    return { request: requests[0]!, tools: toolNames(requests[0]) };
  }

  it("gives a personal chat the self-service tools, and an Assistant chat or a scheduled run none of them", async () => {
    expect((await offered({})).tools).toEqual(expect.arrayContaining(["read_secret", "manage_secret", "manage_skill", "manage_assistant"]));
    for (const run of [await offered({ assistant: {} as never }), await offered({ chatAssistant: {} as never }), await offered({}, {}, true)]) {
      expect(run.tools).toContain("read_secret");
      expect(run.tools).not.toContain("manage_secret");
      expect(run.tools).not.toContain("manage_assistant");
    }
    // A scheduled monitoring check takes its verdict tool, never a self-service one.
    const check = await offered({}, { monitoringVerdictTool: true }, true);
    expect(check.tools).toContain(VERDICT);
    expect(check.tools).not.toContain("manage_skill");
  });

  it("puts an Assistant's own instructions after the family prompt and keeps its answer rules", async () => {
    const baseline = resolveAssistantChatBaseline({ now: new Date("2026-10-23T06:00:00Z"), timeZone: "Europe/Moscow" });
    const { request } = await offered({ assistant: {} as never }, { prompt: {
      baseline: { source: "assistant_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" }, developer: "Answer in haiku.",
      responseReminder: "Remember: haiku.", system: `${baseline.renderedSystemPrompt}\n\nYou are Ada, a synthetic travel planner.`
    } });
    const system = request.prompt.system!;
    expect(system.startsWith(NEUTRAL_FAMILY_PROMPT)).toBe(true);
    expect(system.indexOf("You are Ada, a synthetic travel planner.")).toBeGreaterThan(NEUTRAL_FAMILY_PROMPT.length);
    expect(system).not.toContain(baseline.renderedSystemPrompt);
    expect(request.prompt).toMatchObject({ developer: "Answer in haiku.", responseReminder: "Remember: haiku." });
  });
});
