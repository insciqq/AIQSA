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
    expect(sql).toContain('run_scope."sourceBindingStrategy" = \'eager_v1\'');
    expect(sql).toContain("AND NOT EXISTS (SELECT 1 FROM canonical_profile_bindings)");
    expect(sql).toContain("binding.\"scopeKind\" = 'profile'");
    expect(sql).toContain('embedding."embeddingDimension"');
    expect(sql).not.toContain('embedding."embedding"');
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
      knowledgeRunSourceBinding: { findMany: sourceFindMany },
      knowledgeRunScope: { findFirst: vi.fn(async () => ({
        sourceBindingStrategy: "eager_v1"
      })) }
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

  it("skips a processing-only profile while loading the ready profile subset", async () => {
    const profileFindMany = vi.fn(async (input: unknown) => {
      expect(input).toMatchObject({
        where: {
          sourceBindings: {
            some: {
              readinessState: "ready",
              sourceId: { not: null },
              tombstonedAt: null
            }
          }
        }
      });
      return [{
        embeddingConnectionId: "embedding-connection",
        embeddingCredentialId: "embedding-credential",
        embeddingCredentialSource: "default",
        embeddingCredentialVersionId: "embedding-credential-version",
        embeddingExecutionSnapshot: { version: 1 },
        embeddingProviderModelId: "embedding-model",
        id: "ready-profile-binding",
        ordinal: 1,
        profileRevisionId: "ready-profile-revision",
        sourceBindings: [{ sourceId: "ready-source" }],
        targetDimension: 1_024,
        vectorSpaceFingerprint: "a".repeat(64)
      }];
    });
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRunBinding: { findMany: vi.fn(async () => []) },
      knowledgeRunProfileBinding: { findMany: profileFindMany },
      knowledgeRunScope: { findFirst: vi.fn(async () => ({
        sourceBindingStrategy: "eager_v1"
      })) }
    } as never);

    await expect(store.loadBindings({ runId: "run-1", userId: "owner-1" }))
      .resolves.toEqual([
        expect.objectContaining({
          ordinal: 1,
          profileRevisionId: "ready-profile-revision",
          selectedSourceIds: ["ready-source"]
        })
      ]);
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
      },
      knowledgeRunScope: { findFirst: vi.fn(async () => ({
        sourceBindingStrategy: "eager_v1"
      })) }
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

  it("loads a disclosure-bound run from immutable Base bindings before any Source is disclosed", async () => {
    const profileFindMany = vi.fn(async () => []);
    const base = {
      baseContentRevision: 2,
      embeddingConnectionId: "embedding-connection",
      embeddingCredentialId: "embedding-credential",
      embeddingCredentialSource: "default",
      embeddingCredentialVersionId: "embedding-credential-version",
      embeddingExecutionSnapshot: { version: 1 },
      embeddingProviderModelId: "embedding-model",
      includeWholeBase: true,
      indexGenerationId: "generation-1",
      indexedContentRevision: 2,
      knowledgeBase: { name: "Large corpus" },
      knowledgeBaseId: "base-1",
      knowledgeBaseSnapshot: { sources: [] },
      knowledgeBaseSnapshotId: "snapshot-1",
      ordinal: 0,
      profileBinding: { ordinal: 0, profileRevisionId: "profile-revision-1" },
      selectedSourceIds: [],
      targetDimension: 1_024,
      vectorSpaceFingerprint: "a".repeat(64)
    };
    const baseFindMany = vi.fn(async () => [base]);
    const store = createPrismaKnowledgeRetrievalStore({
      knowledgeRunBinding: { findMany: baseFindMany },
      knowledgeRunProfileBinding: { findMany: profileFindMany },
      knowledgeRunSourceBinding: { findMany: vi.fn(async () => []) },
      knowledgeRunScope: { findFirst: vi.fn(async () => ({
        sourceBindingStrategy: "disclosed_v1"
      })) }
    } as never);

    await expect(store.loadBindings({ runId: "run-1", userId: "owner-1" }))
      .resolves.toEqual([expect.objectContaining({
        executionScope: "base",
        knowledgeBaseId: "base-1",
        knowledgeBaseSnapshotId: "snapshot-1",
        profileRevisionId: "profile-revision-1"
      })]);
    await expect(store.loadScopeAliases!({ runId: "run-1", userId: "owner-1" }))
      .resolves.toEqual([{
        alias: "B1",
        bindingOrdinal: 0,
        bindingOrdinals: [0],
        kind: "base",
        label: "Large corpus"
      }]);
    expect(baseFindMany).toHaveBeenLastCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        knowledgeBaseSnapshot: {
          select: {
            sources: expect.objectContaining({ where: { sourceId: { in: [] } } })
          }
        }
      })
    }));
    expect(profileFindMany).not.toHaveBeenCalled();
  });

  it("materializes one stable Source alias only after selected evidence is disclosed", async () => {
    const sourceCreate = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ projectId: null, sourceBindingStrategy: "disclosed_v1" }]),
      knowledgeBaseSnapshotSource: {
        findMany: vi.fn(async () => [{
          artifactId: "artifact-1",
          knowledgeBaseId: "base-1",
          snapshotId: "snapshot-1",
          source: { name: "Report", ownerUserId: "owner-1" },
          sourceId: "source-1",
          sourceVersion: { fileName: "report.pdf", versionNumber: 1 },
          sourceVersionId: "source-version-1"
        }])
      },
      knowledgeRunBinding: {
        findMany: vi.fn(async () => [{
          indexGenerationId: "generation-1",
          knowledgeBaseId: "base-1",
          knowledgeBaseSnapshotId: "snapshot-1",
          ordinal: 0,
          profileBindingId: "profile-binding-1"
        }])
      },
      knowledgeRunSourceBinding: {
        create: sourceCreate,
        findMany: vi.fn(async () => [])
      }
    };
    const store = createPrismaKnowledgeRetrievalStore({
      $transaction: vi.fn(async (consume: (value: typeof tx) => Promise<void>) => consume(tx))
    } as never);

    await store.materializeScopeAliases!({
      runId: "run-1",
      sourceProvenance: [{
        artifactId: "artifact-1",
        bindings: [{
          baseName: "Large corpus",
          bindingOrdinal: 0,
          knowledgeBaseId: "base-1"
        }],
        primaryBindingOrdinal: 0,
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      }],
      userId: "owner-1"
    });

    expect(sourceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        baseProvenance: [{ indexGenerationId: "generation-1", knowledgeBaseId: "base-1" }],
        ordinal: 0,
        sourceAlias: "S1",
        sourceArtifactId: "artifact-1",
        sourceId: "source-1",
        sourceVersionId: "source-version-1"
      })
    });
  });
});
