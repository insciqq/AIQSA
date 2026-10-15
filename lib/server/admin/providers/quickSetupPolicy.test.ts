import { describe, expect, it } from "vitest";
import {
  ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION,
  adminProviderQuickSetupPolicy,
  decideAdminProviderQuickSetupModel
} from "./quickSetupPolicy";

describe("provider Quick setup policy", () => {
  it("keeps the current-model candidates, defaults, and recommendations explicit", () => {
    expect(ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION).toBe(10);
    expect(adminProviderQuickSetupPolicy("openai").connection.configuration.responseTimeoutMs)
      .toBe(300_000);
    const definitions = (provider: Parameters<typeof adminProviderQuickSetupPolicy>[0]) =>
      adminProviderQuickSetupPolicy(provider).candidates.map((candidate) => ({
        id: candidate.candidateId,
        ...(candidate.legacy ? { legacy: true } : {}),
        recommended: candidate.recommended,
        templateKey: candidate.templateKey
      }));
    expect(definitions("openai")).toEqual([
      { id: "p10-o8", recommended: true, templateKey: "openai:gpt-6.1-sol" },
      { id: "p9-o6", recommended: false, templateKey: "openai:gpt-6-sol" },
      { id: "p9-o7", recommended: false, templateKey: "openai:gpt-6-luna" },
      { id: "p7-o4", recommended: false, templateKey: "openai:gpt-6-astra" },
      { id: "p2-o3", legacy: true, recommended: false, templateKey: "openai:gpt-5.6-sol" },
      { id: "p2-o1", legacy: true, recommended: false, templateKey: "openai:gpt-5.6-terra" },
      { id: "p2-o2", legacy: true, recommended: false, templateKey: "openai:gpt-5.6-luna" },
      { id: "p7-o5", legacy: true, recommended: false, templateKey: "openai:gpt-5.5" }
    ]);
    expect(definitions("anthropic")).toEqual([
      { id: "p9-a5", recommended: true, templateKey: "anthropic:claude-opus-5-5" },
      { id: "p10-a6", recommended: false, templateKey: "anthropic:claude-sonnet-5-5" },
      { id: "p10-a7", recommended: false, templateKey: "anthropic:claude-haiku-5-5" },
      { id: "p7-a3", recommended: false, templateKey: "anthropic:claude-fable-5-1" },
      { id: "p2-a1", legacy: true, recommended: false, templateKey: "anthropic:claude-opus-5" },
      { id: "p2-a2", legacy: true, recommended: false, templateKey: "anthropic:claude-sonnet-5" },
      { id: "p7-a4", legacy: true, recommended: false, templateKey: "anthropic:claude-opus-4-8" }
    ]);
    expect(definitions("gemini")).toEqual([
      { id: "p2-g1", recommended: true, templateKey: "gemini:gemini-3.8-flash" },
      { id: "p10-g6", recommended: false, templateKey: "gemini:gemini-4-argon" },
      { id: "p2-g3", recommended: false, templateKey: "gemini:gemini-3.5-flash-lite" },
      { id: "p7-g5", legacy: true, recommended: false, templateKey: "gemini:gemini-3.6-flash" },
      { id: "p2-g2", legacy: true, recommended: false, templateKey: "gemini:gemini-3.5-flash" },
      { id: "p2-g4", legacy: true, recommended: false, templateKey: "gemini:gemini-3.1-pro-preview" }
    ]);
    expect(definitions("openrouter")).toEqual([
      { id: "p9-r7", recommended: true, templateKey: "openrouter:anthropic/claude-opus-5.5" },
      { id: "p10-r12", recommended: false, templateKey: "openrouter:anthropic/claude-sonnet-5.5" },
      { id: "p10-r13", recommended: false, templateKey: "openrouter:anthropic/claude-haiku-5.5" },
      { id: "p10-r14", recommended: false, templateKey: "openrouter:openai/gpt-6.1-sol" },
      { id: "p10-r15", recommended: false, templateKey: "openrouter:openai/gpt-6.1-sol-pro" },
      { id: "p10-r16", recommended: false, templateKey: "openrouter:google/gemini-4-argon" },
      { id: "p9-r8", recommended: false, templateKey: "openrouter:openai/gpt-6-sol" },
      { id: "p9-r9", recommended: false, templateKey: "openrouter:openai/gpt-6-luna" },
      { id: "p9-r10", recommended: false, templateKey: "openrouter:openai/gpt-6-sol-pro" },
      { id: "p9-r11", recommended: false, templateKey: "openrouter:openai/gpt-6-luna-pro" },
      { id: "p1-r2", recommended: false, templateKey: "openrouter:google/gemini-3.8-flash" },
      { id: "p1-r3", recommended: false, templateKey: "openrouter:deepseek/deepseek-v4-pro-0813" },
      { id: "p8-r6", recommended: false, templateKey: "openrouter:deepseek/deepseek-v4.1-flash" },
      { id: "p7-r4", recommended: false, templateKey: "openrouter:anthropic/claude-fable-5.1" },
      { id: "p7-r5", recommended: false, templateKey: "openrouter:openai/gpt-6-astra" },
      { id: "p7-r-search", recommended: false, templateKey: "openrouter:perplexity/sonar-pro-search" },
      { id: "p1-r1", legacy: true, recommended: false, templateKey: "openrouter:anthropic/claude-opus-5" }
    ]);
    expect(definitions("deepseek")).toEqual([
      { id: "p8-d4", recommended: true, templateKey: "deepseek:deepseek-flash" },
      { id: "p6-d1", recommended: false, templateKey: "deepseek:deepseek-v4-pro" }
    ]);
    expect(adminProviderQuickSetupPolicy("openrouter").candidates.find(
      ({ templateKey }) => templateKey.includes("perplexity/sonar-pro-search")
    )).toMatchObject({ configuration: { answerSelectable: false } });
  });

  it("ignores remote ordering and picks the code-owned recommendation", () => {
    const policy = adminProviderQuickSetupPolicy("openai");
    for (const modelIds of [
      ["gpt-6-sol", "gpt-6.1-sol", "gpt-6-luna"],
      ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"]
    ]) {
      const decision = decideAdminProviderQuickSetupModel({ modelIds, policy });
      expect(decision.kind).toBe("selected");
      if (decision.kind === "selected") expect(decision.candidate.candidateId).toBe("p10-o8");
    }
  });

  it("chooses the first supported fallback without another user action", () => {
    const decision = decideAdminProviderQuickSetupModel({
      modelIds: ["unknown/new-model", "gpt-6-astra", "gpt-6-luna"],
      policy: adminProviderQuickSetupPolicy("openai")
    });
    expect(decision).toMatchObject({
      candidate: { candidateId: "p9-o7", displayName: "GPT-6 Luna" },
      kind: "selected"
    });
  });

  it("never selects a legacy candidate, by recommendation, fallback or explicit choice", () => {
    const openai = adminProviderQuickSetupPolicy("openai");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], policy: openai
    })).toEqual({ kind: "unsupported_catalog" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["gpt-5.6-terra", "gpt-6-sol"], policy: openai
    })).toMatchObject({ candidate: { candidateId: "p9-o6" }, kind: "selected" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["gpt-5.6-terra"], policy: openai, selectedModel: { candidateId: "p2-o1", policyVersion: 10 }
    })).toEqual({ kind: "selection_invalid" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["anthropic/claude-opus-5", "google/gemini-3.8-flash"], policy: adminProviderQuickSetupPolicy("openrouter")
    })).toMatchObject({ candidate: { candidateId: "p1-r2" }, kind: "selected" });
  });

  it("requires an exact policy-owned selected candidate observed by the repeated check", () => {
    const policy = adminProviderQuickSetupPolicy("openrouter");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["google/gemini-3.8-flash"],
      policy,
      selectedModel: { candidateId: "p1-r2", policyVersion: 10 }
    }).kind).toBe("selected");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["other"],
      policy,
      selectedModel: { candidateId: "p1-r2", policyVersion: 10 }
    })).toEqual({ kind: "selection_invalid" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["openai/gpt-6-sol"],
      policy,
      selectedModel: { candidateId: "p9-r8", policyVersion: 9 }
    })).toEqual({ kind: "selection_invalid" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["perplexity/sonar-pro-search"], policy
    }).kind).toBe("unsupported_catalog");
  });
});
