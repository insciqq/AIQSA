import { describe, expect, it } from "vitest";
import {
  ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION,
  adminProviderQuickSetupPolicy,
  decideAdminProviderQuickSetupModel
} from "./quickSetupPolicy";

describe("provider Quick setup policy", () => {
  it("keeps the current-model candidates, defaults, and recommendations explicit", () => {
    expect(ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION).toBe(7);
    expect(adminProviderQuickSetupPolicy("openai").connection.configuration.responseTimeoutMs)
      .toBe(300_000);
    expect(adminProviderQuickSetupPolicy("openai").candidates.map((candidate) => ({
      id: candidate.candidateId,
      recommended: candidate.recommended,
      templateKey: candidate.templateKey
    }))).toEqual([
      { id: "p7-o4", recommended: false, templateKey: "openai:gpt-6-astra" },
      { id: "p2-o1", recommended: true, templateKey: "openai:gpt-5.6-terra" },
      { id: "p2-o2", recommended: false, templateKey: "openai:gpt-5.6-luna" },
      { id: "p2-o3", recommended: false, templateKey: "openai:gpt-5.6-sol" },
      { id: "p7-o5", recommended: false, templateKey: "openai:gpt-5.5" }
    ]);
    expect(adminProviderQuickSetupPolicy("anthropic").candidates.map((candidate) => ({
      id: candidate.candidateId,
      recommended: candidate.recommended,
      templateKey: candidate.templateKey
    }))).toEqual([
      { id: "p7-a3", recommended: false, templateKey: "anthropic:claude-fable-5-1" },
      { id: "p2-a1", recommended: true, templateKey: "anthropic:claude-opus-5" },
      { id: "p2-a2", recommended: false, templateKey: "anthropic:claude-sonnet-5" },
      { id: "p7-a4", recommended: false, templateKey: "anthropic:claude-opus-4-8" }
    ]);
    expect(adminProviderQuickSetupPolicy("gemini").candidates.map((candidate) => ({
      id: candidate.candidateId,
      recommended: candidate.recommended,
      templateKey: candidate.templateKey
    }))).toEqual([
      { id: "p2-g1", recommended: true, templateKey: "gemini:gemini-3.8-flash" },
      { id: "p2-g2", recommended: false, templateKey: "gemini:gemini-3.5-flash" },
      { id: "p2-g3", recommended: false, templateKey: "gemini:gemini-3.5-flash-lite" },
      { id: "p2-g4", recommended: false, templateKey: "gemini:gemini-3.1-pro-preview" },
      { id: "p7-g5", recommended: false, templateKey: "gemini:gemini-3.6-flash" }
    ]);
    expect(adminProviderQuickSetupPolicy("openrouter").candidates.map(({ candidateId }) =>
      candidateId)).toEqual(["p1-r1", "p1-r2", "p1-r3", "p7-r4", "p7-r5", "p7-r-search"]);
    expect(adminProviderQuickSetupPolicy("deepseek").candidates.map((candidate) => ({
      id: candidate.candidateId,
      recommended: candidate.recommended,
      templateKey: candidate.templateKey
    }))).toEqual([
      { id: "p6-d1", recommended: true, templateKey: "deepseek:deepseek-v4-pro" },
      { id: "p6-d2", recommended: false, templateKey: "deepseek:deepseek-v4-flash" },
      {
        id: "p6-d3",
        recommended: false,
        templateKey: "deepseek:deepseek-v4-flash-vision-exp"
      }
    ]);
    expect(adminProviderQuickSetupPolicy("openrouter").candidates.find(
      ({ templateKey }) => templateKey.includes("perplexity/sonar-pro-search")
    )).toMatchObject({ configuration: { answerSelectable: false } });
  });

  it("ignores remote ordering and picks the code-owned recommendation", () => {
    const policy = adminProviderQuickSetupPolicy("openai");
    for (const modelIds of [
      ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
      ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"]
    ]) {
      const decision = decideAdminProviderQuickSetupModel({ modelIds, policy });
      expect(decision.kind).toBe("selected");
      if (decision.kind === "selected") expect(decision.candidate.candidateId).toBe("p2-o1");
    }
  });

  it("chooses the first supported fallback without another user action", () => {
    const decision = decideAdminProviderQuickSetupModel({
      modelIds: ["unknown/new-model", "gpt-5.6-sol", "gpt-5.6-luna"],
      policy: adminProviderQuickSetupPolicy("openai")
    });
    expect(decision).toMatchObject({
      candidate: { candidateId: "p2-o2", displayName: "GPT-5.6 Luna" },
      kind: "selected"
    });
  });

  it("requires an exact policy-owned selected candidate observed by the repeated check", () => {
    const policy = adminProviderQuickSetupPolicy("openrouter");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["google/gemini-3.8-flash"],
      policy,
      selectedModel: { candidateId: "p1-r2", policyVersion: 7 }
    }).kind).toBe("selected");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["other"],
      policy,
      selectedModel: { candidateId: "p1-r2", policyVersion: 7 }
    })).toEqual({ kind: "selection_invalid" });
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["perplexity/sonar-pro-search"], policy
    }).kind).toBe("unsupported_catalog");
  });
});
