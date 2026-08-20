import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME,
  KNOWLEDGE_TOOL_NAME
} from "./retrievalTypes";
import {
  knowledgeFollowUpTools,
  knowledgeRetrievalTool,
  parseKnowledgeSemanticToolRequest
} from "./knowledgeTools";
import {
  KNOWLEDGE_PLANNER_VERSION,
  planKnowledgeRequest,
  plannerAutomaticOperation
} from "./planner";

const automaticTargetSourceId = "11111111-1111-4111-8111-111111111111";

async function automaticPlannerArguments(
  query: string,
  source: Readonly<{ fileName: string; sourceName: string }> = {
    fileName: "Sales.xlsx",
    sourceName: "Sales"
  }
) {
  const plan = await planKnowledgeRequest({
    bases: [{
      approxTokens: 2_000,
      knowledgeBaseId: "base-1",
      passageCount: 8,
      readySourceCount: 1,
      sourceCount: 1
    }],
    conversation: [],
    directSources: [],
    modelCapabilities: { contextWindow: 32_000, toolCalling: true },
    originalQuery: query,
    scopeRequested: true,
    sources: [{
      fileName: source.fileName,
      sourceAlias: "S1",
      sourceId: automaticTargetSourceId,
      sourceName: source.sourceName,
      versionNumber: 1
    }],
    version: KNOWLEDGE_PLANNER_VERSION
  });
  const subquery = plan.subqueries[0];
  if (!subquery) throw new Error("automatic_planner_subquery_missing");
  return plannerAutomaticOperation(plan, subquery);
}

describe("Knowledge semantic tools", () => {
  it("exposes semantic follow-ups without exposing the automatic internal tool", () => {
    expect(knowledgeFollowUpTools.map((tool) => tool.name)).toEqual([
      KNOWLEDGE_SEARCH_TOOL_NAME,
      KNOWLEDGE_EXACT_TOOL_NAME,
      KNOWLEDGE_READ_SOURCE_TOOL_NAME,
      KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
    ]);
    expect(knowledgeFollowUpTools.some((tool) => tool.name === KNOWLEDGE_TOOL_NAME)).toBe(false);
    expect(knowledgeFollowUpTools.every((tool) => tool.strict)).toBe(true);
    for (const tool of knowledgeFollowUpTools) {
      const properties = tool.inputSchema.properties as Record<string, unknown>;
      expect(new Set(tool.inputSchema.required as string[])).toEqual(new Set(Object.keys(properties)));
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("normalizes semantic requests and accepts only opaque admitted aliases", () => {
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        coverage: "focused",
        exactTerms: ["invoice-42"],
        purpose: null,
        query: "payment date",
        sourceAliases: ["S2"]
      },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toEqual({
      operation: "search_knowledge",
      query: "payment date invoice-42",
      search: {
        allowedLanes: ["exact", "lexical", "metadata", "semantic"],
        coverage: { expectedPassageCount: null, mode: "partial" },
        exactTerms: ["invoice-42"],
        phaseOrdinal: 0,
        plannerVersion: 2,
        purpose: "follow_up",
        rewrittenQuery: "payment date invoice-42",
        strategy: "focused",
        subqueryOrdinal: 0,
        targetNames: [],
        targetSourceIds: []
      },
      sourceAliases: ["S2"],
      targetSourceIds: []
    });
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        coverage: null,
        exactTerms: null,
        purpose: null,
        query: "payment date",
        sourceAliases: null
      },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toEqual({
      operation: "search_knowledge",
      query: "payment date",
      search: {
        allowedLanes: ["exact", "lexical", "metadata", "semantic"],
        coverage: { expectedPassageCount: null, mode: "partial" },
        exactTerms: [],
        phaseOrdinal: 0,
        plannerVersion: 2,
        purpose: "follow_up",
        rewrittenQuery: "payment date",
        strategy: "focused",
        subqueryOrdinal: 0,
        targetNames: [],
        targetSourceIds: []
      },
      sourceAliases: [],
      targetSourceIds: []
    });
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        coverage: "comparison",
        exactTerms: null,
        purpose: "follow_up",
        query: "Compare the returned passages",
        sourceAliases: null
      },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toMatchObject({
      search: { purpose: "follow_up", strategy: "comparison" }
    });
    for (const argumentsValue of [{
      coverage: "diverse",
      exactTerms: null,
      purpose: "follow_up",
      query: "broaden the result set",
      sourceAliases: null
    }, {
      coverage: "comparison",
      exactTerms: null,
      purpose: "compare_target",
      query: "compare without resolved targets",
      sourceAliases: null
    }]) {
      expect(parseKnowledgeSemanticToolRequest({
        arguments: argumentsValue,
        name: KNOWLEDGE_SEARCH_TOOL_NAME
      })).toBeNull();
    }
    const searchTool = knowledgeFollowUpTools.find((tool) =>
      tool.name === KNOWLEDGE_SEARCH_TOOL_NAME)!;
    const searchProperties = searchTool.inputSchema.properties as Record<
      string,
      { enum?: readonly unknown[] }
    >;
    expect(searchProperties.coverage?.enum).toEqual(["focused", "comparison", null]);
    expect(searchProperties.purpose?.enum).toEqual(["follow_up", null]);
    expect(parseKnowledgeSemanticToolRequest({
      arguments: { query: "payment", sourceAliases: ["source-database-id"] },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toBeNull();
    expect(parseKnowledgeSemanticToolRequest({
      arguments: { knowledgeBaseId: "base-id", query: "payment" },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toBeNull();
  });

  it("bounds read-source requests to one S alias", () => {
    expect(parseKnowledgeSemanticToolRequest({
      arguments: { direction: "after", locator: "page 9", sourceAlias: "S3", window: 4 },
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    })).toEqual({
      operation: "read_source",
      query: "page 9",
      read: {
        contractVersion: 1,
        direction: "after",
        embedding: "forbidden",
        locator: "page 9",
        resolution: "exact",
        sourceAlias: "S3",
        target: { kind: "page", page: 9 },
        window: 4
      },
      sourceAliases: ["S3"],
      targetSourceIds: []
    });
    expect(parseKnowledgeSemanticToolRequest({
      arguments: { locator: "page 9", sourceAlias: "B1" },
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    })).toBeNull();
    expect(parseKnowledgeSemanticToolRequest({
      arguments: { direction: null, locator: "page 9", sourceAlias: "S3", window: null },
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    })).toEqual({
      operation: "read_source",
      query: "page 9",
      read: {
        contractVersion: 1,
        direction: "around",
        embedding: "forbidden",
        locator: "page 9",
        resolution: "exact",
        sourceAlias: "S3",
        target: { kind: "page", page: 9 },
        window: 3
      },
      sourceAliases: ["S3"],
      targetSourceIds: []
    });
  });

  it("fails closed on malformed source locators and retains their exact normalized target", () => {
    const passageId = `kip_${"a".repeat(40)}`;
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        direction: "before",
        locator: `passage:${passageId}`,
        sourceAlias: "S1",
        window: 1
      },
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    })).toMatchObject({
      query: `passage:${passageId}`,
      read: {
        direction: "before",
        embedding: "forbidden",
        resolution: "exact",
        target: { kind: "passage", passageId },
        window: 1
      }
    });
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        direction: "around",
        locator: "range:'Q1'!a1:b4",
        sourceAlias: "S2",
        window: 8
      },
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    })).toMatchObject({
      query: "range:'Q1'!A1:B4",
      read: {
        target: { kind: "structured_range", range: "A1:B4", sheet: "Q1" }
      }
    });
    for (const locator of ["handle:K0", "page 0", "passage:unknown", "range:Q1!B2:A1"]) {
      expect(parseKnowledgeSemanticToolRequest({
        arguments: { direction: "around", locator, sourceAlias: "S1", window: 3 },
        name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
      }), locator).toBeNull();
    }
  });

  it("preserves every bounded exact and metadata-discovery selector", () => {
    const cursor = Buffer.from("1:7", "utf8").toString("base64url");
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        caseMode: "sensitive",
        cursor,
        field: "heading",
        limit: 17,
        match: "pattern",
        sourceAliases: ["S2"],
        value: "Q[1-4]"
      },
      name: KNOWLEDGE_EXACT_TOOL_NAME
    })).toMatchObject({
      exact: {
        caseMode: "sensitive",
        cursor,
        field: "heading",
        limit: 17,
        match: "pattern",
        value: "Q[1-4]"
      },
      operation: "find_exact",
      query: "Q[1-4]",
      semantic: {
        allowedLanes: ["exact"],
        exactTerms: ["Q[1-4]"],
        purpose: "follow_up"
      },
      sourceAliases: ["S2"],
      targetSourceIds: []
    });
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        cursor,
        fields: ["title", "filename", "tag"],
        limit: 9,
        query: "Quarterly"
      },
      name: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
    })).toMatchObject({
      discovery: {
        cursor,
        fields: ["filename", "tag", "title"],
        limit: 9,
        query: "Quarterly"
      },
      operation: "discover_sources",
      query: "Quarterly",
      semantic: {
        allowedLanes: ["metadata"],
        exactTerms: [],
        purpose: "source_discovery"
      },
      sourceAliases: [],
      targetSourceIds: []
    });
  });

  it("accepts the canonical automatic planner operation without reconstructing it", () => {
    const targetSourceId = "11111111-1111-4111-8111-111111111111";
    const automaticArguments = {
      coverage: { expectedPassageCount: 3, mode: "verified_only" },
      exact: {
        caseMode: "insensitive",
        cursor: null,
        field: "body",
        limit: 50,
        match: "token",
        value: "invoice-42"
      },
      exactTerms: ["invoice-42"],
      lanes: ["exact"],
      operation: "find_exact",
      phaseOrdinal: 0,
      plannerVersion: 2,
      purpose: "compare_target",
      query: "invoice-42",
      strategy: "comparison",
      subqueryOrdinal: 4,
      targetNames: ["Invoices"],
      targetResolution: {
        outcome: "resolved",
        targetSourceIds: [targetSourceId],
        targets: [{
          candidateSourceIds: [targetSourceId],
          matchKind: "source_name",
          outcome: "resolved",
          targetName: "Invoices"
        }]
      },
      targetSourceIds: [targetSourceId]
    };
    const parsed = parseKnowledgeSemanticToolRequest({
      arguments: automaticArguments,
      name: KNOWLEDGE_TOOL_NAME
    });

    expect(parsed).toMatchObject({
      exact: {
        caseMode: "insensitive",
        cursor: null,
        field: "body",
        limit: 50,
        match: "token",
        value: "invoice-42"
      },
      operation: "find_exact",
      semantic: {
        allowedLanes: ["exact"],
        coverage: { expectedPassageCount: 3, mode: "verified_only" },
        exactTerms: ["invoice-42"],
        plannerVersion: 2,
        purpose: "compare_target",
        strategy: "comparison",
        subqueryOrdinal: 4,
        targetNames: ["Invoices"],
        targetSourceIds: [targetSourceId]
      },
      targetSourceIds: [targetSourceId]
    });
    for (const contradictory of [
      { ...automaticArguments, exactTerms: ["other-token"] },
      { ...automaticArguments, query: "find another value" },
      {
        ...automaticArguments,
        exact: { ...automaticArguments.exact, value: "other-token" }
      }
    ]) {
      expect(parseKnowledgeSemanticToolRequest({
        arguments: contradictory,
        name: KNOWLEDGE_TOOL_NAME
      })).toBeNull();
    }
  });

  it("accepts only semantically equivalent automatic phrase and pattern exact values", () => {
    const common = {
      coverage: { expectedPassageCount: null, mode: "partial" },
      lanes: ["exact"],
      operation: "find_exact",
      phaseOrdinal: 0,
      plannerVersion: 2,
      purpose: "answer",
      strategy: "focused",
      subqueryOrdinal: 0,
      targetNames: [],
      targetResolution: null,
      targetSourceIds: []
    };
    const cases = [{
      exactTerms: ["\"retention period\""],
      match: "phrase" as const,
      query: "Find exact phrase \"retention period\"",
      value: "retention period"
    }, {
      exactTerms: ["/API-\\d{4}/u"],
      match: "pattern" as const,
      query: "Find /API-\\d{4}/u",
      value: "API-\\d{4}"
    }];

    for (const candidate of cases) {
      const argumentsValue = {
        ...common,
        exact: {
          caseMode: "sensitive",
          cursor: null,
          field: "body",
          limit: 50,
          match: candidate.match,
          value: candidate.value
        },
        exactTerms: candidate.exactTerms,
        query: candidate.query
      };
      expect(parseKnowledgeSemanticToolRequest({
        arguments: argumentsValue,
        name: KNOWLEDGE_TOOL_NAME
      })).toMatchObject({ exact: { match: candidate.match, value: candidate.value } });
      expect(parseKnowledgeSemanticToolRequest({
        arguments: { ...argumentsValue, exactTerms: ["different exact value"] },
        name: KNOWLEDGE_TOOL_NAME
      })).toBeNull();
      expect(parseKnowledgeSemanticToolRequest({
        arguments: { ...argumentsValue, exactTerms: [candidate.value] },
        name: KNOWLEDGE_TOOL_NAME
      })).not.toBeNull();
    }
  });

  it("strictly parses planner-owned structured and visual automatic operations", async () => {
    const structuredArguments = await automaticPlannerArguments(
      "Calculate the median CSV column in Sales.xlsx"
    );
    const visualArguments = await automaticPlannerArguments(
      "What does the chart in Report.pdf show?",
      { fileName: "Report.pdf", sourceName: "Report" }
    );

    expect(parseKnowledgeSemanticToolRequest({
      arguments: structuredArguments,
      name: KNOWLEDGE_TOOL_NAME
    })).toMatchObject({
      operation: "structured_analysis",
      semantic: {
        allowedLanes: [],
        plannerVersion: 2,
        purpose: "answer",
        targetSourceIds: [automaticTargetSourceId]
      },
      structured: {
        query: "Calculate the median CSV column in Sales.xlsx",
        selector: {
          columns: [],
          includeHidden: false,
          operation: null,
          range: null,
          sheet: null
        },
        targetSourceIds: [automaticTargetSourceId]
      },
      targetSourceIds: [automaticTargetSourceId]
    });
    expect(parseKnowledgeSemanticToolRequest({
      arguments: visualArguments,
      name: KNOWLEDGE_TOOL_NAME
    })).toMatchObject({
      operation: "visual_analysis",
      semantic: { allowedLanes: [], targetSourceIds: [automaticTargetSourceId] },
      visual: {
        query: "What does the chart in Report.pdf show?",
        selector: null,
        targetSourceIds: [automaticTargetSourceId]
      }
    });

    const variants = knowledgeRetrievalTool.inputSchema.oneOf as Array<{
      properties: { operation: { enum: readonly string[] } };
    }>;
    expect(variants.map((variant) => variant.properties.operation.enum[0])).toEqual([
      "automatic_search",
      "find_exact",
      "discover_sources",
      "structured_analysis",
      "visual_analysis"
    ]);
  });

  it("fails closed when an automatic analysis selector or target drifts", async () => {
    const structured = await automaticPlannerArguments(
      "Calculate the median CSV column in Sales.xlsx"
    );
    const visual = await automaticPlannerArguments(
      "What does the chart in Report.pdf show?",
      { fileName: "Report.pdf", sourceName: "Report" }
    );
    const otherSourceId = "22222222-2222-4222-8222-222222222222";

    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        ...structured,
        structured: {
          ...(structured.operation === "structured_analysis" ? structured.structured : {}),
          selector: {
            columns: [],
            includeHidden: true,
            operation: null,
            range: null,
            sheet: null
          }
        }
      },
      name: KNOWLEDGE_TOOL_NAME
    })).toBeNull();
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        ...structured,
        structured: {
          ...(structured.operation === "structured_analysis" ? structured.structured : {}),
          targetSourceIds: [otherSourceId]
        }
      },
      name: KNOWLEDGE_TOOL_NAME
    })).toBeNull();
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        ...visual,
        visual: {
          ...(visual.operation === "visual_analysis" ? visual.visual : {}),
          selector: { page: 1 }
        }
      },
      name: KNOWLEDGE_TOOL_NAME
    })).toBeNull();
  });

  it("rejects non-canonical cursors and incomplete strict exact/discovery calls", () => {
    expect(parseKnowledgeSemanticToolRequest({
      arguments: {
        caseMode: "insensitive",
        cursor: "not-a-cursor",
        field: "any",
        limit: 10,
        match: "phrase",
        sourceAliases: null,
        value: "needle"
      },
      name: KNOWLEDGE_EXACT_TOOL_NAME
    })).toBeNull();
    expect(parseKnowledgeSemanticToolRequest({
      arguments: { cursor: null, fields: ["filename"], query: "needle" },
      name: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
    })).toBeNull();
  });
});
