import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { buildGeminiInteractionsRequest } from "../providers/geminiInteractionsRequest";
import type { ProviderRunRequest } from "../providers/types";
import { ProviderAdmissionError, type ProviderAdmissionRole } from "./admission";
import {
  applySystemModelReasoningEffort,
  createSystemModelRoleResolver,
  SYSTEM_MODEL_ABSENT,
  SYSTEM_MODEL_UNAVAILABLE
} from "./systemModelRole";

const role = {
  verifiedStructuredOutput: true,
  verifiedForcedToolCall: true,
  credentialSource: "default",
  modelConfiguration: {
    adapterKind: "openai_responses_compatible",
    capabilities: { reasoning: true, reasoningEfforts: ["low", "xhigh"] },
    defaultParams: {}
  },
  snapshot: {
    model: { capabilities: { reasoning: true, reasoningEfforts: ["low", "xhigh"] } },
    providerModelId: "model-1"
  }
} as unknown as ProviderAdmissionRole;

function database(policy: unknown) {
  return {
    systemModelPolicy: {
      findUnique: vi.fn().mockResolvedValue(policy)
    }
  } as unknown as PrismaClient;
}

describe("system model role resolver", () => {
  it("maps an Anthropic Memory effort to thinking and output configuration", () => {
    const snapshot = { model: { adapterKind: "anthropic_messages", defaultParams: {
      thinking: { enabled: true, type: "adaptive", budgetTokens: 0 },
      outputConfig: { effort: "high" }
    } } } as unknown as ProviderAdmissionRole["snapshot"];
    const off = applySystemModelReasoningEffort(snapshot, "none");
    expect(off.model.defaultParams).toMatchObject({
      thinking: { enabled: false, type: "adaptive" }, outputConfig: { effort: "high" }
    });
    const low = applySystemModelReasoningEffort(snapshot, "low");
    expect(low.model.defaultParams).toMatchObject({
      thinking: { enabled: true, type: "adaptive" }, outputConfig: { effort: "low" }
    });
    expect(low.model.defaultParams).not.toHaveProperty("reasoning");
  });
  it("returns the stable absent code for a missing or empty installation role", async () => {
    const loadRole = vi.fn();
    await expect(createSystemModelRoleResolver(database(null), { loadRole }).resolve())
      .resolves.toEqual({ code: SYSTEM_MODEL_ABSENT, ok: false });
    await expect(createSystemModelRoleResolver(database({
      providerModelId: null,
      reasoningEffort: null,
      updatedByUserId: null,
      version: 1
    }), { loadRole }).resolve()).resolves.toEqual({ code: SYSTEM_MODEL_ABSENT, ok: false });
    expect(loadRole).not.toHaveBeenCalled();
  });

  it.each([
    { authorState: "inactive", updatedByUserId: "admin-inactive" },
    { authorState: "demoted", updatedByUserId: "admin-demoted" },
    { authorState: "deleted", updatedByUserId: null }
  ])(
    "resolves through installation authority when the policy author is $authorState",
    async ({ updatedByUserId }) => {
      const loadRole = vi.fn().mockResolvedValue(role);
      await expect(createSystemModelRoleResolver(database({
        providerModelId: "model-1",
        reasoningEffort: "xhigh",
        updatedByUserId,
        version: 2
      }), { loadRole }).resolve()).resolves.toEqual({
        credentialScope: "installation",
        ok: true,
        policyVersion: 2,
        providerModelId: "model-1",
        reasoningEffort: "xhigh",
        role
      });
      expect(loadRole).toHaveBeenCalledWith(expect.anything(), {
        providerModelId: "model-1"
      });
    }
  );

  it.each([
    ["target", "model_not_available"],
    ["installation credential", "credential_default_missing"]
  ] as const)(
    "normalizes an unavailable %s without substituting",
    async (_subject, code) => {
      const loadRole = vi.fn().mockRejectedValue(
        new ProviderAdmissionError(code)
      );
      await expect(createSystemModelRoleResolver(database({
        providerModelId: "model-1",
        reasoningEffort: null,
        updatedByUserId: "admin-1",
        version: 3
      }), { loadRole }).resolve()).resolves.toEqual({
        code: SYSTEM_MODEL_UNAVAILABLE,
        ok: false
      });
      expect(loadRole).toHaveBeenCalledWith(expect.anything(), {
        providerModelId: "model-1"
      });
    }
  );

  it("returns the exact deployment role and installation credential scope", async () => {
    const loadRole = vi.fn().mockResolvedValue(role);
    await expect(createSystemModelRoleResolver(database({
      providerModelId: "model-1",
      reasoningEffort: "xhigh",
      updatedByUserId: "admin-1",
      version: 7
    }), { loadRole }).resolve()).resolves.toEqual({
      credentialScope: "installation",
      ok: true,
      policyVersion: 7,
      providerModelId: "model-1",
      reasoningEffort: "xhigh",
      role
    });
  });

  describe("Memory or System role on gemini-3.8-flash", () => {
    const geminiModel = {
      adapterKind: "gemini_interactions_native",
      capabilities: {
        nativePdfInput: false, nativeSearch: true, pdf: true, reasoning: true, toolCalling: true, vision: true
      },
      defaultParams: { reasoning: { effort: "medium" } },
      upstreamModelId: "gemini-3.8-flash"
    };
    const geminiRole = {
      ...role,
      snapshot: { model: geminiModel, providerFamily: "gemini", providerModelId: "gemini-row" }
    } as unknown as ProviderAdmissionRole;
    const providerRequest = (snapshot: ProviderAdmissionRole["snapshot"]): ProviderRunRequest => ({
      attachmentIds: [],
      attachments: [],
      chatId: "memory-role",
      content: { blocks: [{ text: "Classify.", type: "text" }] },
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      modelCapabilities: snapshot.model.capabilities,
      modelId: snapshot.model.upstreamModelId,
      params: { ...snapshot.model.defaultParams, stream: false },
      prompt: { developer: null, system: "Return the result." },
      provider: "gemini",
      searchPlan: { mode: "all_selected", options: [] },
      toolMode: "none"
    });

    it("cannot resolve a minimal policy effort the catalog controls exclude", async () => {
      const loadRole = vi.fn().mockResolvedValue(geminiRole);
      await expect(createSystemModelRoleResolver(database({
        providerModelId: "gemini-row", reasoningEffort: "minimal", updatedByUserId: "admin-1", version: 3
      }), { loadRole }).resolve()).resolves.toEqual({ code: SYSTEM_MODEL_UNAVAILABLE, ok: false });
      await expect(createSystemModelRoleResolver(database({
        providerModelId: "gemini-row", reasoningEffort: "low", updatedByUserId: "admin-1", version: 4
      }), { loadRole }).resolve()).resolves.toMatchObject({ ok: true, reasoningEffort: "low" });
    });

    it("sends the resolved role effort and refuses a stale saved minimal default before dispatch", () => {
      const applied = applySystemModelReasoningEffort(geminiRole.snapshot, "low");
      expect(buildGeminiInteractionsRequest(providerRequest(applied)).generation_config.thinking_level).toBe("low");
      expect(buildGeminiInteractionsRequest(providerRequest(applySystemModelReasoningEffort(geminiRole.snapshot, null)))
        .generation_config.thinking_level).toBe("medium");
      const stale = { ...geminiRole.snapshot, model: { ...geminiModel, defaultParams: { reasoning: { effort: "minimal" } } } } as
        unknown as ProviderAdmissionRole["snapshot"];
      expect(() => buildGeminiInteractionsRequest(providerRequest(applySystemModelReasoningEffort(stale, null))))
        .toThrow("gemini_interactions_reasoning_effort_unsupported");
    });
  });

  it("fails closed when a retained reasoning effort is no longer advertised", async () => {
    const loadRole = vi.fn().mockResolvedValue(role);
    await expect(createSystemModelRoleResolver(database({
      providerModelId: "model-1",
      reasoningEffort: "max",
      updatedByUserId: "admin-1",
      version: 8
    }), { loadRole }).resolve()).resolves.toEqual({
      code: SYSTEM_MODEL_UNAVAILABLE,
      ok: false
    });
  });
});
