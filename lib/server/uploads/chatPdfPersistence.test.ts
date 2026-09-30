import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { ProviderAdmissionRole } from "../providerRuntime/admission";
import { normalizeProviderExecutionSnapshot } from "../providers/runtimeFactory";
import { resolveChatPdfRoute } from "./chatPdfAdmission";
import { chatPdfCompatibilityKey } from "./chatPdfCore";
import { chatPdfAdmissionFromRow, insertChatPdfAdmissions } from "./chatPdfPersistence";

describe("chat PDF admission persistence", () => {
  it("stores and hashes the canonical accepted snapshot with its verified capabilities", async () => {
    const capabilities = { nativePdfInput: true, nativeSearch: false, pdf: true, reasoning: false,
      vision: true, structuredOutput: true, forcedToolCalling: true, validatedAutoToolCalling: true };
    const answer: ProviderAdmissionRole = {
      credentialSource: "default", authority: { connectionId: "connection", connectionVersion: 1,
        credentialId: "credential", credentialVersionId: "version", providerModelId: "model", modelVersion: 1 },
      modelConfiguration: { adapterKind: "openai_responses_compatible", capabilities, defaultParams: {} },
      snapshot: {
        connection: { allowPrivateNetwork: false, apiRoot: "https://pdf.example.test/v1/",
          authenticationMode: "bearer", responseTimeoutMs: 120_000 },
        connectionDisplayName: " Fixture ", connectionId: "connection", credentialId: "credential",
        credentialVersionId: "version", modelDisplayName: " Fixture ", providerFamily: "openai_compatible",
        providerModelId: "model", version: 1,
        model: { adapterKind: "openai_responses_compatible", answerSelectable: true,
          capabilities, defaultParams: {}, modelClass: "answer", upstreamModelId: " fixture-model " }
      }
    };
    const admitted = { ...resolveChatPdfRoute({ answer, mode: "prefer_chat_model", fallbackMethod: "page_images",
      policyVersion: 1, system: null }), attachmentId: "attachment", byteSize: 10, pageCount: 2,
      sourceChecksum: "a".repeat(64) };
    const create = vi.fn().mockResolvedValue(undefined);
    const tx = { chatPdfAttachmentPreparation: { create }, systemModelPolicy: {
      findUnique: vi.fn().mockResolvedValue({ chatPdfProcessingMode: "PREFER_CHAT_MODEL", chatPdfFallbackMethod: "PAGE_IMAGES", version: 1 })
    } } as unknown as Prisma.TransactionClient;

    await insertChatPdfAdmissions(tx, { admissions: [admitted], answer, runId: "run" });

    const row = create.mock.calls[0]![0].data;
    const canonical = { ...admitted, snapshot: normalizeProviderExecutionSnapshot(admitted.snapshot) };
    expect(row.bindingSnapshot).toEqual(canonical.snapshot);
    expect(row.compatibilityKey).toBe(chatPdfCompatibilityKey(canonical));
    const restored = chatPdfAdmissionFromRow(row);
    expect(restored).toEqual(canonical);
    expect(chatPdfCompatibilityKey(restored)).toBe(row.compatibilityKey);
    expect(row.bindingSnapshot.model.capabilities).toMatchObject({
      structuredOutput: true, forcedToolCalling: true, validatedAutoToolCalling: true
    });
  });
});
