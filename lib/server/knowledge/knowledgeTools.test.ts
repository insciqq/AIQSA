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
  KNOWLEDGE_READ_SOURCE_TOOL_NAME,
  KNOWLEDGE_SEARCH_TOOL_NAME
} from "./retrievalTypes";

describe("Knowledge request parsing", () => {
  it("advertises and accepts only the strict model-facing query shape", () => {
    expect(knowledgeRetrievalTool).toMatchObject({
      capability: "knowledge",
      inputSchema: {
        additionalProperties: false,
        required: ["query", "sourceAliases"]
      },
      name: KNOWLEDGE_SEARCH_TOOL_NAME,
      strict: true
    });
    expect(knowledgeRetrievalTool.description).toContain(
      "Copy every discriminating proper name, identifier, date, number, unit"
    );
    expect(knowledgeRetrievalTool.description).toContain(
      "Do not translate, synonymize, generalize, or reformat"
    );
    expect(knowledgeRetrievalTool.description).toContain(
      "even when the user does not explicitly say to consult Knowledge"
    );
    expect(knowledgeRetrievalTool.description).toContain(
      "search one item at a time and make another call for every requested item"
    );
    expect(knowledgeRetrievalTool.description).toContain(
      "Pass sourceAliases as [] on the first search"
    );
    expect(knowledgeRetrievalTool.description).toContain(
      "Before declaring a multi-item request unsupported"
    );
    expect(knowledgeRetrievalTool.description).toContain("character-for-character");
    expect(knowledgeRetrievalTool.description).toContain("leading zeroes");
    expect(knowledgeRetrievalTool.description).toContain(
      "retain the exact supported operands and units"
    );
    expect(knowledgeRetrievalTool.description).toContain("report ambiguity instead of guessing");
    expect(parseKnowledgeExecutionRequest({
      arguments: { query: "Что сказано about SLA 99.9%?", sourceAliases: [] },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toEqual({
      operation: "automatic_search",
      query: "Что сказано about SLA 99.9%?",
      sourceAliases: []
    });
    expect(parseKnowledgeExecutionRequest({
      arguments: { query: "SLA 99.9%", sourceAliases: ["S2"] },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toEqual({
      operation: "automatic_search",
      query: "SLA 99.9%",
      sourceAliases: ["S2"]
    });
    expect(parseKnowledgeExecutionRequest({
      arguments: { query: "  SLA\u00a099.9％  ", sourceAliases: [] },
      name: KNOWLEDGE_SEARCH_TOOL_NAME
    })).toEqual({
      operation: "automatic_search",
      query: "SLA 99.9%",
      sourceAliases: []
    });
    for (const arguments_ of [
      {},
      { query: "" },
      { query: "  " },
      { baseIds: ["base-1"], query: "SLA" },
      { candidateLimit: 40, query: "SLA" },
      { query: "SLA\u0000hidden", sourceAliases: [] },
      { query: "x".repeat(3_001), sourceAliases: [] },
      { query: "SLA", sourceAliases: ["S0"] },
      { query: "SLA", sourceAliases: ["S1", "S1"] }
    ]) {
      expect(parseKnowledgeExecutionRequest({
        arguments: arguments_,
        name: KNOWLEDGE_SEARCH_TOOL_NAME
      })).toBeNull();
    }
  });

  it("retains exact historical focused decoding", () => {
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
    for (const name of ["retrieve_knowledge", "structured_analysis",
      "visual_analysis"]) {
      expect(parseKnowledgeExecutionRequest({ arguments: {}, name })).toBeNull();
    }
  });
});
