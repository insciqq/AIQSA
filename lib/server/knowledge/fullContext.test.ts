import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_GROUNDED_ANSWER_INSTRUCTION,
  KNOWLEDGE_NUMERIC_ANSWER_INSTRUCTION
} from "./answerInstructions";
import { textMessageContent } from "../../domain/content";
import type { ProviderRunRequest } from "../providers/types";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import type { KnowledgeRunAdmissionPlan } from "./runAdmission";
import {
  KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT,
  KNOWLEDGE_ANSWER_ROUTE_RAG,
  knowledgeAdmissionMayFitFullContext,
  planKnowledgeAnswering,
  type KnowledgeFullContextPassage
} from "./fullContext";

function admission(approxTokens = 64): KnowledgeRunAdmissionPlan {
  return {
    answerPolicy: {
      fullContextThresholdBasisPoints: 7_000,
      maximumKnowledgeSearches: 12,
      revision: 1,
      version: 1
    },
    bindings: [],
    budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
    exclusions: [],
    fingerprint: "a".repeat(64),
    knowledgePlan: {
      baseIds: ["base-1"],
      mode: "explicit",
      sourceIds: [],
      version: 1
    },
    profiles: [],
    resolvedSourceCount: 1,
    sources: [{
      approxTokens,
      authority: { knowledgeBaseIds: ["base-1"], owner: true, projectId: null },
      baseProvenance: [{ indexGenerationId: "generation-1", knowledgeBaseId: "base-1" }],
      directSelected: false,
      ordinal: 0,
      passageCount: 2,
      privateLabels: { fileName: "lipids.pdf", sourceName: "Lipids" },
      profileOrdinal: 0,
      profileRevisionId: "profile-1",
      selectionProvenance: ["base"],
      sourceAlias: "S1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      sourceVersionId: "version-1",
      sourceVersionNumber: 1
    }],
    userId: "user-1"
  };
}

function passages(): KnowledgeFullContextPassage[] {
  return ["Total cholesterol 5.3 mmol/L", "LDL cholesterol 3.5 mmol/L"].map(
    (text, passageOrdinal) => ({
      baseName: "Health",
      contentHash: `${passageOrdinal + 1}`.repeat(64),
      documentContext: null,
      headingPath: ["Lipid panel"],
      page: 1,
      pageEnd: 1,
      passageId: `passage-${passageOrdinal + 1}`,
      passageOrdinal,
      sectionId: "section-1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      sourceOrdinal: 0,
      sourceVersionId: "version-1",
      sourceVersionNumber: 1,
      text,
      tokenCount: 8
    })
  );
}

function request(contextWindow = 8_192): ProviderRunRequest {
  return {
    attachmentIds: [],
    attachments: [],
    chatId: "chat-1",
    content: textMessageContent("What is the trend?"),
    context: {
      messages: [{
        content: textMessageContent("What is the trend?"),
        id: "current-user-message",
        role: "user"
      }],
      mode: "branch_path"
    },
    knowledgePlan: admission().knowledgePlan,
    modelCapabilities: {
      contextWindow,
      nativePdfInput: false,
      nativeSearch: false,
      pdf: false,
      reasoning: false,
      toolCalling: true,
      vision: false
    },
    modelId: "luna",
    params: {},
    prompt: { developer: null, system: null },
    provider: "openai_compatible",
    searchPlan: { mode: "all_selected", options: [] },
    toolBudgets: {
      maxMcpToolsPerDiscovery: 32,
      maxToolCalls: 16,
      maxToolRounds: 8,
      mcpAutoDiscoveryTimeoutSeconds: 30
    },
    toolMode: "auto"
  };
}

describe("adaptive Knowledge answering", () => {
  it("packs every admitted passage into a full-context evidence manifest", () => {
    const plan = planKnowledgeAnswering({
      admissionPlan: admission(),
      passages: passages(),
      request: request()
    });

    expect(plan.route).toBe(KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT);
    if (plan.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) return;
    expect(plan.evidenceItems.map(({ handle }) => handle)).toEqual(["K1", "K2"]);
    expect(plan.dispatchDraft.exclusions).toEqual([]);
    expect(plan.dispatchDraft.message).toContain("Total cholesterol 5.3 mmol/L");
    expect(plan.dispatchDraft.message).toContain("LDL cholesterol 3.5 mmol/L");
    expect(plan.dispatchDraft.message).toContain("inspect every admitted Source systematically");
    expect(plan.dispatchDraft.header).toContain(KNOWLEDGE_NUMERIC_ANSWER_INSTRUCTION);
    expect(plan.dispatchDraft.header).toContain(KNOWLEDGE_GROUNDED_ANSWER_INSTRUCTION);
    expect(plan.dispatchDraft.header).toContain("give the smallest direct answer");
    expect(plan.dispatchDraft.header).toContain(
      "exact entity, value, field, row, column, or relation"
    );
    expect(plan.dispatchDraft.header).toContain(
      "Never put a supporting citation on its own line"
    );
    expect(plan.dispatchDraft.header).toContain("AIQSA_KB_FORMAT=EXTRACTIVE_V1");
    expect(plan.dispatchDraft.header).toContain("compact JSON line");
    expect(plan.dispatchDraft.promptFragmentVersion).toBe(13);
  });

  it("falls back before provider dispatch when the corpus or exact passages do not fit", () => {
    expect(knowledgeAdmissionMayFitFullContext(admission(8_000), 8_192)).toBe(false);
    expect(planKnowledgeAnswering({
      admissionPlan: admission(8_000),
      passages: passages(),
      request: request()
    }).route).toBe(KNOWLEDGE_ANSWER_ROUTE_RAG);
    expect(planKnowledgeAnswering({
      admissionPlan: admission(),
      passages: null,
      request: request()
    }).route).toBe(KNOWLEDGE_ANSWER_ROUTE_RAG);
  });
});
