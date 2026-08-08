import { describe, expect, it } from "vitest";
import {
  decodeKnowledgeBaseDetailResponse,
  decodeKnowledgeBaseListResponse,
  decodeKnowledgeBaseCreate,
  decodeKnowledgeBasePublication,
  decodeKnowledgeBaseUpdate,
  decodeKnowledgeDocumentMutationResponse,
  decodeKnowledgeIngestionStatusResponse,
  decodeKnowledgePlan,
  decodeKnowledgeReindex,
  decodeKnowledgeReindexResponse
} from "./knowledge";

function baseSummary() {
  return {
    activeGeneration: {
      chunkingProfileVersion: 1,
      embeddingDeployment: {
        connectionDisplayName: "Embedding connection",
        id: "embedding-1",
        indexSupported: true,
        modelDisplayName: "Embed model",
        provider: "openai",
        targetDimension: 1536
      },
      embeddingDeploymentId: "embedding-1",
      id: "generation-1",
      indexedContentRevision: 2,
      targetDimension: 1536,
      vectorSpaceFingerprint: "vector-space-1"
    },
    archived: false,
    contentRevision: 2,
    description: "Product references",
    id: "base-1",
    name: "Product docs",
    owned: true,
    ownerDisplayName: "Owner",
    published: false,
    scope: { kind: "owner" },
    updatedAt: "2026-08-08T00:00:00.000Z",
    version: 1
  };
}

function documentStatus() {
  return {
    archived: false,
    currentVersionId: "version-1",
    id: "document-1",
    versions: [{
      byteSize: 12,
      completedAt: "2026-08-08T00:01:00.000Z",
      createdAt: "2026-08-08T00:00:00.000Z",
      current: true,
      embeddedChunks: 2,
      errorCode: null,
      fileName: "guide.md",
      id: "version-1",
      mimeType: "text/markdown",
      pageCount: null,
      payloadAvailable: true,
      state: "ready",
      totalChunks: 2,
      updatedAt: "2026-08-08T00:01:00.000Z",
      versionNumber: 1,
      visibleFromRevision: 2,
      visibleUntilRevision: null
    }]
  };
}

describe("Knowledge Base contracts", () => {
  it("decodes an ordered three-base plan and keeps absent input backward-compatible with Off", () => {
    expect(decodeKnowledgePlan(undefined)).toEqual({ ok: true, plan: { baseIds: [] } });
    expect(decodeKnowledgePlan({ baseIds: [" base-1 ", "base-2", "base-3"] })).toEqual({
      ok: true,
      plan: { baseIds: ["base-1", "base-2", "base-3"] }
    });
  });

  it("rejects malformed, duplicate, over-limit, and expanded Knowledge plans", () => {
    for (const value of [
      null,
      {},
      { baseIds: "base-1" },
      { baseIds: ["base-1", "base-1"] },
      { baseIds: ["base-1", "base-2", "base-3", "base-4"] },
      { baseIds: ["base 1"] },
      { baseIds: [], ownerUserId: "attacker" }
    ]) {
      expect(decodeKnowledgePlan(value)).toEqual({ code: "knowledge_plan_invalid", ok: false });
    }
  });

  it("normalizes bounded create and update inputs", () => {
    expect(decodeKnowledgeBaseCreate({
      description: "  Team references  ",
      embeddingDeploymentId: "embedding-1",
      name: "  Product docs  "
    })).toEqual({
      ok: true,
      value: {
        description: "Team references",
        embeddingDeploymentId: "embedding-1",
        name: "Product docs"
      }
    });
    expect(decodeKnowledgeBaseUpdate({
      archived: false,
      description: " Updated ",
      expectedVersion: 2
    })).toEqual({
      ok: true,
      value: { archived: false, description: "Updated", expectedVersion: 2 }
    });
  });

  it("rejects extra keys, empty updates, malformed ids, and over-bounds text", () => {
    expect(decodeKnowledgeBaseCreate({
      description: "",
      embeddingDeploymentId: "embedding 1",
      name: "Docs"
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseCreate({
      description: "",
      embeddingDeploymentId: "embedding-1",
      name: "Docs",
      ownerUserId: "attacker"
    })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseUpdate({ expectedVersion: 1 })).toMatchObject({ ok: false });
    expect(decodeKnowledgeBaseUpdate({ expectedVersion: 0, name: "Docs" })).toMatchObject({ ok: false });
  });

  it("enforces the publication scope/group pair", () => {
    expect(decodeKnowledgeBasePublication({ groupId: "group-1", scope: "group" })).toEqual({
      ok: true,
      value: { groupId: "group-1", scope: "group" }
    });
    expect(decodeKnowledgeBasePublication({ scope: "installation" })).toEqual({
      ok: true,
      value: { groupId: null, scope: "installation" }
    });
    expect(decodeKnowledgeBasePublication({ groupId: "group-1", scope: "installation" }))
      .toMatchObject({ ok: false });
    expect(decodeKnowledgeBasePublication({ groupId: null, scope: "group" }))
      .toMatchObject({ ok: false });
  });

  it("accepts only an exact bounded embedding deployment for reindex", () => {
    expect(decodeKnowledgeReindex({ embeddingDeploymentId: "embedding-2" })).toEqual({
      ok: true,
      value: { embeddingDeploymentId: "embedding-2" }
    });
    expect(decodeKnowledgeReindex({ embeddingDeploymentId: "embedding 2" })).toMatchObject({ ok: false });
    expect(decodeKnowledgeReindex({ embeddingDeploymentId: "embedding-2", userId: "other" }))
      .toMatchObject({ ok: false });
  });

  it("decodes list and owner detail projections for the browser", () => {
    const summary = baseSummary();
    expect(decodeKnowledgeBaseListResponse({
      embeddingDeployments: [summary.activeGeneration.embeddingDeployment],
      knowledgeBases: [summary],
      publishableGroups: [{ id: "group-1", name: "Product" }],
      viewer: { canPublishInstallation: true }
    })).toMatchObject({
      knowledgeBases: [{ id: "base-1", name: "Product docs" }],
      viewer: { canPublishInstallation: true }
    });
    expect(decodeKnowledgeBaseDetailResponse({
      knowledgeBase: {
        ...summary,
        documentCount: 1,
        published: true,
        publications: [{
          groupId: "group-1",
          groupName: "Product",
          id: "publication-1",
          scope: "group",
          updatedAt: "2026-08-08T00:02:00.000Z"
        }]
      }
    })).toMatchObject({ knowledgeBase: { documentCount: 1, id: "base-1" } });
  });

  it("decodes document lifecycle and reindex projections", () => {
    const document = documentStatus();
    expect(decodeKnowledgeIngestionStatusResponse({
      documents: [document],
      owned: true,
      reindex: {
        completedDocuments: 1,
        createdAt: "2026-08-08T00:00:00.000Z",
        errorCode: null,
        failedDocuments: 0,
        generationId: "generation-2",
        status: "building",
        targetContentRevision: 2,
        totalDocuments: 1
      }
    })).toMatchObject({ documents: [{ id: "document-1" }], owned: true });
    expect(decodeKnowledgeDocumentMutationResponse({ document })).toMatchObject({
      document: { currentVersionId: "version-1" }
    });
    expect(decodeKnowledgeReindexResponse({
      reindex: {
        completedDocuments: 0,
        createdAt: "2026-08-08T00:00:00.000Z",
        errorCode: null,
        failedDocuments: 0,
        generationId: "generation-2",
        status: "building",
        targetContentRevision: 2,
        totalDocuments: 1
      }
    })).toMatchObject({ reindex: { generationId: "generation-2" } });
  });

  it("rejects inconsistent browser projections instead of trusting server-shaped JSON", () => {
    const summary = baseSummary();
    expect(decodeKnowledgeBaseListResponse({
      embeddingDeployments: [],
      knowledgeBases: [{
        ...summary,
        activeGeneration: {
          ...summary.activeGeneration,
          embeddingDeploymentId: "different-deployment"
        }
      }],
      publishableGroups: [],
      viewer: { canPublishInstallation: false }
    })).toBeNull();
    expect(decodeKnowledgeIngestionStatusResponse({
      documents: [{
        ...documentStatus(),
        versions: [{
          ...documentStatus().versions[0],
          embeddedChunks: 3,
          totalChunks: 2
        }]
      }],
      owned: true,
      reindex: null
    })).toBeNull();
    expect(decodeKnowledgeIngestionStatusResponse({
      documents: [{
        ...documentStatus(),
        currentVersionId: "missing-version"
      }],
      owned: true,
      reindex: null
    })).toBeNull();
    expect(decodeKnowledgeBaseListResponse({
      embeddingDeployments: [summary.activeGeneration.embeddingDeployment],
      knowledgeBases: [{
        ...summary,
        owned: false
      }],
      publishableGroups: [],
      viewer: { canPublishInstallation: false }
    })).toBeNull();
    expect(decodeKnowledgeReindexResponse({
      reindex: {
        completedDocuments: 2,
        createdAt: "now",
        errorCode: null,
        failedDocuments: 1,
        generationId: "generation-2",
        status: "building",
        targetContentRevision: 2,
        totalDocuments: 2
      }
    })).toBeNull();
  });
});
