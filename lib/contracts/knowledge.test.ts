import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeBaseCreate,
  decodeKnowledgeBaseDetail,
  decodeKnowledgeBaseDetailResponse,
  decodeKnowledgeBaseLifecycle,
  decodeKnowledgeBaseListResponse,
  decodeKnowledgeBasePublication,
  decodeKnowledgeBasePublicationResponse,
  decodeKnowledgeBaseSummary,
  decodeKnowledgeBaseUpdate,
  decodeKnowledgeDeletionResponse,
  decodeKnowledgeCitationHandle,
  decodeKnowledgePlan,
  decodeKnowledgeSelection,
  decodeKnowledgeSourceDetail,
  decodeKnowledgeSourceDetailResponse,
  decodeKnowledgeSourceDuplicate,
  decodeKnowledgeSourceDuplicateResponse,
  decodeKnowledgeSourceListResponse,
  decodeKnowledgeSourceLifecycle,
  decodeKnowledgeSourceMembership,
  decodeKnowledgeSourceMove,
  decodeKnowledgeSourceSummary,
  decodeKnowledgeSourceUpdate,
  knowledgeCitationHandlesFromText
} from "./knowledge";

const ready = {
  attentionSources: 0,
  processingSources: 0,
  readySources: 2,
  state: "ready",
  supportReference: null,
  totalSources: 2
} as const;

function summary() {
  return {
    archived: false,
    deletionPending: false,
    description: "Team references",
    sourceCount: 2,
    id: "base-1",
    name: "Product docs",
    owned: true,
    ownerDisplayName: "Owner",
    purgeScheduledAt: null,
    readiness: ready,
    scope: { kind: "owner" as const },
    trashed: false,
    trashedAt: null,
    updatedAt: "2026-08-18T10:00:00.000Z",
    version: 3
  };
}

function sourceVersion(overrides: Record<string, unknown> = {}) {
  return {
    byteSize: 2_048,
    createdAt: "2026-08-18T10:00:00.000Z",
    fileName: "guide.md",
    isCurrent: true,
    isPending: false,
    pageCount: 4,
    readiness: { state: "ready", supportReference: null, warningCodes: [] },
    versionNumber: 2,
    ...overrides
  };
}

function sourceSummary(overrides: Record<string, unknown> = {}) {
  return {
    currentVersion: sourceVersion(),
    deletionPending: false,
    description: "Canonical product guide",
    id: "source-1",
    membershipCount: 2,
    name: "Product guide",
    owned: true,
    ownerDisplayName: "Owner",
    purgeScheduledAt: null,
    readiness: { state: "ready", supportReference: null, warningCodes: [] },
    replacement: { state: "none", supportReference: null },
    tags: ["product", "guide"],
    trashed: false,
    trashedAt: null,
    updatedAt: "2026-08-18T10:00:00.000Z",
    version: 3,
    ...overrides
  };
}

describe("Knowledge client-safe contracts", () => {
  it("normalizes legacy Base plans into the canonical mixed selection", () => {
    expect(decodeKnowledgePlan({ baseIds: ["base-1", "base-2"] })).toEqual({
      ok: true,
      plan: {
        baseIds: ["base-1", "base-2"],
        mode: "explicit",
        sourceIds: [],
        version: 1
      }
    });
    expect(decodeKnowledgePlan({ baseIds: [] })).toEqual({
      ok: true,
      plan: { baseIds: [], mode: "none", sourceIds: [], version: 1 }
    });
    expect(decodeKnowledgePlan({ baseIds: ["base-1", "base-1"] })).toEqual({
      code: "knowledge_plan_invalid",
      ok: false
    });
    expect(decodeKnowledgePlan({ baseIds: [], generationId: "private" })).toMatchObject({
      ok: false
    });
  });

  it("keeps legacy Base plans read-only", () => {
    expect(decodeKnowledgeSelection({ baseIds: ["base-1"] })).toEqual({
      code: "knowledge_plan_invalid",
      ok: false
    });
    expect(decodeKnowledgeSelection({
      baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1
    })).toMatchObject({ ok: true });
  });

  it("accepts invocation-independent v2 handles and legacy historical handles", () => {
    expect(decodeKnowledgeCitationHandle("K1")).toEqual({ evidenceOrdinal: 1, handle: "K1" });
    expect(decodeKnowledgeCitationHandle("K2048")).toEqual({
      evidenceOrdinal: 2048,
      handle: "K2048"
    });
    expect(decodeKnowledgeCitationHandle("K4.1")).toMatchObject({ invocationOrdinal: 4 });
    expect(decodeKnowledgeCitationHandle("K256.8")).toEqual({
      handle: "K256.8",
      invocationOrdinal: 256,
      resultOrdinal: 8
    });
    for (const value of [
      "K0", "K01", "K2049", "K0.1", "K01.1", "K257.1", "K1.9", "K1.0", "K1.01"
    ]) {
      expect(decodeKnowledgeCitationHandle(value)).toBeNull();
    }
    expect(knowledgeCitationHandlesFromText(
      "Supported [K1], repeated [K1], legacy [K4.1], bare K5, and [K2048]."
    )).toEqual(["K1", "K1", "K4.1", "K2048"]);
  });

  it("accepts explicit Sources and constant-size All/inherited selections", () => {
    expect(decodeKnowledgePlan({
      baseIds: ["base-1"],
      mode: "explicit",
      sourceIds: ["source-1", "source-2"],
      version: 1
    })).toEqual({
      ok: true,
      plan: {
        baseIds: ["base-1"],
        mode: "explicit",
        sourceIds: ["source-1", "source-2"],
        version: 1
      }
    });
    expect(decodeKnowledgePlan({
      baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: 1
    })).toMatchObject({ ok: true, plan: { mode: "all_my_knowledge" } });
    expect(decodeKnowledgePlan({
      baseIds: [], inheritedFrom: "assistant", mode: "inherited", sourceIds: [], version: 1
    })).toMatchObject({ ok: true, plan: { inheritedFrom: "assistant", mode: "inherited" } });
  });

  it("rejects malformed, oversized, contradictory, and unbounded selections", () => {
    for (const value of [
      null,
      undefined,
      {},
      { baseIds: "base-1" },
      { baseIds: Array.from({ length: 129 }, (_, index) => `base-${index}`) },
      { baseIds: ["base 1"] },
      { baseIds: [], ownerUserId: "attacker" },
      { baseIds: [], mode: "explicit", sourceIds: [], version: 1 },
      { baseIds: ["base-1"], mode: "all_my_knowledge", sourceIds: [], version: 1 },
      { baseIds: [], inheritedFrom: "project", mode: "none", sourceIds: [], version: 1 },
      { baseIds: [], inheritedFrom: "personal", mode: "inherited", sourceIds: [], version: 1 },
      { baseIds: [], mode: "all_my_knowledge", ownerUserId: "attacker", sourceIds: [], version: 1 }
    ]) {
      expect(decodeKnowledgePlan(value)).toEqual({ code: "knowledge_plan_invalid", ok: false });
    }
  });

  it("creates without accepting provider or index authority", () => {
    expect(decodeKnowledgeBaseCreate({
      description: " References ",
      name: " Product docs "
    })).toEqual({
      ok: true,
      value: { description: "References", name: "Product docs" }
    });
    expect(decodeKnowledgeBaseCreate({
      embeddingDeploymentId: "embedding-1",
      name: "Product docs"
    })).toMatchObject({ ok: false });
  });

  it("keeps optimistic updates and publication inputs strict", () => {
    expect(decodeKnowledgeBaseUpdate({
      description: "Updated",
      expectedVersion: 3,
      name: "Docs"
    })).toEqual({
      ok: true,
      value: { description: "Updated", expectedVersion: 3, name: "Docs" }
    });
    expect(decodeKnowledgeBaseUpdate({ expectedVersion: 3 })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBasePublication({ groupId: "group-1", scope: "group" }))
      .toEqual({ ok: true, value: { groupId: "group-1", scope: "group" } });
    expect(decodeKnowledgeBasePublication({ groupId: null, scope: "installation" }))
      .toEqual({ ok: true, value: { groupId: null, scope: "installation" } });
  });

  it("keeps Trash, restore, and permanent-deletion contracts strict", () => {
    expect(decodeKnowledgeBaseLifecycle({ expectedVersion: 3 })).toEqual({
      ok: true,
      value: { expectedVersion: 3 }
    });
    expect(decodeKnowledgeSourceLifecycle({ expectedVersion: 7 })).toEqual({
      ok: true,
      value: { expectedVersion: 7 }
    });
    for (const value of [
      {},
      { expectedVersion: 0 },
      { expectedVersion: 1.5 },
      { expectedVersion: 3, force: true }
    ]) {
      expect(decodeKnowledgeBaseLifecycle(value)).toMatchObject({ ok: false });
      expect(decodeKnowledgeSourceLifecycle(value)).toMatchObject({ ok: false });
    }
    expect(decodeKnowledgeDeletionResponse({ status: "pending" })).toEqual({
      status: "pending"
    });
    expect(decodeKnowledgeDeletionResponse({ status: "pending", jobId: "private" })).toBeNull();
    expect(decodeKnowledgeDeletionResponse({ status: "complete" })).toBeNull();

    const trashedSummary = {
      ...summary(),
      purgeScheduledAt: "2026-09-17T10:00:00.000Z",
      readiness: { ...ready, state: "trashed" as const },
      trashed: true,
      trashedAt: "2026-08-18T10:00:00.000Z"
    };
    expect(decodeKnowledgeBaseSummary(trashedSummary)).toEqual(trashedSummary);
    expect(decodeKnowledgeBaseSummary({ ...trashedSummary, purgeScheduledAt: null })).toBeNull();
    expect(decodeKnowledgeSourceSummary(sourceSummary({
      purgeScheduledAt: "2026-09-17T10:00:00.000Z",
      trashed: true,
      trashedAt: "2026-08-18T10:00:00.000Z"
    }))).not.toBeNull();
    expect(decodeKnowledgeSourceSummary(sourceSummary({
      purgeScheduledAt: "2026-08-17T10:00:00.000Z",
      trashed: true,
      trashedAt: "2026-08-18T10:00:00.000Z"
    }))).toBeNull();
  });

  it("rejects extra create authority, empty updates, and mismatched publication scope", () => {
    expect(decodeKnowledgeBaseCreate({
      description: "",
      name: "Docs",
      ownerUserId: "attacker"
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseCreate({
      description: "x".repeat(2_001),
      name: "Docs"
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseUpdate({ expectedVersion: 1 })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseUpdate({ expectedVersion: 0, name: "Docs" }))
      .toMatchObject({ ok: false });
    expect(decodeKnowledgeBasePublication({ groupId: "group-1", scope: "installation" }))
      .toMatchObject({ ok: false });
    expect(decodeKnowledgeBasePublication({ groupId: null, scope: "group" }))
      .toMatchObject({ ok: false });
  });

  it("decodes only the Base fields the ordinary product consumes", () => {
    expect(decodeKnowledgeBaseSummary(summary())).toEqual(summary());
    expect(decodeKnowledgeBaseSummary({
      ...summary(),
      activeGeneration: { id: "generation-private" }
    })).toBeNull();
    expect(decodeKnowledgeBaseSummary({
      ...summary(),
      sourceCount: 1
    })).toBeNull();

    const detail = { ...summary(), publications: [] };
    expect(decodeKnowledgeBaseDetail(detail)).toEqual(detail);
    expect(decodeKnowledgeBaseDetail({ ...detail, publications: null })).toBeNull();
    expect(decodeKnowledgeBaseDetailResponse({ knowledgeBase: detail })).toEqual({
      knowledgeBase: detail
    });
    expect(decodeKnowledgeBaseDetailResponse({
      knowledgeBase: detail,
      runtimeProfile: { id: "private" }
    })).toBeNull();
  });

  it("decodes a strict content-safe list and rejects legacy technical expansion", () => {
    const response = {
      knowledgeBases: [summary()],
      publishableGroups: [{ id: "group-1", name: "Research" }],
      viewer: { canCreate: true, canPublishInstallation: false, maxUploadBytes: 50_000_000 }
    };
    expect(decodeKnowledgeBaseListResponse(response)).toEqual(response);
    expect(decodeKnowledgeBaseListResponse({
      ...response,
      viewer: { ...response.viewer, maxUploadBytes: 0 }
    })).toBeNull();
    expect(decodeKnowledgeBaseListResponse({
      ...response,
      embeddingDeployments: [{ id: "embedding-private" }]
    })).toBeNull();
  });

  it("keeps publication projections free of internal admission state", () => {
    const publication = {
      groupId: "group-1",
      groupName: "Research",
      id: "publication-1",
      scope: "group" as const,
      updatedAt: "2026-08-18T10:00:00.000Z"
    };
    expect(decodeKnowledgeBasePublicationResponse({ publication })).toEqual({ publication });
    expect(decodeKnowledgeBasePublicationResponse({
      publication: { ...publication, admittedGenerationId: "private" }
    })).toBeNull();
  });

  it("keeps Source metadata, membership, move, and duplicate inputs strict", () => {
    expect(decodeKnowledgeSourceUpdate({
      description: " Updated ",
      expectedVersion: 3,
      name: " Guide ",
      tags: [" product ", "runbook"]
    })).toEqual({
      ok: true,
      value: {
        description: "Updated",
        expectedVersion: 3,
        name: "Guide",
        tags: ["product", "runbook"]
      }
    });
    expect(decodeKnowledgeSourceUpdate({ expectedVersion: 3 })).toMatchObject({ ok: false });
    expect(decodeKnowledgeSourceUpdate({
      expectedVersion: 3,
      tags: ["Product", "product"]
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeSourceMembership({ baseIds: ["base-1", "base-2"] }))
      .toEqual({ ok: true, value: { baseIds: ["base-1", "base-2"] } });
    expect(decodeKnowledgeSourceMembership({ baseIds: ["base-1", "base-1"] }))
      .toMatchObject({ ok: false });
    expect(decodeKnowledgeSourceMove({ fromBaseId: "base-1", toBaseId: "base-2" }))
      .toEqual({ ok: true, value: { fromBaseId: "base-1", toBaseId: "base-2" } });
    expect(decodeKnowledgeSourceMove({ fromBaseId: "base-1", toBaseId: "base-1" }))
      .toMatchObject({ ok: false });
    expect(decodeKnowledgeSourceDuplicate({
      byteSize: 2_048,
      checksum: "a".repeat(64)
    })).toEqual({
      ok: true,
      value: { byteSize: 2_048, checksum: "a".repeat(64) }
    });
    expect(decodeKnowledgeSourceDuplicate({
      byteSize: 2_048,
      checksum: "A".repeat(64)
    })).toMatchObject({ ok: false });
  });

  it("decodes only user-safe Source list and progressive detail fields", () => {
    const summary = sourceSummary();
    expect(decodeKnowledgeSourceSummary(summary)).toEqual(summary);
    expect(decodeKnowledgeSourceSummary({
      ...summary,
      profileRevisionId: "profile-private"
    })).toBeNull();
    const response = {
      pagination: { page: 1, pageSize: 25, query: "guide", totalItems: 1, totalPages: 1 },
      sources: [summary]
    };
    expect(decodeKnowledgeSourceListResponse(response)).toEqual(response);
    const detail = {
      ...summary,
      eligibleBases: [{ archived: false, id: "base-3", name: "Support" }],
      memberships: [
        { archived: false, id: "base-1", name: "Product" },
        { archived: false, id: "base-2", name: "Operations" }
      ],
      versions: [
        sourceVersion(),
        sourceVersion({
          createdAt: "2026-08-17T10:00:00.000Z",
          isCurrent: false,
          pageCount: null,
          readiness: {
            state: "needs_attention",
            supportReference: "K-0123456789AB",
            warningCodes: []
          },
          versionNumber: 1
        })
      ]
    };
    expect(decodeKnowledgeSourceDetail(detail)).toEqual(detail);
    expect(decodeKnowledgeSourceDetailResponse({ source: detail })).toEqual({ source: detail });
    expect(decodeKnowledgeSourceDetail({
      ...detail,
      versions: [{ ...sourceVersion(), normalizedTextStorageKey: "private" }]
    })).toBeNull();
    expect(decodeKnowledgeSourceDuplicateResponse({ source: summary })).toEqual({ source: summary });
    expect(decodeKnowledgeSourceDuplicateResponse({ source: null })).toEqual({ source: null });
  });

  it("keeps shared Source details read-only and current-version only", () => {
    const shared = sourceSummary({ membershipCount: 1, owned: false });
    const detail = {
      ...shared,
      eligibleBases: [],
      memberships: [{ archived: false, id: "base-1", name: "Shared product" }],
      versions: [sourceVersion()]
    };
    expect(decodeKnowledgeSourceDetail(detail)).toEqual(detail);
    expect(decodeKnowledgeSourceDetail({
      ...detail,
      eligibleBases: [{ archived: false, id: "base-2", name: "Private target" }]
    })).toBeNull();
    expect(decodeKnowledgeSourceDetail({
      ...detail,
      versions: [sourceVersion(), sourceVersion({ isCurrent: false, versionNumber: 1 })]
    })).toBeNull();
  });
});
