// @vitest-environment node
import { createHash } from "node:crypto";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import { modelPdfPageEndMarker, modelPdfPageStartMarker } from "../parsing/modelPdfOutput";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { isLongChatPdf, decodeChatPdfPreparation } from "../../contracts/chatPdfPreparation";
import { chatPdfFingerprint, resolveChatPdfRoute, type ChatPdfAttachmentAdmission } from "./chatPdfAdmission";
import { createChatPdfCore, decodeChatPdfArtifact, encodeChatPdfArtifact } from "./chatPdfCore";

function role(verifiedVisionInput = false, nativePdfInput = false): ProviderAdmissionRole {
  const capabilities = { nativePdfInput, nativeSearch: false, pdf: true, reasoning: false,
    vision: true, contextWindow: 128_000, defaultMaxOutputTokens: 4096 };
  return {
    authority: { connectionId: "connection", connectionVersion: 1, credentialId: "credential",
      credentialVersionId: "version", providerModelId: "model", modelVersion: 1 },
    credentialSource: "default",
    ...(verifiedVisionInput ? { verifiedVisionInput: true } : {}),
    modelConfiguration: { adapterKind: "openai_responses_compatible", capabilities, defaultParams: {} },
    snapshot: {
      connection: { allowPrivateNetwork: false, apiRoot: "https://pdf.example.test/v1",
        authenticationMode: "bearer", responseTimeoutMs: 120_000 },
      connectionDisplayName: "Fixture", connectionId: "connection", credentialId: "credential",
      credentialVersionId: "version", modelDisplayName: "Fixture", providerFamily: "openai_compatible",
      providerModelId: "model", version: 1,
      model: { adapterKind: "openai_responses_compatible", answerSelectable: true,
        capabilities, defaultParams: {}, modelClass: "answer", upstreamModelId: "fixture-model" }
    }
  };
}

async function source() {
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 200]).drawText("Page one with usable native text.", { size: 8, x: 8, y: 180 });
  pdf.addPage([200, 200]).drawText("Page two with usable native text.", { size: 8, x: 8, y: 180 });
  return Buffer.from(await pdf.save());
}

function admission(bytes: Buffer, local = false): ChatPdfAttachmentAdmission {
  return { ...resolveChatPdfRoute({ answer: role(!local), system: null, systemAllowed: false }),
    attachmentId: "attachment", byteSize: bytes.length, pageCount: null,
    sourceChecksum: createHash("sha256").update(bytes).digest("hex") };
}

function pageResult(page: number, text: string) {
  return { page, text: [modelPdfPageStartMarker(page), text, modelPdfPageEndMarker(page)].join("\n") };
}

describe("chat PDF admission and artifacts", () => {
  it("chooses exact verified routes in priority order and keeps the answer binding separate", () => {
    const system = { credentialScope: "installation" as const, ok: true as const,
      policyVersion: 2, providerModelId: "model", reasoningEffort: null, role: role(true) };
    expect(resolveChatPdfRoute({ answer: role(true, true), system, systemAllowed: true }).route).toBe("direct_pdf");
    expect(resolveChatPdfRoute({ answer: role(true), system, systemAllowed: true }).route).toBe("system_vision");
    expect(resolveChatPdfRoute({ answer: role(true), system, systemAllowed: false }).route).toBe("selected_model_vision");
    expect(resolveChatPdfRoute({ answer: role(), system: { ...system, role: role() }, systemAllowed: true }).route)
      .toBe("local_text");
    const selected = role(true);
    expect(resolveChatPdfRoute({ answer: selected, system: null, systemAllowed: false }).snapshot)
      .toBe(selected.snapshot);
  });

  it("does not confuse a twenty-page advisory with routing or safety limits", () => {
    expect([null, 0, 20, 21, 500].map(isLongChatPdf)).toEqual([false, false, false, true, true]);
    const value = { completedPages: 3, limitedReadingQuality: true, longDocument: true,
      pageCount: 21, phase: "preparing", retryable: false, route: "local_text" };
    expect(decodeChatPdfPreparation({ ...value, storageKey: "private", credentialId: "private" })).toEqual(value);
    expect(decodeChatPdfPreparation({ ...value, completedPages: 22 })).toBeNull();
    expect(decodeChatPdfPreparation({ ...value, pageCount: 20 })).toBeNull();
  });

  it("authenticates complete artifact bytes and rejects swapped, corrupt, and unsupported content", () => {
    const encoded = encodeChatPdfArtifact({ pageCount: 2, blocks: ["A", "B"] });
    expect(decodeChatPdfArtifact(encoded.body, { checksum: encoded.checksum, byteSize: encoded.body.length }))
      .toEqual({ pageCount: 2, blocks: ["A", "B"] });
    expect(() => decodeChatPdfArtifact(encoded.body, { checksum: "0".repeat(64), byteSize: encoded.body.length })).toThrow();
    expect(() => decodeChatPdfArtifact(encoded.body, { checksum: encoded.checksum, byteSize: 1 })).toThrow();
    expect(chatPdfFingerprint({ x: 1, y: 2 })).toBe(chatPdfFingerprint({ y: 2, x: 1 }));
  });
});

describe("chat PDF adaptive preparation", () => {
  it("discovers pages before slow inspection and prepares bounded isolated requests with real native rendering", async () => {
    const bytes = await source();
    const core = createChatPdfCore({ parseDocling: null });
    const admitted = admission(bytes);
    const count = vi.fn().mockResolvedValue(undefined);
    const planned = await core.plan({ admission: admitted, bytes, onPageCount: count });
    expect(count).toHaveBeenCalledWith(2);
    expect(planned.plan.units.map(({ page, route }) => [page, route])).toEqual([
      [1, "vision_required"], [2, "vision_required"]
    ]);
    const work = await core.page({ admission: admitted, bytes, ...planned, page: 1 });
    expect(work.request).toMatchObject({ forceNonStreaming: true, toolChoice: "none", toolMode: "none",
      tools: [], searchPlan: { options: [] }, knowledgePlan: { mode: "none" } });
    expect(work.request.attachments).toHaveLength(1);
    expect(work.request.attachments[0]!.byteSize).toBeLessThanOrEqual(planned.plan.limits.imageBytes);
    expect(work.request.modelId).toBe(admitted.snapshot!.model.upstreamModelId);
    const results = [pageResult(2, "Second page result."), pageResult(1, "First page result.")];
    const document = core.assemble({ admission: admitted, ...planned, results });
    expect(document.pageCount).toBe(2);
    expect(document.text).toContain("First page result.");
    expect(document.text.indexOf("First page result.")).toBeLessThan(document.text.indexOf("Second page result."));
    expect(() => core.assemble({ admission: admitted, ...planned, results: results.slice(1) })).toThrow();
    expect(() => core.assemble({ admission: admitted, ...planned, results: [pageResult(1, "bad"), pageResult(1, "bad")] })).toThrow();
  }, 20_000);

  it("freezes tighter exact-model limits and refuses an oversized image before provider work", async () => {
    const bytes = await source();
    const original = admission(bytes);
    const admitted = { ...original, snapshot: { ...original.snapshot!, model: { ...original.snapshot!.model,
      capabilities: { ...original.snapshot!.model.capabilities, imageInputLimits: {
        imageBytes: 9000000, imageCount: 1, imagePixels: 1, payloadBytes: 9000000
      } } } } };
    const core = createChatPdfCore({ parseDocling: null });
    const planned = await core.plan({ admission: admitted, bytes, onPageCount: async () => undefined });
    expect(planned.plan.limits).toMatchObject({ imageBytes: 2097152, imageCount: 1, imagePixels: 1 });
    await expect(core.page({ admission: admitted, bytes, ...planned, page: 1 }))
      .rejects.toThrow("pdf_preparation_invalid");
  }, 20000);

  it("uses local text only for an admitted local route and refuses a silent Vision downgrade", async () => {
    const bytes = await source();
    const core = createChatPdfCore({ parseDocling: null });
    const admitted = admission(bytes, true);
    const planned = await core.plan({ admission: admitted, bytes, onPageCount: async () => undefined });
    expect(core.assemble({ admission: admitted, ...planned, results: [] }).text).toContain("usable native text");
    expect(() => core.assemble({ admission: { ...admitted, route: "selected_model_vision" }, ...planned, results: [] })).toThrow();
    expect(() => core.assemble({ admission: admitted, ...planned, local: { ...planned.local, geometry: null }, results: [] }))
      .toThrow("pdf_local_text_unusable");
  }, 20_000);

  it("fences cancelled work and rejects source substitution before parser or provider work", async () => {
    const bytes = await source();
    const inspect = vi.fn();
    const core = createChatPdfCore({ inspect, parseDocling: null });
    await expect(core.plan({ admission: admission(bytes), bytes: Buffer.from("different"), onPageCount: vi.fn() }))
      .rejects.toThrow("pdf_preparation_invalid");
    const controller = new AbortController();
    controller.abort();
    await expect(core.plan({ admission: admission(bytes), bytes, onPageCount: vi.fn(), signal: controller.signal }))
      .rejects.toThrow();
    expect(inspect).not.toHaveBeenCalled();
  });
});
