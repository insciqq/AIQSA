import { describe, expect, it } from "vitest";
import { createKnowledgeFocusedRequest } from "./focusedRequest";
import {
  canonicalKnowledgeOperationRequestV2,
  createKnowledgeOperationRequestV2,
  decodeKnowledgeOperationRequestV2,
  hashKnowledgeOperationRequestV2,
  knowledgeOperationTargetSourceIds,
  KNOWLEDGE_OPERATION_REQUEST_VERSION
} from "./knowledgeOperationRequest";
import { normalizeReadSourceRequest } from "./readSourceLocator";

const SOURCE_ID = "00000000-0000-4000-8000-000000000001";
const PROFILE_ID = "00000000-0000-4000-8000-000000000002";
const RESERVATION_ID = "00000000-0000-4000-8000-000000000003";

function envelope(operation: string, sourceAliases: readonly string[] = []) {
  return {
    idempotencyKey: "knowledge-operation:call-1",
    operation,
    originalQuery: { reference: "message-1", sha256: "a".repeat(64) },
    phaseOrdinal: 0,
    profileRevisionId: PROFILE_ID,
    profileRevisionNumber: 1,
    reservationId: RESERVATION_ID,
    resolvedSourceIds: [SOURCE_ID],
    sourceAliases,
    subqueryOrdinal: 0,
    version: KNOWLEDGE_OPERATION_REQUEST_VERSION
  };
}

describe("Knowledge operation request", () => {
  it("persists the exact focused request without planning metadata", () => {
    const focused = createKnowledgeFocusedRequest({ currentUserMessage: "Вопрос about SLA" })!;
    const request = createKnowledgeOperationRequestV2({
      ...envelope("automatic_search"),
      focused
    });

    expect(request).toMatchObject({ focused, operation: "automatic_search" });
    expect(knowledgeOperationTargetSourceIds(request)).toEqual([SOURCE_ID]);
    expect(hashKnowledgeOperationRequestV2(request)).toMatch(/^[0-9a-f]{64}$/u);
    expect(canonicalKnowledgeOperationRequestV2(request)).not.toContain("planner");
  });

  it("decodes the three separately authorized internal primitives", () => {
    const exact = createKnowledgeOperationRequestV2({
      ...envelope("find_exact", ["S1"]),
      exact: {
        caseMode: "sensitive",
        cursor: null,
        field: "body",
        limit: 10,
        match: "phrase",
        value: "SLA 99.9%"
      }
    });
    const read = createKnowledgeOperationRequestV2({
      ...envelope("read_source", ["S1"]),
      read: normalizeReadSourceRequest({ locator: "page: 3", window: 3 })
    });
    const discovery = createKnowledgeOperationRequestV2({
      ...envelope("discover_sources"),
      discovery: { cursor: null, fields: ["filename", "title"], limit: 5, query: "policy" }
    });

    expect(exact.operation).toBe("find_exact");
    expect(read.operation).toBe("read_source");
    expect(discovery.operation).toBe("discover_sources");
    expect(knowledgeOperationTargetSourceIds(discovery)).toEqual([]);
  });

  it("rejects retired operation variants and mixed fields", () => {
    const focused = createKnowledgeFocusedRequest({ currentUserMessage: "Question" })!;
    expect(decodeKnowledgeOperationRequestV2({
      ...envelope("search_knowledge"),
      focused
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...envelope("automatic_search"),
      focused,
      visual: { query: "chart" }
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...envelope("automatic_search"),
      focused,
      phaseOrdinal: 1
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...envelope("automatic_search"),
      focused,
      subqueryOrdinal: 1
    })).toBeNull();
  });
});
