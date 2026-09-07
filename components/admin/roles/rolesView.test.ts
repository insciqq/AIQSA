import { adminKnowledgeProfileFixture } from "@/tests/support/knowledgeProfile";
import type { AdminSystemModelPolicyCatalog } from "@/lib/contracts/adminSystemModelPolicy";
import { describe, expect, it } from "vitest";
import {
  generativeRoleItems,
  knowledgeDocumentItems,
  knowledgeProcessingState,
  rerankerFallbacksLine,
  roleStatus
} from "./rolesView";

const base = {
  connectionDisplayName: "OpenAI",
  connectionId: "openai",
  defaultReasoningEffort: null,
  forcedToolCall: "verified" as const,
  reasoningEfforts: [],
  structuredOutput: "verified" as const,
  visionInput: "not_verified" as const
};
const ready = { ...base, displayName: "GPT Luna", id: "luna" };
const unchecked = { ...base, displayName: "GPT Terra", forcedToolCall: "not_verified" as const, id: "terra", structuredOutput: "not_verified" as const };
const anthropic = { ...base, connectionDisplayName: "Anthropic", connectionId: "anthropic", displayName: "Claude", forcedToolCall: "unsupported" as const, id: "claude", structuredOutput: "unsupported" as const };
const reranker = { connectionDisplayName: "OpenRouter", connectionId: "openrouter", displayName: "Voyage Rerank", id: "voyage" };
const fallback = { ...reranker, displayName: "Cohere 4 Pro", id: "cohere" };

function catalog(overrides: Partial<AdminSystemModelPolicyCatalog["policy"]> = {}): AdminSystemModelPolicyCatalog {
  return {
    candidates: [ready],
    documentCandidates: [],
    ineligible: {
      direct_pdf: [],
      memory: [{ ...unchecked, reason: "not_checked" }, { ...anthropic, reason: "adapter_unsupported" }],
      vision: [{ ...ready, reason: "not_checked" }, { ...anthropic, reason: "adapter_unsupported" }]
    },
    policy: {
      chatPdfModel: null,
      chatPdfPreparationAllowed: false,
      chatPdfReasoningEffort: null,
      reasoningEffort: null,
      rerankerModel: { ...reranker, available: true },
      rerankerRoute: {
        entries: [
          { ...reranker, available: true, position: 0, relevanceScoreFloor: null, role: "primary" },
          { ...fallback, available: false, position: 1, relevanceScoreFloor: null, role: "fallback" }
        ],
        policyVersion: "openrouter-reranker-route-v1"
      },
      systemModel: { ...ready, available: true },
      updatedAt: "2026-09-07T00:00:00.000Z",
      updatedBy: null,
      version: 3,
      ...overrides
    },
    rerankerCandidates: [reranker],
    verificationCandidates: [ready, unchecked, anthropic]
  };
}

describe("rolesView", () => {
  it("groups Memory candidates from the server's eligibility lists without client guesses", () => {
    expect(generativeRoleItems(catalog(), "memory")).toEqual([
      { group: "ready", id: "luna", label: "OpenAI / GPT Luna" },
      { group: "check", id: "terra", label: "OpenAI / GPT Terra" },
      { group: "ineligible", id: "claude", label: "Anthropic / Claude", note: "no strict JSON on this route" }
    ]);
    expect(generativeRoleItems(catalog(), "vision").map(({ group, id }) => `${group}:${id}`))
      .toEqual(["check:luna", "ineligible:claude"]);
  });

  it("derives Working / Not assigned / Unavailable and the fallbacks line", () => {
    expect(roleStatus(null)).toBe("not_assigned");
    expect(roleStatus({ available: false })).toBe("unavailable");
    expect(roleStatus({ available: true })).toBe("working");
    expect(rerankerFallbacksLine(catalog())).toBe("Fallbacks: OpenRouter / Cohere 4 Pro (unavailable)");
    expect(rerankerFallbacksLine(catalog({ rerankerModel: null }))).toBeNull();
  });

  it("builds Documents items from the Knowledge profile plus the role catalog's Check first group", () => {
    const destinations = [{
      connectionDisplayName: "OpenAI", deploymentId: "luna", directPdf: false,
      modelDisplayName: "GPT Luna", provider: "openai", upstreamModelId: "luna", vision: true
    }];
    expect(knowledgeDocumentItems(destinations, "system_model_vision", catalog())).toEqual([
      { group: "ready", id: "luna", label: "OpenAI / GPT Luna" },
      { group: "ineligible", id: "claude", label: "Anthropic / Claude", note: "no image input on this route" }
    ]);
    expect(knowledgeDocumentItems(destinations, "system_model_direct_pdf", null)).toEqual([]);
  });

  it("reports Reindexing N of M bases while bases rebuild and Ready afterwards", () => {
    const profile = adminKnowledgeProfileFixture();
    expect(knowledgeProcessingState(profile)).toEqual({ label: "Ready", status: "working" });
    expect(knowledgeProcessingState(adminKnowledgeProfileFixture({
      migration: { ...profile.migration, activeProfileBases: 4, buildingProfileBases: 1, totalBases: 5 }
    }))).toEqual({ label: "Reindexing 1 of 5 bases", status: "reindexing" });
    expect(knowledgeProcessingState(adminKnowledgeProfileFixture({
      activeRevision: null,
      health: { checkedAt: null, code: "knowledge_profile_not_configured", state: "not_configured" }
    }))).toEqual({ label: "Not assigned", status: "not_assigned" });
  });
});
