import { describe, expect, it, vi } from "vitest";
import { knowledgeRetrievalScopeSql } from "./prismaRetrievalCore";
import { createPrismaKnowledgeRetrievalStore } from "./prismaRetrievalRepository";

describe("Prisma Knowledge canonical direct Source scope", () => {
  it("builds a dual-read SQL scope that prefers canonical Source rows", () => {
    const query = knowledgeRetrievalScopeSql({
      runId: "run-1",
      sourceIds: ["source-1"],
      userId: "owner-1"
    });
    const sql = query.strings.join("?");
    expect(sql).toContain('"KnowledgeRunProfileBinding"');
    expect(sql).toContain('"KnowledgeRunSourceBinding"');
    expect(sql).toContain("AND NOT EXISTS (SELECT 1 FROM canonical_profile_bindings)");
    expect(sql).toContain("binding.\"scopeKind\" = 'profile'");
  });

  it("loads one profile execution binding and the persisted Source alias without a Base", async () => {
    const profileFindMany = vi.fn(async () => [{
      embeddingConnectionId: "embedding-connection",
      embeddingCredentialId: "embedding-credential",
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: "embedding-credential-version",
      embeddingExecutionSnapshot: { version: 1 },
      embeddingProviderModelId: "embedding-model",
      id: "profile-binding-1",
      ordinal: 0,
      profileRevisionId: "profile-revision-1",
      sourceBindings: [{ sourceId: "source-1" }],
      targetDimension: 1_024,
      vectorSpaceFingerprint: "a".repeat(64)
    }]);
    const sourceFindMany = vi.fn(async () => [{
      profileBinding: { ordinal: 0 },
      sourceAlias: "S1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      sourceNameSnapshot: "Unattached source",
      sourceVersionId: "source-version-1"
    }]);
    const baseFindMany = vi.fn(async () => []);
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRunBinding: { findMany: baseFindMany },
      knowledgeRunProfileBinding: { findMany: profileFindMany },
      knowledgeRunSourceBinding: { findMany: sourceFindMany }
    } as never);

    await expect(store.loadBindings({ runId: "run-1", userId: "owner-1" })).resolves.toEqual([{
      baseContentRevision: 0,
      baseName: "Pinned Knowledge Profile",
      embeddingConnectionId: "embedding-connection",
      embeddingCredentialId: "embedding-credential",
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: "embedding-credential-version",
      embeddingExecutionSnapshot: { version: 1 },
      embeddingProviderModelId: "embedding-model",
      executionScope: "profile",
      indexedContentRevision: 0,
      indexGenerationId: "profile-revision-1",
      includeWholeBase: false,
      knowledgeBaseId: "profile-binding-1",
      knowledgeBaseSnapshotId: "profile-binding-1",
      ordinal: 0,
      profileRevisionId: "profile-revision-1",
      selectedSourceIds: ["source-1"],
      targetDimension: 1_024,
      vectorSpaceFingerprint: "a".repeat(64)
    }]);
    await expect(store.loadScopeAliases!({ runId: "run-1", userId: "owner-1" })).resolves.toEqual([{
      alias: "S1",
      bindingOrdinal: 0,
      bindingOrdinals: [0],
      kind: "source",
      label: "Unattached source",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      sourceVersionId: "source-version-1"
    }]);
    expect(baseFindMany).toHaveBeenCalledOnce();
  });

  it("keeps a Base alias bounded to its admitted canonical Source set", async () => {
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRunBinding: {
        findMany: vi.fn(async () => [{
          includeWholeBase: false,
          knowledgeBase: { name: "Reports" },
          knowledgeBaseSnapshot: { sources: [{ sourceId: "source-1" }, { sourceId: "source-2" }] },
          ordinal: 0,
          profileBinding: { ordinal: 0 },
          selectedSourceIds: ["source-1", "source-foreign"]
        }])
      },
      knowledgeRunSourceBinding: {
        findMany: vi.fn(async () => [{
          profileBinding: { ordinal: 0 },
          sourceAlias: "S1",
          sourceArtifactId: "artifact-1",
          sourceId: "source-1",
          sourceNameSnapshot: "Report",
          sourceVersionId: "source-version-1"
        }])
      }
    } as never);

    await expect(store.loadScopeAliases!({ runId: "run-1", userId: "owner-1" })).resolves.toEqual([
      {
        alias: "B1",
        bindingOrdinal: 0,
        bindingOrdinals: [0],
        kind: "base",
        label: "Reports",
        sourceIds: ["source-1"]
      },
      expect.objectContaining({ alias: "S1", sourceId: "source-1" })
    ]);
  });
});
