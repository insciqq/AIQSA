import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRunExecutionResponse } from "../runs/runExecution";
import { createFakeProviderAdapter } from "../providers/fakeProvider";
import type { MaterializedPreparedRunData } from "../runs/runPreparation";
import { createChatPdfRunContinuation, chatPdfRunSnapshot } from "./chatPdfRunContinuation";
import { CHAT_PDF_WORKSPACE_ORIGINAL_NOTICE, encodeChatPdfArtifact } from "./chatPdfCore";

vi.mock("../runs/runExecution", () => ({ createRunExecutionResponse: vi.fn(() => new Response("done")) }));

function fixture(workspace = false) {
  const adapter = createFakeProviderAdapter();
  const encoded = encodeChatPdfArtifact({ pageCount: 2, text: "The prepared document says that revenue is 42." });
  const sourceChecksum = createHash("sha256").update("original").digest("hex");
  const content = { blocks: [{ type: "text", text: "Read the PDF" }, { type: "file", attachmentId: "file" }] };
  const normalized = { attachmentIds: ["file"], chatId: "chat", content,
    ...(workspace ? { workspace: { enabled: true } } : {}),
    context: { messages: [{ id: "user", role: "user", content }], mode: "branch_path" },
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: { nativePdfInput: false, nativeSearch: false, pdf: true, vision: false, reasoning: false, contextWindow: 32000 },
    modelId: "frozen-answer", params: {}, prompt: { developer: null, system: null }, provider: "fake",
    searchPlan: { mode: "all_selected", options: [] }, toolMode: "none" };
  const prepared = { contextTruncation: null, defaults: null, expectedActiveLeafId: null,
    normalizedRequest: normalized, providerRequest: { ...normalized, attachments: [] }, providerRequestPreview: {},
    providerAdmissionPlan: {}, sourceKind: "send" } as unknown as MaterializedPreparedRunData;
  const created = { assistantMessageId: "assistant", runId: "run", userMessageId: "user" };
  const loaded = { snapshot: chatPdfRunSnapshot(prepared), admissionResult: created, state: "preparing",
    modelRun: { chatId: "chat", status: "preparing", normalizedRequest: null,
      workspaceRunBinding: workspace ? { modelRunId: "run" } : null,
      chatPdfAttachments: [{ attachmentId: "file", sourceChecksum, sourceByteSize: 8, state: "ready",
        pageCount: 2, route: "local_text", documentArtifactId: "document" }] } };
  const deps = {
    pdfRepository: { readArtifact: vi.fn(async () => ({ kind: "document", preparationGeneration: "run", sourceChecksum,
      route: "local_text", storageKey: "private/document", byteSize: encoded.body.length, checksum: encoded.checksum })),
      markAnswerDispatched: vi.fn(async () => true) },
    providerRuntime: { resolve: vi.fn(async () => ({ adapter })) },
    repository: { loadAttachments: vi.fn(async () => [{ id: "file", checksum: sourceChecksum, byteSize: 8,
      kind: "pdf", mimeType: "application/pdf", fileName: "report.pdf", status: "ready", storageKey: "private/original", metadata: {}, extractedText: null }]),
      continuePdfPreparedRun: vi.fn(async () => created) },
    storage: { getObject: vi.fn(async () => ({ body: encoded.body, contentType: "application/json", storageKey: "private/document" })) }
  };
  const input = { claim: { runId: "run", claimToken: "claim", userId: "owner" }, loaded,
    releaseRegistry: vi.fn(), signal: new AbortController().signal };
  const run = () => createChatPdfRunContinuation(deps as unknown as Parameters<typeof createChatPdfRunContinuation>[0])(
    input as unknown as Parameters<ReturnType<typeof createChatPdfRunContinuation>>[0]);
  return { deps, input, loaded, normalized, prepared, run };
}

describe("accepted PDF answer continuation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("materializes the owned document before the Memory gate and starts the frozen answer exactly once", async () => {
    const h = fixture(); await h.run();
    expect(h.deps.repository.continuePdfPreparedRun).toHaveBeenCalledOnce();
    const continuation = vi.mocked(createRunExecutionResponse).mock.calls[0]![0];
    expect(continuation.prepared.normalizedRequest.modelId).toBe("frozen-answer");
    expect(continuation.prepared.providerRequest.attachments[0]?.extractedText).toContain("revenue is 42");
    expect(h.deps.repository.continuePdfPreparedRun.mock.invocationCallOrder[0])
      .toBeLessThan(h.deps.pdfRepository.markAnswerDispatched.mock.invocationCallOrder[0]!);
    expect(h.input.releaseRegistry.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(createRunExecutionResponse).mock.invocationCallOrder[0]!);
    expect(JSON.stringify(continuation.prepared.providerRequest)).not.toContain("private/document");
    h.deps.pdfRepository.markAnswerDispatched.mockResolvedValue(false);
    await expect(h.run()).rejects.toThrow("pdf_preparation_unavailable");
    expect(createRunExecutionResponse).toHaveBeenCalledOnce();
  });

  it("resumes committed Memory readiness without repeating the Memory gate", async () => {
    const h = fixture();
    Object.assign(h.loaded, { state: "answer_ready" });
    Object.assign(h.loaded.modelRun, { status: "streaming", normalizedRequest: h.normalized });
    await h.run();
    expect(h.deps.repository.continuePdfPreparedRun).not.toHaveBeenCalled();
    expect(createRunExecutionResponse).toHaveBeenCalledOnce();
  });

  it.each(["preparing", "streaming"])("uses the original-only notice during %s continuation", async (status) => {
    const h = fixture(true);
    Object.assign(h.loaded.modelRun.chatPdfAttachments[0]!, { state: "original_only", documentArtifactId: null });
    if (status === "streaming") {
      Object.assign(h.loaded, { state: "answer_ready" });
      Object.assign(h.loaded.modelRun, { status, normalizedRequest: h.normalized });
    }
    await h.run();
    const continuation = vi.mocked(createRunExecutionResponse).mock.calls[0]![0];
    expect(continuation.prepared.providerRequest.attachments[0]?.extractedText).toBe(CHAT_PDF_WORKSPACE_ORIGINAL_NOTICE);
    expect(h.deps.pdfRepository.readArtifact).not.toHaveBeenCalled();
    expect(h.deps.storage.getObject).not.toHaveBeenCalled();
    expect(h.deps.repository.continuePdfPreparedRun).toHaveBeenCalledTimes(status === "preparing" ? 1 : 0);
  });

  it("rejects original-only continuation without accepted Workspace authority", async () => {
    const h = fixture(true);
    Object.assign(h.loaded.modelRun.chatPdfAttachments[0]!, { state: "original_only", documentArtifactId: null });
    h.loaded.modelRun.workspaceRunBinding = null;
    await expect(h.run()).rejects.toThrow("pdf_preparation_invalid");
    expect(h.deps.repository.continuePdfPreparedRun).not.toHaveBeenCalled();
    expect(createRunExecutionResponse).not.toHaveBeenCalled();
  });

  it("rejects generation substitution before Memory or answer dispatch", async () => {
    const h = fixture();
    const original = await h.deps.pdfRepository.readArtifact();
    h.deps.pdfRepository.readArtifact.mockResolvedValue({ ...original, preparationGeneration: "another-run" });
    await expect(h.run()).rejects.toThrow("pdf_preparation_invalid");
    expect(h.deps.repository.continuePdfPreparedRun).not.toHaveBeenCalled();
    expect(h.deps.pdfRepository.markAnswerDispatched).not.toHaveBeenCalled();
    expect(createRunExecutionResponse).not.toHaveBeenCalled();
  });

  it("stops before any answer side effect when the final document context does not fit", async () => {
    const h = fixture();
    h.prepared.providerRequest.prompt.system = "x".repeat(1000);
    h.prepared.normalizedRequest.modelCapabilities.contextWindow = 10;
    await expect(h.run()).rejects.toThrow("pdf_preparation_context_limit");
    expect(h.deps.repository.continuePdfPreparedRun).not.toHaveBeenCalled();
    expect(createRunExecutionResponse).not.toHaveBeenCalled();
  });
});
