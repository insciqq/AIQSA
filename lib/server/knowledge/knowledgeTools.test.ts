import { describe, expect, it } from "vitest";
import { createKnowledgeFocusedRequest } from "./focusedRequest";
import {
  knowledgeRetrievalTool,
  knowledgeRetrievalToolV2,
  knowledgeRetrievalToolsForRequest,
  normalizeKnowledgeAnchorQuery,
  normalizeKnowledgeQuery,
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
  it("retains both ends of a long original question without relaxing model-query validation", () => {
    const question = `Explain the sensor behavior.\n${"🧠測定 ".repeat(800)}\nThe required output is an ordered list.`;
    const anchor = normalizeKnowledgeAnchorQuery(question, 2)!;
    expect([...anchor]).toHaveLength(3_000);
    expect(anchor).toMatch(/^Explain the sensor behavior\./u);
    expect(anchor).toMatch(/The required output is an ordered list\.$/u);
    expect(anchor).toContain("\n[...]\n");
    expect(anchor).not.toMatch(/\p{Surrogate}/u);
    expect(normalizeKnowledgeQuery(question)).toBeNull();
    expect(normalizeKnowledgeAnchorQuery(question)).toBeNull();
    expect(normalizeKnowledgeAnchorQuery("  Ａ short question 🧠  ", 2)).toBe("A short question 🧠");
    expect(normalizeKnowledgeAnchorQuery("a".repeat(3_000), 2)).toBe("a".repeat(3_000));
  });

  it("rejects unsafe controls in omitted original text and unknown anchor policies", () => {
    const question = `${"a".repeat(2_000)}\u0000${"z".repeat(2_000)}`;
    expect(normalizeKnowledgeAnchorQuery(question, 2)).toBeNull();
    expect(normalizeKnowledgeAnchorQuery("  \n  ", 2)).toBeNull();
    expect(() => normalizeKnowledgeAnchorQuery("valid", 3 as 2))
      .toThrow("knowledge_query_anchor_version_invalid");
  });

  it.each([2, 3] as const)("pins search instructions %s without mutating historical or other tool descriptors", knowledgeSearchInstructionVersion => {
    const original = structuredClone(knowledgeRetrievalTool);
    const other = { ...knowledgeRetrievalTool, capability: "search" as const, name: "search_engine_1" };
    const tools = [knowledgeRetrievalTool, other];
    expect(knowledgeRetrievalToolsForRequest({}, tools)).toBe(tools);
    const revised = knowledgeRetrievalToolsForRequest({ knowledgeSearchInstructionVersion }, tools);
    expect(revised[0]).toEqual({ ...original, description: knowledgeRetrievalToolV2.description });
    expect(revised[0]?.description).not.toBe(original.description);
    expect(revised[1]).toBe(other);
    expect(knowledgeRetrievalTool).toEqual(original);
    expect(knowledgeRetrievalToolsForRequest({}, tools)[0]).toEqual(original);
    expect(() => knowledgeRetrievalToolsForRequest({
      knowledgeSearchInstructionVersion: 4 as 2 | 3
    }, tools)).toThrow("knowledge_search_instruction_version_invalid");
  });

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
    expect(knowledgeRetrievalTool.description).toContain(
      "separate private answer-draft and grounding stage"
    );
    expect(knowledgeRetrievalTool.description).toContain(
      "do not use this tool contract to author the final answer"
    );
    expect(knowledgeRetrievalTool.description).not.toContain("Answer only the requested claims");
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
