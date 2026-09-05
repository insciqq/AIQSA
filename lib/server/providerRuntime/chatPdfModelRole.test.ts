import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ProviderAdmissionRole } from "./admission";
import { createChatPdfModelRoleResolver } from "./chatPdfModelRole";
import { createSystemModelRoleResolver } from "./systemModelRole";

describe("independent Memory and document assignments", () => {
  it("admits a Vision-only PDF model alongside a non-Vision strict Memory model", async () => {
    const db = { systemModelPolicy: { findUnique: vi.fn(async () => ({
      providerModelId: "semantic", reasoningEffort: null, chatPdfProviderModelId: "document",
      chatPdfReasoningEffort: null, version: 4
    })) } } as unknown as PrismaClient;
    const loadRole = vi.fn(async (_db: unknown, { providerModelId }: { providerModelId: string }) => ({
      ...(providerModelId === "semantic" ? { verifiedStructuredOutput: true, verifiedForcedToolCall: true } : { verifiedVisionInput: true }),
      snapshot: { providerModelId, model: { capabilities: { nativePdfInput: false, reasoning: false } } }
    }) as unknown as ProviderAdmissionRole);
    expect(await createSystemModelRoleResolver(db, { loadRole }).resolve()).toMatchObject({ ok: true, providerModelId: "semantic" });
    expect(await createChatPdfModelRoleResolver(db, loadRole).resolve()).toMatchObject({ ok: true, providerModelId: "document" });
    expect(loadRole.mock.calls.map((call) => call[1].providerModelId)).toEqual(["semantic", "document"]);
  });
  it("does not substitute the Memory model when the assigned document capability is stale", async () => {
    const db = { systemModelPolicy: { findUnique: vi.fn(async () => ({
      providerModelId: "semantic", chatPdfProviderModelId: "document", chatPdfReasoningEffort: null, version: 4
    })) } } as unknown as PrismaClient;
    const loadRole = vi.fn(async () => ({ verifiedStructuredOutput: true, verifiedForcedToolCall: true,
      snapshot: { model: { capabilities: { vision: true } } }
    }) as unknown as ProviderAdmissionRole);
    expect(await createChatPdfModelRoleResolver(db, loadRole).resolve()).toEqual({ ok: false, code: "system_model_unavailable" });
    expect(loadRole).toHaveBeenCalledExactlyOnceWith(db, { providerModelId: "document" });
  });
});
