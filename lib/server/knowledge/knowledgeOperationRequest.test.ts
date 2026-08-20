import { describe, expect, it } from "vitest";
import { normalizeReadSourceRequest } from "./readSourceLocator";
import {
  canonicalKnowledgeOperationRequestV2,
  createKnowledgeOperationRequestV2,
  decodeKnowledgeOperationRequestV2,
  hashKnowledgeOperationRequestV2,
  knowledgeOperationTargetSourceIds,
  KNOWLEDGE_OPERATION_REQUEST_VERSION
} from "./knowledgeOperationRequest";

const originalQueryId = "11111111-1111-4111-8111-111111111111";
const firstSourceId = "22222222-2222-4222-8222-222222222222";
const secondSourceId = "33333333-3333-4333-8333-333333333333";
const reservationId = "44444444-4444-4444-8444-444444444444";
const profileRevisionId = "55555555-5555-4555-8555-555555555555";

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: "run:1:phase:0:subquery:1",
    operation: "search_knowledge",
    originalQuery: { reference: originalQueryId, sha256: "a".repeat(64) },
    phaseOrdinal: 0,
    plannerVersion: 2,
    profileRevisionId,
    profileRevisionNumber: 7,
    purpose: "compare_target",
    reservationId,
    resolvedSourceIds: [secondSourceId, firstSourceId],
    sourceAliases: ["S2", "B1"],
    subqueryOrdinal: 1,
    version: KNOWLEDGE_OPERATION_REQUEST_VERSION,
    ...overrides
  };
}

function plannerProjection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    allowedLanes: ["semantic", "exact", "lexical"],
    coverage: { expectedPassageCount: 4, mode: "verified_only" },
    exactTerms: ["Zephyr", "Atlas"],
    rewrittenQuery: "Compare Atlas and Zephyr",
    strategy: "comparison",
    targetNames: ["Zephyr", "Atlas"],
    targetSourceIds: [secondSourceId, firstSourceId],
    ...overrides
  };
}

function search(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return envelope({
    search: plannerProjection(),
    ...overrides
  });
}

describe("Knowledge operation request v2 discriminated contract", () => {
  it("decodes search semantics without flattening or losing planner provenance", () => {
    const decoded = decodeKnowledgeOperationRequestV2(search());

    expect(decoded).toEqual({
      ...search(),
      resolvedSourceIds: [firstSourceId, secondSourceId],
      search: {
        ...(search().search as Record<string, unknown>),
        allowedLanes: ["exact", "lexical", "semantic"],
        exactTerms: ["Atlas", "Zephyr"],
        targetNames: ["Atlas", "Zephyr"],
        targetSourceIds: [firstSourceId, secondSourceId]
      },
      sourceAliases: ["B1", "S2"]
    });
    expect(decoded?.operation === "search_knowledge" && decoded.search.strategy)
      .toBe("comparison");
    expect(decoded && knowledgeOperationTargetSourceIds(decoded))
      .toEqual([firstSourceId, secondSourceId]);
    expect(Object.isFrozen(decoded)).toBe(true);
    expect(Object.isFrozen(decoded?.resolvedSourceIds)).toBe(true);
    expect(createKnowledgeOperationRequestV2(search())).toEqual(decoded);
    expect(decodeKnowledgeOperationRequestV2(search({ operation: "automatic_search" })))
      .toMatchObject({ operation: "automatic_search" });
  });

  it("uses one canonical hash for object-key and set-valued array order", () => {
    const first = search();
    const second = Object.fromEntries(Object.entries(search({
      resolvedSourceIds: [firstSourceId, secondSourceId],
      search: {
        allowedLanes: ["lexical", "semantic", "exact"],
        coverage: { expectedPassageCount: 4, mode: "verified_only" },
        exactTerms: ["Atlas", "Zephyr"],
        rewrittenQuery: "Compare Atlas and Zephyr",
        strategy: "comparison",
        targetNames: ["Atlas", "Zephyr"],
        targetSourceIds: [firstSourceId, secondSourceId]
      },
      sourceAliases: ["B1", "S2"]
    })).reverse());

    expect(canonicalKnowledgeOperationRequestV2(first))
      .toBe(canonicalKnowledgeOperationRequestV2(second));
    expect(hashKnowledgeOperationRequestV2(first)).toMatch(/^[0-9a-f]{64}$/u);
    expect(hashKnowledgeOperationRequestV2(first)).toBe(hashKnowledgeOperationRequestV2(second));
    expect(hashKnowledgeOperationRequestV2(search({
      search: {
        ...(search().search as Record<string, unknown>),
        rewrittenQuery: "Different query"
      }
    }))).not.toBe(hashKnowledgeOperationRequestV2(first));
  });

  it("retains exact match, case, field, cursor, and limit as one strict variant", () => {
    const request = envelope({
      exact: {
        caseMode: "sensitive",
        cursor: "next:exact-2",
        field: "body",
        limit: 25,
        match: "pattern",
        value: "INV-[0-9]+"
      },
      operation: "find_exact",
      plan: plannerProjection({
        allowedLanes: ["exact"],
        coverage: { expectedPassageCount: null, mode: "partial" },
        exactTerms: ["/INV-[0-9]+/"],
        rewrittenQuery: "Find /INV-[0-9]+/",
        strategy: "focused",
        targetNames: ["Invoices"],
        targetSourceIds: [firstSourceId]
      }),
      purpose: "follow_up",
      sourceAliases: ["S1"]
    });

    expect(decodeKnowledgeOperationRequestV2(request)).toMatchObject({
      exact: {
        caseMode: "sensitive",
        cursor: "next:exact-2",
        field: "body",
        limit: 25,
        match: "pattern",
        value: "INV-[0-9]+"
      },
      operation: "find_exact",
      plan: {
        allowedLanes: ["exact"],
        exactTerms: ["/INV-[0-9]+/"],
        rewrittenQuery: "Find /INV-[0-9]+/",
        targetNames: ["Invoices"],
        targetSourceIds: [firstSourceId]
      }
    });
    const decoded = decodeKnowledgeOperationRequestV2(request);
    expect(decoded && knowledgeOperationTargetSourceIds(decoded)).toEqual([firstSourceId]);
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      exact: { ...(request.exact as object), field: "provider_payload" }
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      exact: { ...(request.exact as object), unknown: true }
    })).toBeNull();
    for (const plan of [
      plannerProjection({
        ...(request.plan as object),
        exactTerms: ["DIFFERENT-[0-9]+"]
      }),
      { ...(request.plan as object), allowedLanes: ["lexical"] },
      { ...(request.plan as object), rewrittenQuery: "Find another pattern" }
    ]) {
      expect(decodeKnowledgeOperationRequestV2({ ...request, plan })).toBeNull();
    }
  });

  it("retains the complete normalized deterministic read contract", () => {
    const read = normalizeReadSourceRequest({
      direction: "after",
      locator: "range:'Q1'!a1:b4",
      window: 3
    });
    if (!read) throw new Error("read_fixture_invalid");
    const request = envelope({
      operation: "read_source",
      purpose: "follow_up",
      read,
      resolvedSourceIds: [firstSourceId],
      sourceAliases: ["S1"]
    });

    expect(decodeKnowledgeOperationRequestV2(request)).toMatchObject({
      read: {
        contractVersion: 1,
        direction: "after",
        embedding: "forbidden",
        locator: "range:'Q1'!A1:B4",
        resolution: "exact",
        target: { kind: "structured_range", range: "A1:B4", sheet: "Q1" },
        window: 3
      }
    });
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      read: { ...read, embedding: "allowed" }
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      read: { ...read, target: { kind: "page", page: 1 } }
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      read: {
        ...read,
        target: Object.fromEntries(Object.entries(read.target).reverse())
      }
    })).not.toBeNull();
  });

  it("limits discovery to explicit admitted metadata fields and cursor semantics", () => {
    const request = envelope({
      discovery: {
        cursor: null,
        fields: ["title", "filename", "source_name", "heading", "tag"],
        limit: 40,
        query: "Q4 policy"
      },
      operation: "discover_sources",
      plan: plannerProjection({
        allowedLanes: ["metadata"],
        coverage: { expectedPassageCount: null, mode: "partial" },
        exactTerms: [],
        rewrittenQuery: "Q4 policy",
        strategy: "focused",
        targetNames: [],
        targetSourceIds: []
      }),
      purpose: "source_discovery",
      sourceAliases: []
    });
    const decoded = decodeKnowledgeOperationRequestV2(request);

    expect(decoded?.operation === "discover_sources" && decoded.discovery).toEqual({
      cursor: null,
      fields: ["filename", "heading", "source_name", "tag", "title"],
      limit: 40,
      query: "Q4 policy"
    });
    expect(decoded?.operation === "discover_sources" && decoded.plan).toMatchObject({
      allowedLanes: ["metadata"],
      exactTerms: [],
      rewrittenQuery: "Q4 policy",
      targetNames: [],
      targetSourceIds: []
    });
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      discovery: { ...(request.discovery as object), fields: ["body"] }
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      plan: { ...(request.plan as object), rewrittenQuery: "Different metadata query" }
    })).toBeNull();
  });

  it("retains structured selector hints without resolving a plan before reservation", () => {
    const request = envelope({
      operation: "structured_analysis",
      plan: plannerProjection({
        allowedLanes: [],
        coverage: { expectedPassageCount: null, mode: "partial" },
        exactTerms: [],
        rewrittenQuery: "Sum Revenue on Q1",
        strategy: "structured_data",
        targetNames: ["Sales workbook"],
        targetSourceIds: [firstSourceId]
      }),
      purpose: "answer",
      structured: {
        query: "Sum Revenue on Q1",
        selector: {
          columns: ["Revenue", "Cost"],
          includeHidden: false,
          operation: "aggregate",
          range: "A1:B4",
          sheet: "Q1"
        },
        targetSourceIds: [firstSourceId]
      }
    });
    const decoded = decodeKnowledgeOperationRequestV2(request);

    expect(decoded?.operation === "structured_analysis" && decoded.structured)
      .toMatchObject({
        selector: {
          columns: ["Revenue", "Cost"],
          includeHidden: false,
          operation: "aggregate",
          range: "A1:B4",
          sheet: "Q1"
        },
        targetSourceIds: [firstSourceId]
      });
    expect(decoded?.operation === "structured_analysis" && decoded.plan).toMatchObject({
      allowedLanes: [],
      exactTerms: [],
      rewrittenQuery: "Sum Revenue on Q1",
      strategy: "structured_data",
      targetNames: ["Sales workbook"],
      targetSourceIds: [firstSourceId]
    });
    expect(decoded && knowledgeOperationTargetSourceIds(decoded)).toEqual([firstSourceId]);
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      structured: {
        ...(request.structured as Record<string, unknown>),
        targetSourceIds: ["66666666-6666-4666-8666-666666666666"]
      }
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      plan: { ...(request.plan as object), allowedLanes: ["semantic"] }
    })).toBeNull();
  });

  it("retains ordered visual hints and canonicalizes an absent selector to null", () => {
    const request = envelope({
      operation: "visual_analysis",
      plan: plannerProjection({
        allowedLanes: [],
        coverage: { expectedPassageCount: null, mode: "partial" },
        exactTerms: [],
        rewrittenQuery: "Read the revenue chart on page 2",
        strategy: "focused",
        targetNames: ["Quarterly report"],
        targetSourceIds: [secondSourceId]
      }),
      purpose: "answer",
      visual: {
        query: "Read the revenue chart on page 2",
        selector: {
          assetId: null,
          blockId: "b_1234567890abcdef12345678_1",
          headingPath: ["Results", "Results"],
          kind: "chart",
          page: 2
        },
        targetSourceIds: [secondSourceId]
      }
    });
    const decoded = decodeKnowledgeOperationRequestV2(request);

    expect(decoded?.operation === "visual_analysis" && decoded.visual)
      .toMatchObject({
        selector: { headingPath: ["Results", "Results"], kind: "chart", page: 2 },
        targetSourceIds: [secondSourceId]
      });
    expect(decoded?.operation === "visual_analysis" && decoded.plan).toMatchObject({
      allowedLanes: [],
      exactTerms: [],
      rewrittenQuery: "Read the revenue chart on page 2",
      targetNames: ["Quarterly report"],
      targetSourceIds: [secondSourceId]
    });
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      visual: {
        ...(request.visual as Record<string, unknown>),
        selector: null
      }
    })).toMatchObject({ visual: { selector: null } });
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      visual: {
        ...(request.visual as Record<string, unknown>),
        selector: {
          assetId: null,
          blockId: null,
          headingPath: [],
          kind: null,
          page: null
        }
      }
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...request,
      plan: { ...(request.plan as object), targetSourceIds: [firstSourceId] }
    })).toBeNull();
  });

  it("rejects unknown, cross-variant, partial, and privacy-expanding fields", () => {
    expect(decodeKnowledgeOperationRequestV2({ ...search(), unknown: true })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({ ...search(), exact: {} })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2({
      ...search(),
      originalQuery: {
        raw: "must not be copied",
        reference: originalQueryId,
        sha256: "a".repeat(64)
      }
    })).toBeNull();
    expect(decodeKnowledgeOperationRequestV2(search({
      search: {
        ...(search().search as Record<string, unknown>),
        exactTerms: ["Atlas", "Atlas"]
      }
    }))).toBeNull();
    expect(decodeKnowledgeOperationRequestV2(search({ plannerVersion: 0 }))).toBeNull();
    expect(decodeKnowledgeOperationRequestV2(search({ resolvedSourceIds: [] }))).toBeNull();
    expect(decodeKnowledgeOperationRequestV2(search({
      search: {
        ...(search().search as Record<string, unknown>),
        targetSourceIds: ["66666666-6666-4666-8666-666666666666"]
      }
    }))).toBeNull();
    expect(() => canonicalKnowledgeOperationRequestV2({})).toThrow(
      "knowledge_operation_request_v2_invalid"
    );
  });
});
