import { describe, expect, it, vi } from "vitest";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import type { SystemModelRoleResolution } from "../providerRuntime/systemModelRole";
import { ChatContinuationError, createChatContinuationService, splitSummaryTranscript, type ContinuationRepository } from "./continuation";
import { estimateApproxTokens } from "../../domain/contextBudget";

const input = { chatId: "source", userId: "owner", expectedLeafMessageId: "answer", requestId: "attempt" };
function model(contextWindow = 32000): SystemModelRoleResolution {
  const configuration = { adapterKind: "fake", capabilities: { contextWindow, maxOutputTokens: 8192, structuredOutput: true },
    defaultParams: {}, upstreamModelId: "fake-upstream" };
  return { ok: true, credentialScope: "installation", policyVersion: 1, providerModelId: "fake", reasoningEffort: "low",
    role: { modelConfiguration: configuration, snapshot: { providerFamily: "fake", model: configuration,
      connection: { responseTimeoutMs: 300000 } } } as unknown as ProviderAdmissionRole };
}
function fixture(transcript = "USER: Plan a trip.\nASSISTANT: Budget is 500.") {
  const source = { chatId: "source", userId: "owner", leafMessageId: "answer", projectId: null, updatedAt: new Date(), transcript, workspaceEnabled: false };
  const repository = {
    loadSource: vi.fn(async () => source),
    claim: vi.fn<ContinuationRepository["claim"]>(async () => ({ kind: "claimed", claim: { id: "operation", attemptId: "attempt" } })),
    assertCurrent: vi.fn(async () => {}),
    complete: vi.fn<ContinuationRepository["complete"]>(async () => ({ status: "complete", chatId: "new", projectId: null })),
    fail: vi.fn(async () => {}), recordUsage: vi.fn(async () => {})
  } satisfies ContinuationRepository;
  const execute = vi.fn<Parameters<typeof createChatContinuationService>[0]["execute"]>(async (_role, _request, options) => {
    await options.beforeDispatch?.();
    options.onUsage?.({ inputTokens: 80, outputTokens: 10, reasoningTokens: 0, totalTokens: 90 });
    return { summary: "## Goal\nPlan a trip.\n## Decisions\nBudget: 500." };
  });
  const resolveSystemModel = vi.fn(async () => model());
  return { repository, execute, resolveSystemModel };
}

describe("chat continuation service", () => {
  it("uses the exact System Model, only transcript data, no tools, and records reported usage", async () => {
    const f = fixture();
    const modelSelection = { provider: "provider", modelId: "chosen" };
    expect(await createChatContinuationService(f)({ ...input, modelSelection })).toMatchObject({ status: "complete", chatId: "new" });
    expect(f.repository.claim).toHaveBeenCalledWith(await f.repository.loadSource(), input.requestId, modelSelection);
    const [role, request] = f.execute.mock.calls[0]!;
    expect(role).toMatchObject({ snapshot: { providerFamily: "fake" } });
    expect(request.userPrompt).toBe((await f.repository.loadSource()).transcript);
    expect(request).not.toHaveProperty("tools");
    expect(request.systemPrompt).toContain("untrusted conversation data");
    expect(f.repository.recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      ordinal: 1, providerModelId: "fake", modelId: "fake", usage: { inputTokens: 80, outputTokens: 10, reasoningTokens: 0, totalTokens: 90 }
    }));
    expect(f.repository.complete).toHaveBeenCalledOnce();
  });

  it("returns an existing operation without making another provider call", async () => {
    const f = fixture();
    f.repository.claim.mockResolvedValue({ kind: "result", result: { status: "running" } });
    expect(await createChatContinuationService(f)(input)).toEqual({ status: "running" });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.resolveSystemModel).not.toHaveBeenCalled();
  });

  it("splits consecutive text without losing Unicode, then merges partial summaries", async () => {
    const text = "Договорились 🚀\n".repeat(4000);
    const parts = splitSummaryTranscript(text, 10000);
    expect(parts.join("")).toBe(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => estimateApproxTokens(part) <= 10000 && !/[\uD800-\uDBFF]$/.test(part))).toBe(true);
    const f = fixture(text);
    f.resolveSystemModel.mockResolvedValue(model(20000));
    await createChatContinuationService(f)(input);
    const calls = f.execute.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.slice(0, -1).map(([, request]) => request.userPrompt).join("")).toBe(text);
    expect(calls.at(-1)?.[1].userPrompt).toContain("Part 1:");
    expect(f.repository.recordUsage.mock.calls.length).toBe(calls.length);
  });

  it("handles more than eight parts without losing the source or limiting the whole job", async () => {
    const f = fixture("long input ".repeat(100000));
    await expect(createChatContinuationService(f)(input)).resolves.toMatchObject({ status: "complete" });
    expect(f.execute.mock.calls.length).toBeGreaterThan(8);
    expect(f.execute.mock.calls.slice(0, -1).map(([, request]) => request.userPrompt).join(""))
      .toBe((await f.repository.loadSource()).transcript);
    expect(f.execute.mock.calls.every(([, request, options]) => request.reasoningBudgetIncluded && options.timeoutMs === 300000)).toBe(true);
  });

  it("fails safely with no System Model or malformed output", async () => {
    const f = fixture();
    f.resolveSystemModel.mockResolvedValue({ ok: false, code: "system_model_absent" });
    await expect(createChatContinuationService(f)(input)).rejects.toMatchObject({ code: "chat_summary_unavailable" });
    expect(f.execute).not.toHaveBeenCalled();
    f.resolveSystemModel.mockResolvedValue(model());
    f.execute.mockResolvedValue({ summary: "" });
    await expect(createChatContinuationService(f)(input)).rejects.toMatchObject({ code: "chat_summary_failed" });
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it("records usage on provider failure but never creates a chat or exposes raw errors", async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_role, _request, options) => {
      options.onUsage?.({ inputTokens: 80, outputTokens: 0, reasoningTokens: 0 });
      throw new Error("private provider details");
    });
    await expect(createChatContinuationService(f)(input)).rejects.toThrow("chat_summary_failed");
    expect(f.repository.recordUsage).toHaveBeenCalledWith(expect.objectContaining({ usage: { inputTokens: 80, outputTokens: 0, reasoningTokens: 0 } }));
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it("rejects cancellation and a changed source before creating a child", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.execute.mockImplementation(async () => { controller.abort(); return { summary: "ready" }; });
    await expect(createChatContinuationService(f)({ ...input, signal: controller.signal }))
      .rejects.toMatchObject({ code: "chat_summary_cancelled" });
    expect(f.repository.complete).not.toHaveBeenCalled();
    const changed = fixture();
    changed.repository.assertCurrent.mockRejectedValue(new ChatContinuationError("chat_changed"));
    await expect(createChatContinuationService(changed)(input)).rejects.toMatchObject({ code: "chat_changed" });
    expect(changed.execute).not.toHaveBeenCalled();
  });
});

it("returns a background claim immediately, exposes progress and respects durable cancellation", async () => {
  const f = fixture();
  const heartbeat = vi.fn(async () => true);
  const scheduled: Array<() => Promise<void>> = [];
  const run = createChatContinuationService({ ...f, repository: { ...f.repository, heartbeat },
    schedule: work => { scheduled.push(work); } });
  expect(await run(input)).toEqual({ status: "running", progress: { completedParts: 0, stage: "preparing" } });
  expect(f.execute).not.toHaveBeenCalled();
  heartbeat.mockResolvedValue(false);
  await scheduled[0]!();
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.repository.fail).toHaveBeenCalledWith(expect.anything(), "chat_summary_cancelled");
});

it("reuses a settled fragment without another provider request and does not replay an ambiguous one", async () => {
  const f = fixture();
  const loadStep = vi.fn(async () => "A settled summary.");
  const run = createChatContinuationService({ ...f, repository: { ...f.repository, loadStep } });
  await expect(run(input)).resolves.toMatchObject({ status: "complete" });
  expect(f.execute).not.toHaveBeenCalled();
  expect(f.repository.recordUsage).not.toHaveBeenCalled();
  loadStep.mockRejectedValue(new ChatContinuationError("chat_summary_outcome_unknown", 502));
  await expect(run(input)).rejects.toMatchObject({ code: "chat_summary_outcome_unknown" });
  expect(f.execute).not.toHaveBeenCalled();
});
