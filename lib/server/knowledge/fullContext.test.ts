import { describe, expect, it } from "vitest";
import { KNOWLEDGE_FULL_CONTEXT_DRAFT_ROUTE_INSTRUCTION } from "./answerGroundingV5";
import { textMessageContent } from "../../domain/content";
import type { ProviderRunRequest } from "../providers/types";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import { createKnowledgeTableDocumentContext } from "./documentContext";
import type { KnowledgeRunAdmissionPlan } from "./runAdmission";
import {
  KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT,
  KNOWLEDGE_ANSWER_ROUTE_RAG,
  knowledgeAdmissionMayFitFullContext,
  planKnowledgeAnswering,
  type KnowledgeFullContextPassage
} from "./fullContext";

function admission(approxTokens = 64, passageCount = 2): KnowledgeRunAdmissionPlan {
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
      passageCount,
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
    expect(plan.dispatchDraft.header).toContain("Every passage of every admitted ready Source");
    expect(plan.dispatchDraft.header).not.toContain("AIQSA_KB_STATUS=");
    expect(KNOWLEDGE_FULL_CONTEXT_DRAFT_ROUTE_INSTRUCTION).toContain(
      "inspect all relevant supplied passages"
    );
    expect(KNOWLEDGE_FULL_CONTEXT_DRAFT_ROUTE_INSTRUCTION).toContain(
      "structural locator order"
    );
    expect(plan.dispatchDraft.promptFragmentVersion).toBe(18);
  });

  it("keeps an exact alphanumeric cell usable when only numeric normalization is uncertain", () => {
    const documentContext = createKnowledgeTableDocumentContext({
      blockId: "block-identifier",
      cells: [
        { columnEnd: 0, columnStart: 0, text: "Batch identifier" },
        { columnEnd: 1, columnStart: 1, text: "5widgets" }
      ],
      headerLineage: [
        { columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Field" },
        { columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Value" }
      ],
      rowIndex: 1
    });
    const contextual = passages().map((passage, index) => index === 0
      ? { ...passage, documentContext }
      : passage);
    const plan = planKnowledgeAnswering({
      admissionPlan: admission(),
      passages: contextual,
      request: request()
    });

    expect(documentContext.ambiguityReasons).toContain("ambiguous_number");
    expect(plan.route).toBe(KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT);
    if (plan.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) return;
    expect(plan.dispatchDraft.items[0]).toMatchObject({ ambiguity: "none" });
    expect(plan.dispatchDraft.message).not.toContain("table cell associations are ambiguous");
  });

  it("keeps a structurally explicit sparse inline pair usable without a table header", () => {
    const documentContext = createKnowledgeTableDocumentContext({
      blockId: "block-inline-pair",
      cells: [
        { columnEnd: 0, columnStart: 0, text: "Reviewer" },
        { columnEnd: 9, columnStart: 9, text: "Alex Rivera" }
      ],
      headerLineage: [],
      inlinePairEvidence: "singleton_table",
      rowIndex: 3
    });
    const contextual = passages().map((passage, index) => index === 0
      ? { ...passage, documentContext, text: "Reviewer\t\t\t\t\t\t\t\t\tAlex Rivera" }
      : passage);
    const plan = planKnowledgeAnswering({
      admissionPlan: admission(),
      passages: contextual,
      request: request()
    });

    expect(documentContext.ambiguityReasons).toEqual([]);
    expect(plan.route).toBe(KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT);
    if (plan.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) return;
    expect(plan.dispatchDraft.items[0]).toMatchObject({ ambiguity: "none" });
    expect(plan.dispatchDraft.message).not.toContain("table cell associations are ambiguous");
  });

  it("exposes stable source and table-row order without publishing parser identities", () => {
    const contextual = passages().map((passage, index) => ({
      ...passage,
      documentContext: createKnowledgeTableDocumentContext({
        blockId: "private-parser-table-block",
        cells: [
          { columnEnd: 0, columnStart: 0, text: index === 0 ? "Record" : "Expiry" },
          { columnEnd: 1, columnStart: 1, text: index === 0 ? "Orchid" : "2032-04-05" }
        ],
        headerLineage: [],
        rowIndex: 7 + index
      })
    }));
    const plan = planKnowledgeAnswering({
      admissionPlan: admission(),
      passages: contextual,
      request: request()
    });

    expect(plan.route).toBe(KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT);
    if (plan.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) return;
    expect(plan.dispatchDraft.items.map(({ locator }) => locator)).toEqual([
      "page=1; heading=Lipid panel; source-passage=1; structure=table-row; table=T1; row-index=7; row-kind=data",
      "page=1; heading=Lipid panel; source-passage=2; structure=table-row; table=T1; row-index=8; row-kind=data"
    ]);
    expect(plan.dispatchDraft.message).not.toContain("private-parser-table-block");
    expect(plan.dispatchDraft.header).toContain("matching table aliases identify rows");
    expect(plan.dispatchDraft.header).toContain(
      "Coordinates and proximity never establish a semantic relation"
    );
  });

  it("ships bounded ordered table views while atomic handles remain the only evidence", () => {
    const rows = Array.from({ length: 12 }, (_, passageOrdinal): KnowledgeFullContextPassage => {
      const secondTable = passageOrdinal >= 10;
      const rowIndex = secondTable ? passageOrdinal - 10 : passageOrdinal;
      const text = passageOrdinal % 3 === 0
        ? `Record ${String.fromCharCode(65 + passageOrdinal)}`
        : passageOrdinal % 3 === 1
          ? `Attribute ${passageOrdinal}`
          : `Value ${passageOrdinal}`;
      return {
        ...passages()[0]!,
        contentHash: (passageOrdinal % 10).toString().repeat(64),
        documentContext: createKnowledgeTableDocumentContext({
          blockId: secondTable ? "private-table-beta" : "private-table-alpha",
          cells: [{ columnEnd: 1, columnStart: 0, text }],
          headerLineage: [],
          rowIndex
        }),
        passageId: `table-passage-${passageOrdinal}`,
        passageOrdinal,
        text
      };
    });
    const plan = planKnowledgeAnswering({
      admissionPlan: admission(256, rows.length),
      passages: rows,
      request: request()
    });

    expect(plan.route).toBe(KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT);
    if (plan.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) return;
    const views = plan.dispatchDraft.items.filter((item) =>
      item.expandedContextState === "included");
    expect(views.map((item) => item.handle)).toEqual(["K5", "K8", "K12"]);
    expect(views[0]?.expandedContext).toContain("handle=K1; table=T1; row-index=0");
    expect(views[0]?.expandedContext).toContain("handle=K9; table=T1; row-index=8");
    expect(views[0]?.expandedContext).not.toContain("handle=K10;");
    expect(views[1]?.expandedContext).toContain("handle=K10; table=T1; row-index=9");
    expect(views[0]?.expandedContext).toContain("source-table-start=true; source-table-end=false");
    expect(views[0]?.expandedContext).not.toContain("structural-support-group");
    expect(views[1]?.expandedContext).toContain("source-table-start=false; source-table-end=true");
    expect(views[2]?.expandedContext).toContain("handle=K11; table=T2; row-index=0");
    expect(views[2]?.expandedContext).not.toContain("handle=K10;");
    expect(views[0]?.expandedContext).toContain(
      "table structure is presented without a server-inferred relation"
    );
    expect(plan.dispatchDraft.message).not.toContain("private-table-alpha");
    expect(plan.dispatchDraft.message).not.toContain("private-table-beta");
    expect(plan.dispatchDraft.header).toContain(
      "not additional evidence or a server-inferred record boundary"
    );
    expect(plan.dispatchDraft.header).not.toContain("support-group");
  });

  it("keeps table headers without consuming the bounded data-row neighborhood", () => {
    const rows = Array.from({ length: 10 }, (_, passageOrdinal): KnowledgeFullContextPassage => {
      const text = passageOrdinal === 0
        ? "Item | Field | Value"
        : passageOrdinal % 4 === 1
          ? `Record ${passageOrdinal}`
          : passageOrdinal % 4 === 2
            ? `Label ${passageOrdinal}`
            : `Attribute ${passageOrdinal}`;
      return {
        ...passages()[0]!,
        contentHash: passageOrdinal.toString().repeat(64),
        documentContext: createKnowledgeTableDocumentContext({
          blockId: "private-header-table",
          cells: [{ columnEnd: 2, columnStart: 0, text }],
          headerLineage: [],
          rowIndex: passageOrdinal,
          rowKind: passageOrdinal === 0 ? "header" : "data"
        }),
        passageId: `header-table-passage-${passageOrdinal}`,
        passageOrdinal,
        text
      };
    });
    const plan = planKnowledgeAnswering({
      admissionPlan: admission(256, rows.length),
      passages: rows,
      request: request()
    });

    expect(plan.route).toBe(KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT);
    if (plan.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) return;
    const view = plan.dispatchDraft.items.find((item) =>
      item.expandedContextState === "included");
    expect(view?.handle).toBe("K6");
    expect(view?.expandedContext).toContain(
      "handle=K1; table=T1; row-index=0; row-kind=header"
    );
    expect(view?.expandedContext).toContain(
      "handle=K10; table=T1; row-index=9; row-kind=data"
    );
    expect(view?.expandedContext).toContain("source-table-start=true; source-table-end=true");
    expect(view?.expandedContext).not.toContain("structural-support-group");
    expect(plan.dispatchDraft.header).toContain("complete repeated table pattern");
    expect(plan.dispatchDraft.message).not.toContain("private-header-table");
  });

  it("presents bounded body neighbors around one ambiguous structured passage", () => {
    const contextual: KnowledgeFullContextPassage[] = [{
      ...passages()[0]!,
      contentHash: "1".repeat(64),
      passageId: "address-label",
      passageOrdinal: 0,
      text: "Registered at the following address:",
      tokenCount: 6
    }, {
      ...passages()[0]!,
      contentHash: "2".repeat(64),
      documentContext: createKnowledgeTableDocumentContext({
        blockId: "private-address-row",
        cells: [
          { columnEnd: 0, columnStart: 0, text: "Region Example City" },
          { columnEnd: 1, columnStart: 1, text: "Main Street 10" }
        ],
        headerLineage: [],
        rowIndex: 0
      }),
      passageId: "address-value",
      passageOrdinal: 1,
      text: "Region Example City\tMain Street 10",
      tokenCount: 8
    }, {
      ...passages()[0]!,
      contentHash: "3".repeat(64),
      passageId: "address-note",
      passageOrdinal: 2,
      text: "Region, city, street, building.",
      tokenCount: 6
    }];
    const plan = planKnowledgeAnswering({
      admissionPlan: admission(64, contextual.length),
      passages: contextual,
      request: request()
    });

    expect(plan.route).toBe(KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT);
    if (plan.route !== KNOWLEDGE_ANSWER_ROUTE_FULL_CONTEXT) return;
    const view = plan.dispatchDraft.items[1];
    expect(view).toMatchObject({
      ambiguity: "table_cell_associations_ambiguous",
      expandedContextState: "included",
      handle: "K2"
    });
    expect(view?.expandedContext).toContain(
      "Bounded ordered same-Source context around K2"
    );
    expect(view?.expandedContext).toContain(
      "handle=K1; position=previous; page=1; heading=Lipid panel; source-passage=1"
    );
    expect(view?.expandedContext).toContain("Registered at the following address:");
    expect(view?.expandedContext).toContain(
      "handle=K2; position=anchor; page=1; heading=Lipid panel; source-passage=2"
    );
    expect(view?.expandedContext).toContain(
      "handle=K3; position=next; page=1; heading=Lipid panel; source-passage=3"
    );
    expect(view?.expandedContext).not.toContain("private-address-row");
    expect(plan.dispatchDraft.items.map(({ handle }) => handle)).toEqual(["K1", "K2", "K3"]);
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

  it("never presents a corpus above the occurrence atom limit as complete", () => {
    const text = Array.from({ length: 1_025 }, () => "A\tX\t10").join("\n");
    expect(planKnowledgeAnswering({ admissionPlan: admission(2_000, 1),
      passages: [{ ...passages()[0]!, text, tokenCount: 2_000 }], request: request(100_000)
    }).route).toBe(KNOWLEDGE_ANSWER_ROUTE_RAG);
  });

  it("falls back before provider I/O when the two-stage structured prompt envelope cannot fit", () => {
    const oversized = passages().map((passage, index) => ({
      ...passage,
      text: `${index}: ${"😀".repeat(24_000)}`,
      tokenCount: 1_000
    }));
    expect(planKnowledgeAnswering({
      admissionPlan: admission(2_000),
      passages: oversized,
      request: request(1_000_000)
    }).route).toBe(KNOWLEDGE_ANSWER_ROUTE_RAG);
  });
});
