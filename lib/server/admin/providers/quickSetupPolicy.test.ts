import { describe, expect, it } from "vitest";
import {
  ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION,
  adminProviderQuickSetupPolicy,
  decideAdminProviderQuickSetupModel
} from "./quickSetupPolicy";

describe("provider Quick setup policy", () => {
  it("keeps the v1 candidate ids and recommendations explicit", () => {
    expect(ADMIN_PROVIDER_QUICK_SETUP_POLICY_VERSION).toBe(1);
    expect(adminProviderQuickSetupPolicy("openai").candidates.map((candidate) => ({
      id: candidate.candidateId,
      recommended: candidate.recommended,
      templateKey: candidate.templateKey
    }))).toEqual([
      { id: "p1-o1", recommended: true, templateKey: "openai:gpt-5.6-terra" },
      { id: "p1-o2", recommended: false, templateKey: "openai:gpt-5.6-luna" },
      { id: "p1-o3", recommended: false, templateKey: "openai:gpt-5.6-sol" },
      { id: "p1-o4", recommended: false, templateKey: "openai:gpt-5.5" }
    ]);
    expect(adminProviderQuickSetupPolicy("anthropic").candidates.map(({ candidateId }) =>
      candidateId)).toEqual(["p1-a1"]);
    expect(adminProviderQuickSetupPolicy("openrouter").candidates.map(({ candidateId }) =>
      candidateId)).toEqual(["p1-r1", "p1-r2", "p1-r3"]);
    expect(adminProviderQuickSetupPolicy("openrouter").candidates.some(
      ({ templateKey }) => templateKey.includes("perplexity/sonar-pro-search")
    )).toBe(false);
  });

  it("ignores remote ordering and picks the code-owned recommendation", () => {
    const policy = adminProviderQuickSetupPolicy("openai");
    for (const modelIds of [
      ["gpt-5.5", "gpt-5.6-terra", "gpt-5.6-luna"],
      ["gpt-5.6-luna", "gpt-5.5", "gpt-5.6-terra"]
    ]) {
      const decision = decideAdminProviderQuickSetupModel({ modelIds, policy });
      expect(decision.kind).toBe("selected");
      if (decision.kind === "selected") expect(decision.candidate.candidateId).toBe("p1-o1");
    }
  });

  it("returns only bounded supported fallbacks in policy order", () => {
    const decision = decideAdminProviderQuickSetupModel({
      modelIds: ["unknown/new-model", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-luna"],
      policy: adminProviderQuickSetupPolicy("openai")
    });
    expect(decision).toEqual({
      candidates: [
        { candidateId: "p1-o2", displayName: "GPT-5.6 Luna" },
        { candidateId: "p1-o3", displayName: "GPT-5.6 Sol" },
        { candidateId: "p1-o4", displayName: "GPT-5.5" }
      ],
      kind: "selection_required"
    });
  });

  it("requires an exact policy-owned selected candidate observed by the repeated check", () => {
    const policy = adminProviderQuickSetupPolicy("openrouter");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["google/gemini-3.5-flash"],
      policy,
      selectedModel: { candidateId: "p1-r2", policyVersion: 1 }
    }).kind).toBe("selected");
    expect(decideAdminProviderQuickSetupModel({
      modelIds: ["other"],
      policy,
      selectedModel: { candidateId: "p1-r2", policyVersion: 1 }
    })).toEqual({ kind: "selection_invalid" });
  });
});
