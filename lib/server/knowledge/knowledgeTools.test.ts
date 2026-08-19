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
  parseKnowledgeSemanticToolRequest
} from "./knowledgeTools";

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
        query: "payment date",
        sourceAliases: ["S2"]
      },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toEqual({
      operation: "search_knowledge",
      query: "payment date invoice-42",
      sourceAliases: ["S2"]
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
      sourceAliases: []
    });
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
      sourceAliases: ["S3"]
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
      sourceAliases: ["S3"]
    });
  });
});
