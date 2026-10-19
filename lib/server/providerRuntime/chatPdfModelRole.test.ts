import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ProviderAdmissionRole } from "./admission";
import { createChatPdfModelRoleResolver } from "./chatPdfModelRole";
import { createSystemModelRoleResolver } from "./systemModelRole";
import { resolveChatPdfRoute } from "../uploads/chatPdfAdmission";
import { buildDeepSeekResponsesRequest } from "../providers/deepSeekResponsesRequest";
import type { ProviderRunRequest } from "../providers/types";

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
  describe("reader reasoning without an explicit setting", () => {
    const deepSeek = { adapterKind: "deepseek_responses_native", providerFamily: "deepseek", upstreamModelId: "deepseek-flash",
      capabilities: { nativePdfInput: true, reasoning: true, vision: true } };
    const lowOnly = { adapterKind: "openai_responses_compatible", providerFamily: "openai_compatible", upstreamModelId: "custom-reader",
      capabilities: { nativePdfInput: true, reasoning: true, reasoningEfforts: ["low", "medium", "high"], vision: true } };
    const plain = { adapterKind: "openai_responses_compatible", providerFamily: "openai_compatible", upstreamModelId: "custom-reader",
      capabilities: { nativePdfInput: true, reasoning: false, vision: true } };
    function resolver(deployment: typeof deepSeek | typeof lowOnly | typeof plain, effort: string | null) {
      const db = { systemModelPolicy: { findUnique: async () => ({ chatPdfNativeProviderModelId: "native",
        chatPdfNativeReasoningEffort: effort, chatPdfProviderModelId: "images", chatPdfReasoningEffort: effort, version: 3 }) } } as unknown as PrismaClient;
      return createChatPdfModelRoleResolver(db, vi.fn(async (_db: unknown, { providerModelId }: { providerModelId: string }) => ({
        verifiedVisionInput: true,
        snapshot: { providerModelId, providerFamily: deployment.providerFamily, model: {
          adapterKind: deployment.adapterKind, upstreamModelId: deployment.upstreamModelId,
          capabilities: deployment.capabilities, defaultParams: {} } }
      }) as unknown as ProviderAdmissionRole));
    }

    it.each([
      ["a deployment offering none", deepSeek, null, "none"],
      ["a deployment whose lowest level is low", lowOnly, null, "low"],
      ["a model without reasoning", plain, null, null],
      ["an explicit administrator choice", deepSeek, "high", "high"]
    ] as const)("resolves %s for both reader methods", async (_name, deployment, configured, expected) => {
      const resolve = resolver(deployment, configured);
      expect(await resolve.resolve("pdf_reader")).toMatchObject({ ok: true, reasoningEffort: expected });
      expect(await resolve.resolve("page_images")).toMatchObject({ ok: true, reasoningEffort: expected });
    });

    it("freezes the resolved effort into the admitted DeepSeek reader request", async () => {
      const resolved = await resolver(deepSeek, null).resolve("page_images");
      const answer = { snapshot: { modelDisplayName: "Answer", model: { capabilities: { nativePdfInput: false } } } } as unknown as ProviderAdmissionRole;
      const admission = resolveChatPdfRoute({ answer, mode: "read_page_images", policyVersion: 3, strictPolicy: true, system: resolved });
      expect(admission.route).toBe("system_vision");
      expect(admission.snapshot?.model.defaultParams).toMatchObject({ reasoning: { effort: "none", enabled: false } });
      const body = buildDeepSeekResponsesRequest({ attachmentIds: [], attachments: [], chatId: "chat-pdf-transcription",
        content: { blocks: [{ text: "Transcribe.", type: "text" }] }, forceNonStreaming: true,
        modelId: "deepseek-flash", params: admission.snapshot!.model.defaultParams, prompt: { developer: null, system: null },
        provider: "deepseek", searchPlan: { mode: "all_selected", options: [] }, toolChoice: "none", toolMode: "none",
        tools: [] } as unknown as ProviderRunRequest);
      expect(body.reasoning).toEqual({ effort: "none" });
    });
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
