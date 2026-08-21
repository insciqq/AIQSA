import { describe, expect, it } from "vitest";
import { createKnowledgeFocusedRequest } from "./focusedRequest";
import {
  knowledgeRetrievalTool,
  parseKnowledgeExecutionRequest
} from "./knowledgeTools";
import {
  KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME,
  KNOWLEDGE_EXACT_TOOL_NAME,
  KNOWLEDGE_FOCUSED_OPERATION_NAME,
  KNOWLEDGE_READ_SOURCE_TOOL_NAME
} from "./retrievalTypes";

describe("focused Knowledge request parsing", () => {
  it("accepts the exact persisted focused request", () => {
    const focused = createKnowledgeFocusedRequest({
      currentUserMessage: "Что сказано about SLA 99.9%?"
    });
    expect(focused).not.toBeNull();
    expect(parseKnowledgeExecutionRequest({
      arguments: focused!,
      name: KNOWLEDGE_FOCUSED_OPERATION_NAME
    })).toEqual({
      focused,
      operation: "automatic_search",
      query: "Что сказано about SLA 99.9%?",
      sourceAliases: []
    });
    expect(knowledgeRetrievalTool.name).toBe(KNOWLEDGE_FOCUSED_OPERATION_NAME);
  });

  it("keeps exact/read/discover as bounded internal primitives", () => {
    expect(parseKnowledgeExecutionRequest({
      arguments: {
        caseMode: "sensitive",
        cursor: null,
        field: "body",
        limit: 5,
        match: "phrase",
        sourceAliases: ["S1"],
        value: "SLA 99.9%"
      },
      name: KNOWLEDGE_EXACT_TOOL_NAME
    })?.operation).toBe("find_exact");

    expect(parseKnowledgeExecutionRequest({
      arguments: { direction: "around", locator: "page: 3", sourceAlias: "S1", window: 3 },
      name: KNOWLEDGE_READ_SOURCE_TOOL_NAME
    })).toMatchObject({ operation: "read_source", sourceAliases: ["S1"] });

    expect(parseKnowledgeExecutionRequest({
      arguments: { cursor: null, fields: ["title", "filename"], limit: 5, query: "policy" },
      name: KNOWLEDGE_DISCOVER_SOURCES_TOOL_NAME
    })).toMatchObject({ operation: "discover_sources", sourceAliases: [] });
  });

  it("rejects retired model-callable operation names", () => {
    for (const name of ["retrieve_knowledge", "search_knowledge", "structured_analysis",
      "visual_analysis"]) {
      expect(parseKnowledgeExecutionRequest({ arguments: {}, name })).toBeNull();
    }
  });
});
