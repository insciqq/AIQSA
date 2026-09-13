// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { modelPdfPageEndMarker, modelPdfPageStartMarker } from "../parsing/modelPdfOutput";
import { createChatPdfCoordinator, type ChatPdfCoordinatorDependencies } from "./chatPdfCoordinator";
import { ChatPdfPreparationError, encodeChatPdfArtifact } from "./chatPdfCore";
import { getContext, runInBackground, runWithContext } from "../observability";
import { CHAT_PDF_HEARTBEAT_MS } from "./chatPdfPersistence";

function harness(workspace = false) {
  const controller = new AbortController();
  const claim = { claimToken: "lease", runId: "run", userId: "owner" };
  const local = encodeChatPdfArtifact({ pageCount: 1, geometry: null, docling: null });
  const objects = new Map([["local", local.body], ["original", Buffer.from("original")]]);
  const artifacts = new Map<string, { id: string; storageKey: string; byteSize: number; checksum: string }>([
    ["local", { id: "local", storageKey: "local", byteSize: local.body.length, checksum: local.checksum }]
  ]);
  const row = { attachmentId: "attachment", attachment: { storageKey: "original" }, bindingAuthority: null,
    bindingSnapshot: { version: 1, connectionDisplayName: "Fixture", modelDisplayName: "Fixture", providerFamily: "openai_compatible", connectionId: "connection",
      credentialId: "credential", credentialVersionId: "credential-version", providerModelId: "model",
      connection: { allowPrivateNetwork: false, apiRoot: "https://provider.example.test/v1", authenticationMode: "bearer", responseTimeoutMs: 120000 },
      model: { adapterKind: "openai_responses_compatible", answerSelectable: true, capabilities: { vision: true, pdf: true, nativePdfInput: false, nativeSearch: false, reasoning: false, contextWindow: 128000 },
        defaultParams: {}, modelClass: "answer", upstreamModelId: "fixture" } },
    completedPages: 0, id: "preparation", localArtifactId: "local", pageCount: 1, policyVersion: null,
    retryable: false, errorCode: null as string | null, route: "selected_model_vision", sourceByteSize: 8,
    sourceChecksum: createHash("sha256").update("original").digest("hex"), state: "preparing",
    workPlan: { pageCount: 1, units: [{ page: 1, route: "vision_required", key: "unit", crops: [] }] } };
  const attempts: Array<{ state: string; page: number; resultArtifactId: string | null; errorCode: string | null }> = [];
  let alive = true;
  const accepted = () => { if (!alive || controller.signal.aborted) throw new Error("inactive"); };
  const deps = {
    authorize: vi.fn(async () => alive), continueRun: vi.fn(async () => { alive = false; }),
    execute: vi.fn(async () => ({ finalText: `${modelPdfPageStartMarker(1)}\nRead page.\n${modelPdfPageEndMarker(1)}`,
      usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 0 } })),
    fail: vi.fn(async () => { alive = false; }),
    core: { page: vi.fn(async () => ({ request: { toolMode: "none" }, requestDigest: "digest" })),
      assemble: vi.fn(() => ({ text: "Read page.", pageCount: 1 })), plan: vi.fn() },
    registry: { register: () => ({ signal: controller.signal, release() {} }) },
    attempts: {
      list: async () => attempts,
      reserve: vi.fn(async () => { attempts.push({ state: "reserved", page: 1, resultArtifactId: null, errorCode: null });
        return { kind: "reserved", attemptId: "attempt" }; }),
      dispatch: vi.fn(async () => { accepted(); attempts[0]!.state = "dispatched";
        return { attemptId: "attempt", usageEventId: "usage" }; }),
      recordUsage: vi.fn(async () => true),
      ambiguous: vi.fn(async (_dispatch, errorCode = "pdf_preparation_ambiguous") => {
        if (attempts[0]?.state !== "dispatched") return false;
        Object.assign(attempts[0], { state: "ambiguous", errorCode }); return true; }),
      settle: vi.fn(async (_dispatch, result) => { attempts[0] = { ...attempts[0]!, state: "settled", ...result }; return true; })
    },
    repository: {
      claim: async () => alive ? claim : null, release: vi.fn(async () => true), heartbeat: async () => alive,
      load: async () => ({ modelRun: { chatPdfAttachments: [row], workspaceRunBinding: workspace ? { modelRunId: "run" } : null } }),
      useWorkspaceOriginal: vi.fn(async (_claim, _id, errorCode) => {
        accepted(); Object.assign(row, { state: "original_only", errorCode, retryable: false }); }),
      readArtifact: async (id: string) => artifacts.get(id),
      reserveArtifact: vi.fn(async (_claim, input) => { accepted(); const id = `artifact-${artifacts.size}`;
        const artifact = { ...input, id, storageKey: id }; artifacts.set(id, artifact); return artifact; }),
      acceptArtifact: async () => true, abandonArtifact: vi.fn(),
      completedPages: vi.fn(async () => { accepted(); row.completedPages = attempts.filter((item) => item.state === "settled" && item.resultArtifactId).length; }),
      beginAssembly: vi.fn(async () => { accepted(); row.state = "assembling"; return attempts; }),
      publishDocument: vi.fn(async () => { accepted(); row.state = "ready"; }), pageCount: vi.fn(), savePlan: vi.fn()
    },
    storage: {
      getObject: async (storageKey: string) => ({ body: objects.get(storageKey), contentType: "application/json", storageKey }),
      putObjectStream: async ({ body, storageKey }: { body: ReadableStream; storageKey: string }) => {
        const reader = body.getReader(); const buffers: Buffer[] = [];
        while (true) { const next = await reader.read(); if (next.done) break; buffers.push(Buffer.from(next.value)); }
        objects.set(storageKey, Buffer.concat(buffers));
      }
    }
  };
  const coordinator = () => createChatPdfCoordinator(deps as unknown as ChatPdfCoordinatorDependencies);
  return { attempts, controller, coordinator, deps, row };
}

describe("durable PDF coordinator", () => {
  afterEach(() => vi.restoreAllMocks());

  it("observes provider failure before rejected usage and ambiguity writes without private content", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const records = () => writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>);
    const h = harness();
    h.deps.execute.mockRejectedValue(Object.assign(new Error("PRIVATE_PROVIDER_CANARY"), { code: "provider_request_timed_out" }));
    let recordsBeforeUsage: Record<string, unknown>[] = [];
    h.deps.attempts.recordUsage.mockImplementation(async () => {
      recordsBeforeUsage = records();
      throw new Error("PRIVATE_USAGE_DATABASE_CANARY");
    });
    h.deps.attempts.ambiguous.mockRejectedValue(new Error("PRIVATE_AMBIGUITY_DATABASE_CANARY"));
    await h.coordinator().runOne();
    expect(h.deps.attempts.recordUsage).toHaveBeenCalledOnce();
    expect(recordsBeforeUsage).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "dispatch", outcome: "failed", code: "provider_request_timed_out" }));
    expect(records()).toContainEqual(expect.objectContaining({ event: "job_persistence", stage: "settle", outcome: "unconfirmed" }));
    expect(h.deps.execute).toHaveBeenCalledOnce();
    expect(h.deps.fail).toHaveBeenCalledOnce();
    expect(records().every((record) => record.run_id === "run" && record.job_id === undefined)).toBe(true);
    expect(JSON.stringify(records())).not.toContain("PRIVATE_");
  });

  it("records the original failure before guarded original-only publication and preserves no-replay ambiguity", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const h = harness(true);
    h.attempts.push({ state: "ambiguous", page: 1, resultArtifactId: null, errorCode: "pdf_transcription_failed" });
    const publish = h.deps.repository.useWorkspaceOriginal.getMockImplementation()!;
    h.deps.repository.useWorkspaceOriginal.mockImplementation(async (...args) => {
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      expect(records).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "process", outcome: "failed", code: "pdf_transcription_failed" }));
      expect(records.some((record) => record.outcome === "degraded")).toBe(false);
      return publish(...args);
    });
    await h.coordinator().runOne();
    const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(records).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "process", outcome: "degraded", code: "pdf_transcription_failed" }));
    expect(records).toContainEqual(expect.objectContaining({ event: "job_persistence", stage: "complete", outcome: "confirmed" }));
    expect(h.deps.execute).not.toHaveBeenCalled();
  });

  it("does not report original-only success when its authority check rejects the degradation", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const h = harness(true);
    h.attempts.push({ state: "ambiguous", page: 1, resultArtifactId: null, errorCode: "pdf_transcription_failed" });
    h.deps.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
    await h.coordinator().runOne();
    const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(records).toContainEqual(expect.objectContaining({ event: "job_attempt", outcome: "failed", code: "pdf_transcription_failed" }));
    expect(records).toContainEqual(expect.objectContaining({ event: "job_attempt", outcome: "stale", code: "pdf_preparation_unavailable", level: "info" }));
    expect(records.some((record) => record.outcome === "degraded")).toBe(false);
    expect(h.deps.repository.useWorkspaceOriginal).not.toHaveBeenCalled();
  });

  it("retains the claim context when a heartbeat loses its lease and aborts the page", async () => {
    vi.useFakeTimers();
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const h = harness();
      h.deps.repository.heartbeat = async () => false;
      h.deps.execute.mockImplementation(() => new Promise(() => {}));
      const work = h.coordinator().runOne();
      await vi.advanceTimersByTimeAsync(CHAT_PDF_HEARTBEAT_MS);
      await work;
      const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
      const start = records.find((record) => record.event === "job_attempt" && record.stage === "claim");
      expect(records).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "heartbeat", outcome: "lost_lease",
        level: "info", run_id: "run", trace_id: start.trace_id }));
      expect(records.every((record) => record.job_id === undefined)).toBe(true);
      expect(h.deps.repository.publishDocument).not.toHaveBeenCalled();
      expect(h.deps.continueRun).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("observes a failed terminal settlement and preserves the rejection and release", async () => {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const h = harness();
    h.deps.execute.mockRejectedValue(new Error("PRIVATE_PROVIDER_CANARY"));
    const error = new Error("PRIVATE_TERMINAL_CANARY");
    h.deps.fail.mockRejectedValue(error);
    await expect(h.coordinator().runOne()).rejects.toBe(error);
    const records = writer.mock.calls.map(([chunk]) => JSON.parse(String(chunk)));
    expect(records).toContainEqual(expect.objectContaining({ event: "job_attempt", stage: "fail", outcome: "failed", run_id: "run" }));
    expect(h.deps.repository.release).toHaveBeenCalledOnce();
    expect(JSON.stringify(records)).not.toContain("PRIVATE_");
  });

  it("isolates a claimed PDF run from the request which starts processing", async () => {
    const h = harness();
    const execute = h.deps.execute.getMockImplementation()!;
    const seen: Array<ReturnType<typeof getContext>> = [];
    h.deps.execute.mockImplementation(async () => { seen.push(getContext()); return execute(); });
    let requestTrace: string | undefined;
    await runInBackground(() => runWithContext({ run_id: "request-run" }, async () => {
      requestTrace = getContext()!.trace_id;
      await h.coordinator().runOne();
      expect(getContext()!.run_id).toBe("request-run");
    }));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.run_id).toBe("run");
    expect(seen[0]?.trace_id).not.toBe(requestTrace);
    expect(seen[0]?.job_id).toBeUndefined();
  });

  it.each([[14, 120_000], [19, 300_000], [20, 300_000]])(
    "uses the accepted timeout policy for parser %s", async (parserVersion, timeoutMs) => {
      const h = harness();
      Object.assign(h.row.workPlan, { parserVersion });
      h.row.bindingSnapshot.connection.responseTimeoutMs = 300_000;
      await h.coordinator().runOne();
      expect(h.deps.fail).not.toHaveBeenCalled();
      expect(h.deps.execute).toHaveBeenCalledWith(expect.anything(), expect.anything(),
        expect.objectContaining({ timeoutMs }));
      expect(h.row.completedPages).toBe(1);
    }
  );

  it.each([false, true])("keeps successful Vision preparation with Workspace=%s", async (workspace) => {
    const h = harness(workspace); const worker = h.coordinator();
    await worker.runOne();
    expect(h.deps.fail).not.toHaveBeenCalled();
    expect(h.row.completedPages).toBe(1);
    expect(h.deps.continueRun).not.toHaveBeenCalled();
    expect(h.deps.attempts.recordUsage).toHaveBeenCalledOnce();
    expect(h.deps.repository.reserveArtifact.mock.invocationCallOrder[0]).toBeLessThan(h.deps.repository.completedPages.mock.invocationCallOrder[0]!);
    await h.coordinator().runOne();
    expect(h.row.state).toBe("ready");
    await h.coordinator().runOne();
    expect(h.deps.continueRun).toHaveBeenCalledOnce();
    expect(h.deps.execute).toHaveBeenCalledOnce();
  });

  it.each(["local text", "invalid Vision output", "transport", "recovered transport"])(
    "continues Workspace with its original after %s failure without replay", async (kind) => {
      const h = harness(true);
      if (kind === "local text") {
        h.row.route = "local_text"; h.row.workPlan.units = [];
        h.deps.core.assemble.mockImplementation(() => { throw new ChatPdfPreparationError("pdf_local_text_unusable"); });
      } else if (kind === "transport") {
        h.deps.execute.mockRejectedValue(new TypeError("fetch failed"));
      } else if (kind === "recovered transport") {
        h.attempts.push({ page: 1, state: "ambiguous", resultArtifactId: null, errorCode: "pdf_transcription_failed" });
      } else {
        h.deps.execute.mockResolvedValue({ finalText: "Unreadable output", usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 0 } });
      }
      await h.coordinator().runOne();
      expect(h.deps.fail).not.toHaveBeenCalled();
      expect(h.row.state).toBe("original_only");
      expect(h.deps.repository.useWorkspaceOriginal).toHaveBeenCalledOnce();
      expect(h.deps.continueRun).not.toHaveBeenCalled();
      const calls = h.deps.execute.mock.calls.length;
      await h.coordinator().runOne();
      expect(h.deps.continueRun).toHaveBeenCalledOnce();
      expect(h.deps.execute).toHaveBeenCalledTimes(calls);
      expect(h.deps.repository.publishDocument).not.toHaveBeenCalled();
    }
  );

  it.each(["ordinary run", "integrity", "authority", "credential", "authentication", "storage"])(
    "does not degrade a %s failure into Workspace success", async (kind) => {
      const h = harness(kind !== "ordinary run");
      h.deps.execute.mockResolvedValue({ finalText: "Unreadable output", usage: { inputTokens: 12, outputTokens: 8, reasoningTokens: 0 } });
      if (kind === "integrity") h.row.sourceChecksum = "b".repeat(64);
      if (kind === "authority") h.deps.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
      if (kind === "credential") h.deps.execute.mockRejectedValue(new Error("credential_revoked"));
      if (kind === "authentication") h.deps.execute.mockRejectedValue(Object.assign(new Error("unauthorized"), { status: 401 }));
      if (kind === "storage") vi.spyOn(h.deps.storage, "getObject").mockRejectedValue(new Error("object unavailable"));
      await h.coordinator().runOne();
      expect(h.deps.fail).toHaveBeenCalledOnce();
      expect(h.deps.repository.useWorkspaceOriginal).not.toHaveBeenCalled();
      expect(h.deps.continueRun).not.toHaveBeenCalled();
    }
  );

  it("does not replay a dispatched page after a worker restart", async () => {
    const h = harness(true);
    h.attempts.push({ state: "dispatched", page: 1, resultArtifactId: null, errorCode: null });
    await h.coordinator().runOne();
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.deps.continueRun).not.toHaveBeenCalled();
    expect(h.deps.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "pdf_preparation_ambiguous", retryable: true }));
  });

  it("keeps late reported usage after Stop without accepting a page or starting the answer", async () => {
    const h = harness(true);
    let resolve!: (value: Awaited<ReturnType<typeof h.deps.execute>>) => void;
    h.deps.execute.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const work = h.coordinator().runOne();
    await vi.waitFor(() => expect(h.deps.execute).toHaveBeenCalledOnce());
    h.controller.abort(); await work;
    resolve({ finalText: "late private text", usage: { inputTokens: 20, outputTokens: 5, reasoningTokens: 0 } });
    await vi.waitFor(() => expect(h.deps.attempts.recordUsage).toHaveBeenCalledOnce());
    expect(h.attempts[0]?.state).toBe("ambiguous");
    expect(h.row.completedPages).toBe(0);
    expect(h.deps.repository.reserveArtifact).not.toHaveBeenCalled();
    expect(h.deps.continueRun).not.toHaveBeenCalled();
    expect(h.deps.repository.useWorkspaceOriginal).not.toHaveBeenCalled();
  });
});
