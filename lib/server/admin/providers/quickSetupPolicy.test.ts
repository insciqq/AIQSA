import { describe, expect, it } from "vitest";
import {
  ADMIN_PROVIDER_QUICK_SETUP_MAX_MODELS,
  ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS
} from "../../../contracts/adminProviderQuickSetup";
import {
  ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION,
  adminProviderQuickSetupPolicy,
  decideAdminProviderQuickSetupModel
} from "./quickSetupPolicy";

describe("provider Quick setup policy", () => {
  it("keeps the current-model candidates, defaults, and recommendations explicit", () => {
    expect(ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION).toBe(14);
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
      { id: "p13-o9", recommended: true, templateKey: "openai:gpt-6.2-sol" },
      { id: "p13-o10", recommended: false, templateKey: "openai:gpt-6.2-astra" },
      { id: "p10-o8", recommended: false, templateKey: "openai:gpt-6.1-sol" },
      { id: "p14-o11", recommended: false, templateKey: "openai:gpt-6.1-terra" },
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
      { id: "p13-a8", recommended: false, templateKey: "anthropic:claude-fable-5-2" },
      { id: "p7-a3", recommended: false, templateKey: "anthropic:claude-fable-5-1" },
      { id: "p2-a1", legacy: true, recommended: false, templateKey: "anthropic:claude-opus-5" },
      { id: "p2-a2", legacy: true, recommended: false, templateKey: "anthropic:claude-sonnet-5" },
      { id: "p7-a4", legacy: true, recommended: false, templateKey: "anthropic:claude-opus-4-8" }
    ]);
    expect(definitions("gemini")).toEqual([
      { id: "p2-g1", recommended: true, templateKey: "gemini:gemini-3.8-flash" },
      { id: "p13-g9", recommended: false, templateKey: "gemini:gemini-4-neon" },
      { id: "p12-g7", recommended: false, templateKey: "gemini:gemini-4-carbon" },
      { id: "p10-g6", recommended: false, templateKey: "gemini:gemini-4-argon" },
      { id: "p12-g8", recommended: false, templateKey: "gemini:gemini-4-hydrogen" },
      { id: "p2-g3", recommended: false, templateKey: "gemini:gemini-3.5-flash-lite" },
      { id: "p7-g5", legacy: true, recommended: false, templateKey: "gemini:gemini-3.6-flash" },
      { id: "p2-g2", legacy: true, recommended: false, templateKey: "gemini:gemini-3.5-flash" },
      { id: "p2-g4", legacy: true, recommended: false, templateKey: "gemini:gemini-3.1-pro-preview" }
    ]);
    expect(definitions("openrouter")).toEqual([
      { id: "p9-r7", recommended: true, templateKey: "openrouter:anthropic/claude-opus-5.5" },
      { id: "p10-r12", recommended: false, templateKey: "openrouter:anthropic/claude-sonnet-5.5" },
      { id: "p10-r13", recommended: false, templateKey: "openrouter:anthropic/claude-haiku-5.5" },
      { id: "p13-r20", recommended: false, templateKey: "openrouter:openai/gpt-6.2-sol" },
      { id: "p13-r21", recommended: false, templateKey: "openrouter:openai/gpt-6.2-astra" },
      { id: "p10-r14", recommended: false, templateKey: "openrouter:openai/gpt-6.1-sol" },
      { id: "p10-r15", recommended: false, templateKey: "openrouter:openai/gpt-6.1-sol-pro" },
      { id: "p14-r24", recommended: false, templateKey: "openrouter:openai/gpt-6.1-terra" },
      { id: "p13-r23", recommended: false, templateKey: "openrouter:google/gemini-4-neon" },
      { id: "p12-r18", recommended: false, templateKey: "openrouter:google/gemini-4-carbon" },
      { id: "p10-r16", recommended: false, templateKey: "openrouter:google/gemini-4-argon" },
      { id: "p12-r19", recommended: false, templateKey: "openrouter:google/gemini-4-hydrogen" },
      { id: "p9-r8", recommended: false, templateKey: "openrouter:openai/gpt-6-sol" },
      { id: "p9-r9", recommended: false, templateKey: "openrouter:openai/gpt-6-luna" },
      { id: "p9-r10", recommended: false, templateKey: "openrouter:openai/gpt-6-sol-pro" },
      { id: "p9-r11", recommended: false, templateKey: "openrouter:openai/gpt-6-luna-pro" },
      { id: "p1-r2", recommended: false, templateKey: "openrouter:google/gemini-3.8-flash" },
      { id: "p1-r3", recommended: false, templateKey: "openrouter:deepseek/deepseek-v4-pro-0813" },
      { id: "p11-r17", recommended: false, templateKey: "openrouter:deepseek/deepseek-v4.1-flash-1017" },
      { id: "p13-r22", recommended: false, templateKey: "openrouter:anthropic/claude-fable-5.2" },
      { id: "p7-r4", recommended: false, templateKey: "openrouter:anthropic/claude-fable-5.1" },
      { id: "p7-r5", recommended: false, templateKey: "openrouter:openai/gpt-6-astra" },
      { id: "p7-r-search", recommended: false, templateKey: "openrouter:perplexity/sonar-pro-search" },
      { id: "p1-r1", legacy: true, recommended: false, templateKey: "openrouter:anthropic/claude-opus-5" },
      { id: "p8-r6", legacy: true, recommended: false, templateKey: "openrouter:deepseek/deepseek-v4.1-flash" }
    ]);
    expect(adminProviderQuickSetupPolicy("openrouter").candidates.filter(({ templateKey }) =>
      templateKey.startsWith("openrouter:deepseek/deepseek-v4.1-flash")).map(({ displayName }) => displayName))
      .toEqual(["DeepSeek V4.1 Flash", "DeepSeek V4.1 Flash 0910"]);
    expect(definitions("deepseek")).toEqual([
      { id: "p8-d4", recommended: true, templateKey: "deepseek:deepseek-flash" },
      { id: "p6-d1", recommended: false, templateKey: "deepseek:deepseek-v4-pro" }
    ]);
    expect(adminProviderQuickSetupPolicy("openrouter").candidates.find(
      ({ templateKey }) => templateKey.includes("perplexity/sonar-pro-search")
    )).toMatchObject({ configuration: { answerSelectable: false } });
  });

  it("offers each provider no more models than the browser accepts, under distinct names", () => {
    // OpenRouter grew to 22 offered models in policy v12-v13 while the browser
    // still capped the list at 16, so the snapshot failed to decode and Add
    // provider broke for every family.
    for (const provider of ADMIN_PROVIDER_QUICK_SETUP_PROVIDERS) {
      const offered = adminProviderQuickSetupPolicy(provider).candidates
        .filter(({ legacy }) => !legacy)
        .map(({ displayName }) => displayName);
      expect(offered.length, provider).toBeGreaterThan(0);
      expect(offered.length, provider).toBeLessThanOrEqual(ADMIN_PROVIDER_QUICK_SETUP_MAX_MODELS);
      expect(new Set(offered).size, provider).toBe(offered.length);
    }
  });

  it("ignores remote ordering and picks the code-owned recommendation", () => {
    const policy = adminProviderQuickSetupPolicy("openai");
    for (const modelIds of [
      ["gpt-6-sol", "gpt-6.1-sol", "gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra"],
      ["gpt-6.1-terra", "gpt-6.2-astra", "gpt-6.2-sol", "gpt-6-sol", "gpt-6.1-sol"]
    ]) {
      const decision = decideAdminProviderQuickSetupModel({ modelIds, policy });
      expect(decision.kind).toBe("selected");
      if (decision.kind === "selected") expect(decision.candidate.candidateId).toBe("p13-o9");
    }
    // A catalog without the recommendation takes the first current candidate it lists.
    expect(decideAdminProviderQuickSetupModel({ modelIds: ["gpt-6-sol", "gpt-6.1-terra", "gpt-6.1-sol"], policy }))
      .toMatchObject({ candidate: { candidateId: "p10-o8" }, kind: "selected" });
    // GPT-6.1 Terra is offered, never recommended, and an administrator may still pick it.
    expect(decideAdminProviderQuickSetupModel({ modelIds: ["gpt-6.2-sol", "gpt-6.1-terra"], policy,
      selectedModel: { candidateId: "p14-o11", policyVersion: 14 } }))
      .toMatchObject({ candidate: { candidateId: "p14-o11", configuration: { upstreamModelId: "gpt-6.1-terra" } }, kind: "selected" });
    expect(decideAdminProviderQuickSetupModel({ modelIds: ["openai/gpt-6.1-terra", "anthropic/claude-opus-5.5"],
      policy: adminProviderQuickSetupPolicy("openrouter") })).toMatchObject({ candidate: { candidateId: "p9-r7" }, kind: "selected" });
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
      modelIds: ["gpt-5.6-terra"], policy: openai, selectedModel: { candidateId: "p2-o1", policyVersion: 14 }
    })).toEqual({ kind: "selection_invalid" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["anthropic/claude-opus-5", "google/gemini-3.8-flash"], policy: adminProviderQuickSetupPolicy("openrouter")
    })).toMatchObject({ candidate: { candidateId: "p1-r2" }, kind: "selected" });
    const openrouter = adminProviderQuickSetupPolicy("openrouter");
    const bothFlashes = ["deepseek/deepseek-v4.1-flash", "deepseek/deepseek-v4.1-flash-1017"];
    expect(decideAdminProviderQuickSetupModel({ modelIds: ["deepseek/deepseek-v4.1-flash"], policy: openrouter }))
      .toEqual({ kind: "unsupported_catalog" });
    expect(decideAdminProviderQuickSetupModel({ modelIds: bothFlashes, policy: openrouter }))
      .toMatchObject({ candidate: { candidateId: "p11-r17", configuration: { upstreamModelId: "deepseek/deepseek-v4.1-flash-1017" } }, kind: "selected" });
    expect(decideAdminProviderQuickSetupModel({ modelIds: bothFlashes, policy: openrouter,
      selectedModel: { candidateId: "p11-r17", policyVersion: 14 } })).toMatchObject({ candidate: { candidateId: "p11-r17" }, kind: "selected" });
    expect(decideAdminProviderQuickSetupModel({ modelIds: bothFlashes, policy: openrouter,
      selectedModel: { candidateId: "p8-r6", policyVersion: 14 } })).toEqual({ kind: "selection_invalid" });
  });

  it("requires an exact policy-owned selected candidate observed by the repeated check", () => {
    const policy = adminProviderQuickSetupPolicy("openrouter");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["google/gemini-3.8-flash"],
      policy,
      selectedModel: { candidateId: "p1-r2", policyVersion: 14 }
    }).kind).toBe("selected");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["other"],
      policy,
      selectedModel: { candidateId: "p1-r2", policyVersion: 14 }
    })).toEqual({ kind: "selection_invalid" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["openai/gpt-6-sol"],
      policy,
      selectedModel: { candidateId: "p9-r8", policyVersion: 10 }
    })).toEqual({ kind: "selection_invalid" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["perplexity/sonar-pro-search"], policy
    }).kind).toBe("unsupported_catalog");
  });
});
