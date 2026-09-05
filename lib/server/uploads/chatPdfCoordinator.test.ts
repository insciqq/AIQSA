// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { modelPdfPageEndMarker, modelPdfPageStartMarker } from "../parsing/modelPdfOutput";
import { createChatPdfCoordinator, type ChatPdfCoordinatorDependencies } from "./chatPdfCoordinator";
import { encodeChatPdfArtifact } from "./chatPdfCore";

function harness() {
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
    retryable: false, route: "selected_model_vision", sourceByteSize: 8, sourceChecksum: "a".repeat(64), state: "preparing",
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
      recordUsage: vi.fn(async () => undefined),
      ambiguous: vi.fn(async () => { if (attempts[0]?.state === "dispatched") attempts[0].state = "ambiguous"; }),
      settle: vi.fn(async (_dispatch, result) => { attempts[0] = { ...attempts[0]!, state: "settled", ...result }; })
    },
    repository: {
      claim: async () => alive ? claim : null, release: vi.fn(async () => undefined), heartbeat: async () => alive,
      load: async () => ({ modelRun: { chatPdfAttachments: [row] } }),
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
  it("accepts page bytes before progress, then assembles and continues the accepted answer", async () => {
    const h = harness(); const worker = h.coordinator();
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

  it("does not replay a dispatched page after a worker restart", async () => {
    const h = harness();
    h.attempts.push({ state: "dispatched", page: 1, resultArtifactId: null, errorCode: null });
    await h.coordinator().runOne();
    expect(h.deps.execute).not.toHaveBeenCalled();
    expect(h.deps.continueRun).not.toHaveBeenCalled();
    expect(h.deps.fail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "pdf_preparation_ambiguous", retryable: true }));
  });

  it("keeps late reported usage after Stop without accepting a page or starting the answer", async () => {
    const h = harness();
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
  });
});
