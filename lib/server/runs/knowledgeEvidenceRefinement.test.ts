import { describe, expect, it, vi } from "vitest";
import { refineKnowledgeEvidence } from "./knowledgeEvidenceRefinement";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import { toolLoopKnowledgeEvidenceDispatchDraft } from "../knowledge/automaticEvidence";
import { KnowledgeSearchFailure } from "../knowledge/searchFailure";
import { EMPTY_KNOWLEDGE_COVERAGE_LIMITATIONS_V1 } from "../knowledge/searchFailure";
import type { KnowledgeEvidenceAnswerReviewV1 } from "../knowledge/evidenceAnswerV1";
import type { ProviderRunRequest } from "../providers/types";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { snapshotToolExecutionResult } from "./toolExecutionPersistence";
import type { CheckpointedToolLoopRun, PersistedToolLoopCall, ToolLoopCheckpoint } from "./toolLoopPersistence";

vi.mock("../knowledge/automaticEvidence", () => ({ toolLoopKnowledgeEvidenceDispatchDraft: vi.fn(() => null) }));
type Input = Parameters<typeof refineKnowledgeEvidence>[0];
const resultFor = (call: Pick<ModelToolCall, "id" | "name">): ToolExecutionResult => ({ callId: call.id, name: call.name,
  status: "complete", content: [{ type: "text", text: "Source evidence for the requested date." }] });
function fixture(workflowVersion: 9 | 10 | 11 = 9) {
  const request: ProviderRunRequest = { attachmentIds: [], attachments: [], chatId: "chat", content: { blocks: [{ type: "text", text: "Compare the North and South effective dates." }] },
    knowledgeAnswerWorkflowVersion: workflowVersion, knowledgePlan: { mode: "explicit", version: 1, baseIds: ["base"], sourceIds: [] },
    modelCapabilities: {}, modelId: "answer", params: {}, prompt: { developer: null, system: null }, provider: "fake",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "auto", toolBudgets: {
      maxToolCalls: 8, maxToolRounds: 4, maxMcpToolsPerDiscovery: 10, mcpAutoDiscoveryTimeoutSeconds: 60 } };
  const first: PersistedToolLoopCall = { arguments: { query: "North effective date", sourceAliases: [] }, completedAt: new Date(1).toISOString(),
    id: "first", mcpBinding: null, ordinal: 0, providerCallId: "first-provider-call", result: null, roundIndex: 1,
    startedAt: new Date(0).toISOString(), state: "complete", toolName: "search_knowledge" };
  const calls = new Map([[first.id, { ...first, result: snapshotToolExecutionResult(resultFor({ id: first.providerCallId, name: first.toolName }), 10000) }]]);
  let checkpoint: ToolLoopCheckpoint = { answerRoundUsage: [], phase: "provider_running", providerContinuation: null,
    providerCursor: null, roundIndex: 2, version: 2 };
  const review: KnowledgeEvidenceAnswerReviewV1 = { version: 1, blocks: [], coverage: "partial", analysisComplete: true,
    missingInformation: ["The effective date for South."], followUps: [{ query: "South effective date", sourceAliases: [] }] };
  const scope = { bindings: [], budgetPolicy: { ...DEFAULT_KNOWLEDGE_BUDGET_POLICY }, exclusions: [], knowledgePlan: request.knowledgePlan };
  const repository: Input["repository"] = {
    loadCheckpointedToolLoopRun: vi.fn(async (): Promise<CheckpointedToolLoopRun> => ({ assistantMessageId: "answer", assistantText: null,
      calls: [...calls.values()], chatId: "chat", checkpoint, id: "run", knowledgeScope: scope,
      modelId: request.modelId, normalizedRequest: request, provider: request.provider, providerResponseId: null, status: "streaming", userId: "user" })),
    persistToolLoopCallBatch: vi.fn(async input => {
      const batch = input.calls.map((call): PersistedToolLoopCall => ({ ...call, id: call.providerCallId,
        completedAt: null, mcpBinding: null, result: null, roundIndex: input.roundIndex, startedAt: null, state: "pending" }));
      for (const call of batch) calls.set(call.id, call);
      checkpoint = { ...checkpoint, phase: "tools_pending" };
      return { kind: "persisted", calls: batch };
    }),
    claimToolLoopCall: vi.fn(async input => {
      const call = calls.get(input.callId)!;
      if (call.state === "complete" || call.state === "error") return { kind: "settled", call };
      if (call.state === "running") return { kind: "ambiguous", call };
      const claimed = { ...call, state: "running" as const };
      calls.set(call.id, claimed);
      return { kind: "claimed", call: claimed };
    }),
    settleToolLoopCall: vi.fn(async input => {
      calls.set(input.callId, { ...calls.get(input.callId)!, state: input.state, result: input.result, completedAt: new Date(2).toISOString() });
      return "settled";
    }),
    advanceToolLoopCallBatch: vi.fn(async () => { checkpoint = { ...checkpoint, phase: "provider_running", roundIndex: checkpoint.roundIndex + 1 }; return "advanced"; })
  };
  const execute = vi.fn(async (call: ModelToolCall) => resultFor(call));
  const preflight = vi.fn(async () => ({ kind: "admitted" as const }));
  const abort = new AbortController();
  const input: Input = { authorize: vi.fn(async () => undefined), executor: { capability: "knowledge", tool: {
    capability: "knowledge", name: "search_knowledge", description: "Search", inputSchema: {} },
    accepts: name => name === "search_knowledge", execute, preflight },
    repository, request, previousEvidence: { items: [] }, result: { review, evidenceReceiptHash: "c".repeat(64), publication: { version: 1, blocks: [], coverage: "none",
      analysisComplete: true, missingInformation: ["The effective date for South."], coverageLimitations: EMPTY_KNOWLEDGE_COVERAGE_LIMITATIONS_V1,
      draftHash: "a".repeat(64), reviewHash: "b".repeat(64) } }, runId: "run", userId: "user", signal: abort.signal, onResult: vi.fn() };
  return { input, execute, preflight, calls, scope, abort, repository, request };
}

describe("review-driven Knowledge retrieval", () => {
  it.each([9, 10, 11] as const)("persists the missing-date search and reuses it after checkpoint advancement (%s)", async workflowVersion => {
    const f = fixture(workflowVersion);
    await refineKnowledgeEvidence(f.input);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls[0]?.[0].arguments).toEqual({ query: "South effective date", sourceAliases: [] });
    expect(f.repository.advanceToolLoopCallBatch).toHaveBeenCalledTimes(1);
    expect(toolLoopKnowledgeEvidenceDispatchDraft).toHaveBeenLastCalledWith(expect.objectContaining({ results: [expect.any(Object), expect.any(Object)] }));
    await refineKnowledgeEvidence(f.input);
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.repository.persistToolLoopCallBatch).toHaveBeenCalledTimes(1);
    expect(f.repository.advanceToolLoopCallBatch).toHaveBeenCalledTimes(1);
  });

  it.each(["calls", "rounds", "knowledge"])("respects the accepted %s budget before dispatch", async kind => {
    const f = fixture();
    if (kind === "knowledge") f.scope.budgetPolicy.maxOperations = 1;
    else f.input = { ...f.input, request: f.request };
    if (kind === "calls") Object.assign(f.request.toolBudgets!, { maxToolCalls: 1 });
    if (kind === "rounds") Object.assign(f.request.toolBudgets!, { maxToolRounds: 1 });
    expect(await refineKnowledgeEvidence(f.input)).toBeNull();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.repository.persistToolLoopCallBatch).not.toHaveBeenCalled();
  });

  it("stops a recurring gap after later evidence instead of replaying an earlier checkpoint", async () => {
    const f = fixture(10);
    const first = f.input;
    await refineKnowledgeEvidence(first);
    await refineKnowledgeEvidence({ ...f.input, result: { ...f.input.result, evidenceReceiptHash: "d".repeat(64),
      review: { ...f.input.result.review, missingInformation: ["The effective date for West."],
        followUps: [{ query: "West effective date", sourceAliases: [] }] }
    } });
    const recurring = { ...first, result: { ...first.result, evidenceReceiptHash: "e".repeat(64) } };
    await expect(refineKnowledgeEvidence(recurring)).resolves.toBeNull();
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.repository.persistToolLoopCallBatch).toHaveBeenCalledTimes(2);
    expect(f.repository.advanceToolLoopCallBatch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates normalized queries with the same aliases while retaining a different scope", async () => {
    const f = fixture();
    await refineKnowledgeEvidence({ ...f.input, result: { ...f.input.result, review: { ...f.input.result.review, followUps: [
      { query: " North   effective date ", sourceAliases: [] },
      { query: "North effective date", sourceAliases: ["S1"] },
      { query: "South effective date", sourceAliases: [] }
    ] } } });
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(f.execute.mock.calls[0]?.[0].arguments.sourceAliases).toEqual(["S1"]);
  });

  it("does not repeat a running search with an unknown outcome", async () => {
    const f = fixture();
    vi.mocked(f.repository.claimToolLoopCall).mockImplementation(async ({ callId }) => ({ kind: "ambiguous", call: f.calls.get(callId)! }));
    await expect(refineKnowledgeEvidence(f.input)).rejects.toMatchObject({
      code: "knowledge_answer_contract_failed",
      message: "knowledge_refinement_checkpoint_conflict"
    });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("does not dispatch after authority is lost", async () => {
    const f = fixture();
    await expect(refineKnowledgeEvidence({ ...f.input, authorize: async () => { throw Error("scope_revoked"); } })).rejects.toThrow("scope_revoked");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.repository.persistToolLoopCallBatch).not.toHaveBeenCalled();
  });

  it("settles a local timeout as a technical search result, but keeps cancellation terminal", async () => {
    const f = fixture();
    f.execute.mockRejectedValue(new KnowledgeSearchFailure("opensearch_timeout"));
    await refineKnowledgeEvidence(f.input);
    expect(f.repository.settleToolLoopCall).toHaveBeenCalledWith(expect.objectContaining({ state: "error" }));
    const cancelled = fixture();
    cancelled.execute.mockImplementation(async () => { cancelled.abort.abort(); throw Error("cancelled"); });
    await expect(refineKnowledgeEvidence(cancelled.input)).rejects.toThrow();
    expect(cancelled.repository.settleToolLoopCall).not.toHaveBeenCalled();
  });
});
