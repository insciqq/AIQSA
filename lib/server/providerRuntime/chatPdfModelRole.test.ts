import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ProviderAdmissionRole } from "./admission";
import { createChatPdfModelRoleResolver } from "./chatPdfModelRole";
import { createSystemModelRoleResolver } from "./systemModelRole";

describe("independent Memory and document assignments", () => {
  it("resolves independent PDF and image assignments and rejects unsupported native input", async () => {
    const policy = { chatPdfNativeProviderModelId: "native", chatPdfNativeReasoningEffort: "low",
      chatPdfProviderModelId: "images", chatPdfReasoningEffort: "high", version: 8 };
    const db = { systemModelPolicy: { findUnique: async () => policy } } as unknown as PrismaClient;
    const loadRole = vi.fn(async (_db: unknown, { providerModelId }: { providerModelId: string }) => ({
      verifiedVisionInput: providerModelId === "images",
      snapshot: { providerModelId, providerFamily: "openrouter", model: {
        adapterKind: "openrouter_chat_completions", upstreamModelId: "google/gemini-3.8-flash",
        capabilities: { nativePdfInput: providerModelId === "native", reasoning: true }, defaultParams: {}
      } }
    }) as unknown as ProviderAdmissionRole);
    const resolver = createChatPdfModelRoleResolver(db, loadRole);
    expect(await resolver.resolve("pdf_reader")).toMatchObject({ ok: true, providerModelId: "native", reasoningEffort: "low", policyVersion: 8 });
    expect(await resolver.resolve("page_images")).toMatchObject({ ok: true, providerModelId: "images", reasoningEffort: "high", policyVersion: 8 });
    policy.chatPdfNativeProviderModelId = "images";
    expect(await resolver.resolve("pdf_reader")).toEqual({ ok: false, code: "system_model_unavailable" });
  });

  it.each(["low", "high"])("admits configured %s reasoning without a redundant capability list", async (effort) => {
    const db = { systemModelPolicy: { findUnique: vi.fn(async () => ({
      providerModelId: "semantic", reasoningEffort: effort, chatPdfProviderModelId: "document",
      chatPdfReasoningEffort: effort, version: 4
    })) } } as unknown as PrismaClient;
    const loadRole = vi.fn(async (_db: unknown, { providerModelId }: { providerModelId: string }) => ({
      verifiedStructuredOutput: true, verifiedForcedToolCall: true, verifiedVisionInput: true,
      snapshot: { providerModelId, providerFamily: "openrouter", model: {
        adapterKind: "openrouter_chat_completions", upstreamModelId: "google/gemini-3.8-flash",
        capabilities: { reasoning: true }, defaultParams: { reasoning: { effort: "medium" } }
      } }
    }) as unknown as ProviderAdmissionRole);
    expect(await createSystemModelRoleResolver(db, { loadRole }).resolve()).toMatchObject({ ok: true, reasoningEffort: effort });
    expect(await createChatPdfModelRoleResolver(db, loadRole).resolve()).toMatchObject({ ok: true, reasoningEffort: effort });
  });

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
