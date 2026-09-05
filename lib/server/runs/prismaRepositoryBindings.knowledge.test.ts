import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import type { KnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";
import { KnowledgeRunPlanConflictError } from "./runRepositoryContract";

const mocks = vi.hoisted(() => ({
  loadKnowledgeRunAdmissionPlan: vi.fn(),
  materializeKnowledgeBaseSnapshot: vi.fn(),
  sameKnowledgeRunAdmissionPlan: vi.fn()
}));

vi.mock("../knowledge/runAdmission", async (importOriginal) => ({
  ...await importOriginal<typeof import("../knowledge/runAdmission")>(),
  loadKnowledgeRunAdmissionPlan: mocks.loadKnowledgeRunAdmissionPlan,
  sameKnowledgeRunAdmissionPlan: mocks.sameKnowledgeRunAdmissionPlan
}));

vi.mock("../knowledge/sourcePersistence", async (importOriginal) => ({
  ...await importOriginal<typeof import("../knowledge/sourcePersistence")>(),
  materializeKnowledgeBaseSnapshot: mocks.materializeKnowledgeBaseSnapshot
}));

import { insertAcceptedKnowledgeRunBindings } from "./prismaRepositoryBindings";

function plan(): KnowledgeRunAdmissionPlan {
  return {
    bindings: [{
      baseContentRevision: 7,
      embeddingCredentialSource: "default",
      embeddingExecutionSnapshot: {
        connectionId: "embedding-connection",
        credentialId: "embedding-credential",
        credentialVersionId: "embedding-credential-version",
        providerModelId: "embedding-model"
      } as never,
      embeddingProviderModelId: "embedding-model",
      includeWholeBase: true,
      indexedContentRevision: 6,
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-1",
      ordinal: 0,
      selectedSourceIds: [],
      targetDimension: 1024,
      vectorSpaceFingerprint: "a".repeat(64)
    }],
    budgetPolicy: DEFAULT_KNOWLEDGE_BUDGET_POLICY,
    exclusions: [],
    fingerprint: "admission-fingerprint",
    knowledgePlan: {
      baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1
    },
    resolvedSourceCount: 0,
    userId: "owner-1"
  };
}

function canonicalProfile(
  accepted: KnowledgeRunAdmissionPlan
): NonNullable<KnowledgeRunAdmissionPlan["profiles"]>[number] {
  const binding = accepted.bindings[0]!;
  return {
    embeddingCredentialSource: binding.embeddingCredentialSource,
    embeddingExecutionSnapshot: binding.embeddingExecutionSnapshot,
    embeddingProviderModelId: binding.embeddingProviderModelId,
    ordinal: 0,
    profileRevisionId: "profile-revision-1",
    targetDimension: binding.targetDimension,
    vectorSpaceFingerprint: binding.vectorSpaceFingerprint
  };
}

describe("accepted Knowledge Source snapshot binding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores the exact immutable Source snapshot selected inside acceptance", async () => {
    const accepted = plan();
    mocks.loadKnowledgeRunAdmissionPlan.mockResolvedValue(accepted);
    mocks.sameKnowledgeRunAdmissionPlan.mockReturnValue(true);
    mocks.materializeKnowledgeBaseSnapshot.mockResolvedValue({
      evidenceFingerprint: "b".repeat(64),
      readySourceCount: 1,
      snapshotId: "snapshot-1",
      sourceCount: 2,
      sourceRevision: 3
    });
    const create = vi.fn(async () => ({}));
    const createScope = vi.fn(async () => ({}));
    const createSession = vi.fn(async () => ({}));
    const queryRaw = vi.fn(async () => [{
      indexGenerationId: "generation-1",
      ownerUserId: "owner-1"
    }]);
    const tx = {
      $queryRaw: queryRaw,
      knowledgeRunBinding: { create },
      knowledgeRetrievalSession: { create: createSession },
      knowledgeRunScope: { create: createScope }
    } as unknown as Prisma.TransactionClient;

    await insertAcceptedKnowledgeRunBindings(tx, {
      plan: accepted,
      runId: "run-1",
      userId: "owner-1"
    });

    expect(mocks.materializeKnowledgeBaseSnapshot).toHaveBeenCalledWith(tx, {
      indexGenerationId: "generation-1",
      knowledgeBaseId: "base-1"
    });
    expect(create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        indexGenerationId: "generation-1",
        knowledgeBaseId: "base-1",
        knowledgeBaseSnapshotId: "snapshot-1",
        modelRunId: "run-1"
      })
    });
    expect(createScope).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelRunId: "run-1",
        resolvedBaseCount: 1,
        resolvedSourceCount: 0
      })
    });
    expect(createSession).toHaveBeenCalledWith({
      data: expect.objectContaining({
        modelRunId: "run-1",
        originalIntent: { kind: "tool_loop_v1" },
        version: 2
      })
    });
  });

  it("persists a direct unattached Source through a canonical run profile", async () => {
    const legacy = plan();
    const profile = canonicalProfile(legacy);
    const accepted: KnowledgeRunAdmissionPlan = {
      ...legacy,
      bindings: [],
      knowledgePlan: {
        baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1
      },
      profiles: [profile],
      resolvedSourceCount: 1,
      sources: [{
        approxTokens: 1_000,
        authority: { knowledgeBaseIds: [], owner: true, projectId: null },
        baseProvenance: [],
        directSelected: true,
        ordinal: 0,
        privateLabels: { fileName: "source.md", sourceName: "Source" },
        passageCount: 4,
        profileOrdinal: 0,
        profileRevisionId: profile.profileRevisionId,
        selectionProvenance: ["explicit_source"],
        sourceAlias: "S1",
        sourceArtifactId: "artifact-1",
        sourceId: "source-1",
        sourceVersionId: "source-version-1",
        sourceVersionNumber: 3
      }]
    };
    mocks.loadKnowledgeRunAdmissionPlan.mockResolvedValue(accepted);
    mocks.sameKnowledgeRunAdmissionPlan.mockReturnValue(true);
    const profileCreate = vi.fn(async (_input: { data: { id: string } }) => ({}));
    const sourceCreate = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{ ownerUserId: "owner-1" }]),
      knowledgeRunBinding: { create: vi.fn() },
      knowledgeRetrievalSession: { create: vi.fn(async () => ({})) },
      knowledgeRunProfileBinding: { create: profileCreate },
      knowledgeRunScope: { create: vi.fn(async () => ({})) },
      knowledgeRunSourceBinding: { create: sourceCreate }
    } as unknown as Prisma.TransactionClient;

    await insertAcceptedKnowledgeRunBindings(tx, {
      plan: accepted,
      runId: "run-1",
      userId: "owner-1"
    });

    expect(mocks.materializeKnowledgeBaseSnapshot).not.toHaveBeenCalled();
    expect(profileCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        embeddingCredentialId: "embedding-credential",
        embeddingCredentialVersionId: "embedding-credential-version",
        modelRunId: "run-1",
        profileRevisionId: "profile-revision-1"
      })
    });
    const profileBindingId = profileCreate.mock.calls[0]?.[0].data.id;
    expect(sourceCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accessProvenance: {
          authority: { knowledgeBaseIds: [], owner: true, projectId: null },
          selectionProvenance: ["explicit_source"]
        },
        baseProvenance: [],
        directSelected: true,
        fileNameSnapshot: "source.md",
        modelRunId: "run-1",
        profileBindingId,
        selectionKind: "direct",
        sourceAlias: "S1",
        sourceArtifactId: "artifact-1",
        sourceId: "source-1",
        sourceNameSnapshot: "Source",
        sourceVersionId: "source-version-1",
        sourceVersionNumber: 3
      })
    });
    expect(profileCreate.mock.invocationCallOrder[0]).toBeLessThan(
      sourceCreate.mock.invocationCallOrder[0]!
    );
  });

  it.each([999, 1_000, 1_001])("freezes a whole-Base scope of %i Sources with the appropriate binding strategy", async (count) => {
    const legacy = plan();
    const profile = canonicalProfile(legacy);
    const sources = Array.from({ length: count }, (_, ordinal) => ({
      approxTokens: 100,
      authority: { knowledgeBaseIds: ["base-1"], owner: false, projectId: null },
      baseProvenance: [{ indexGenerationId: "generation-1", knowledgeBaseId: "base-1" }],
      directSelected: false,
      ordinal,
      privateLabels: {
        fileName: `source-${ordinal}.md`,
        sourceName: `Source ${ordinal}`
      },
      passageCount: 1,
      profileOrdinal: 0,
      profileRevisionId: profile.profileRevisionId,
      selectionProvenance: ["base" as const],
      sourceAlias: `S${ordinal + 1}`,
      sourceArtifactId: `artifact-${ordinal}`,
      sourceId: `source-${ordinal}`,
      sourceVersionId: `source-version-${ordinal}`,
      sourceVersionNumber: 1
    }));
    const accepted: KnowledgeRunAdmissionPlan = {
      ...legacy,
      profiles: [profile],
      resolvedSourceCount: sources.length,
      sources
    };
    mocks.loadKnowledgeRunAdmissionPlan.mockResolvedValue(accepted);
    mocks.sameKnowledgeRunAdmissionPlan.mockReturnValue(true);
    mocks.materializeKnowledgeBaseSnapshot.mockResolvedValue({
      evidenceFingerprint: "b".repeat(64),
      readySourceCount: sources.length,
      snapshotId: "snapshot-1",
      sourceCount: sources.length,
      sourceRevision: 3
    });
    const sourceCreate = vi.fn(async () => ({}));
    const scopeCreate = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{
        indexGenerationId: "generation-1",
        ownerUserId: "owner-1",
        profileRevisionId: "profile-revision-1"
      }]),
      knowledgeRunBinding: { create: vi.fn(async () => ({})) },
      knowledgeRetrievalSession: { create: vi.fn(async () => ({})) },
      knowledgeRunProfileBinding: { create: vi.fn(async () => ({})) },
      knowledgeRunScope: { create: scopeCreate },
      knowledgeRunSourceBinding: { create: sourceCreate }
    } as unknown as Prisma.TransactionClient;

    await insertAcceptedKnowledgeRunBindings(tx, {
      plan: accepted,
      runId: "run-1",
      userId: "owner-1"
    });

    expect(scopeCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        resolvedSourceCount: count,
        sourceBindingStrategy: count > 999 ? "disclosed_v1" : "eager_v1"
      })
    });
    expect(sourceCreate).toHaveBeenCalledTimes(count > 999 ? 0 : count);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(count > 999 ? 1 : count + 1);
  });

  it("links a legacy Base binding to the exact locked profile revision and runtime", async () => {
    const legacy = plan();
    const accepted: KnowledgeRunAdmissionPlan = {
      ...legacy,
      profiles: [canonicalProfile(legacy)],
      sources: []
    };
    mocks.loadKnowledgeRunAdmissionPlan.mockResolvedValue(accepted);
    mocks.sameKnowledgeRunAdmissionPlan.mockReturnValue(true);
    mocks.materializeKnowledgeBaseSnapshot.mockResolvedValue({
      evidenceFingerprint: "b".repeat(64),
      readySourceCount: 0,
      snapshotId: "snapshot-1",
      sourceCount: 0,
      sourceRevision: 3
    });
    const profileCreate = vi.fn(async (_input: { data: { id: string } }) => ({}));
    const baseCreate = vi.fn(async () => ({}));
    const tx = {
      $queryRaw: vi.fn(async () => [{
        indexGenerationId: "generation-1",
        ownerUserId: "owner-1",
        profileRevisionId: "profile-revision-1"
      }]),
      knowledgeRunBinding: { create: baseCreate },
      knowledgeRetrievalSession: { create: vi.fn(async () => ({})) },
      knowledgeRunProfileBinding: { create: profileCreate },
      knowledgeRunScope: { create: vi.fn(async () => ({})) },
      knowledgeRunSourceBinding: { create: vi.fn() }
    } as unknown as Prisma.TransactionClient;

    await insertAcceptedKnowledgeRunBindings(tx, {
      plan: accepted,
      runId: "run-1",
      userId: "owner-1"
    });

    expect(baseCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        profileBindingId: profileCreate.mock.calls[0]?.[0].data.id
      })
    });
    expect(profileCreate.mock.invocationCallOrder[0]).toBeLessThan(
      baseCreate.mock.invocationCallOrder[0]!
    );
  });

  it("fails closed before persistence when the Base runtime does not match its profile", async () => {
    const legacy = plan();
    const accepted: KnowledgeRunAdmissionPlan = {
      ...legacy,
      profiles: [{
        ...canonicalProfile(legacy),
        embeddingExecutionSnapshot: {
          ...legacy.bindings[0]!.embeddingExecutionSnapshot,
          credentialVersionId: "different-version"
        }
      }],
      sources: []
    };
    mocks.loadKnowledgeRunAdmissionPlan.mockResolvedValue(accepted);
    mocks.sameKnowledgeRunAdmissionPlan.mockReturnValue(true);
    const profileCreate = vi.fn();
    const scopeCreate = vi.fn();
    const tx = {
      $queryRaw: vi.fn(async () => [{
        indexGenerationId: "generation-1",
        ownerUserId: "owner-1",
        profileRevisionId: "profile-revision-1"
      }]),
      knowledgeRunBinding: { create: vi.fn() },
      knowledgeRunProfileBinding: { create: profileCreate },
      knowledgeRunScope: { create: scopeCreate },
      knowledgeRunSourceBinding: { create: vi.fn() }
    } as unknown as Prisma.TransactionClient;

    await expect(insertAcceptedKnowledgeRunBindings(tx, {
      plan: accepted,
      runId: "run-1",
      userId: "owner-1"
    })).rejects.toBeInstanceOf(KnowledgeRunPlanConflictError);
    expect(scopeCreate).not.toHaveBeenCalled();
    expect(profileCreate).not.toHaveBeenCalled();
    expect(mocks.materializeKnowledgeBaseSnapshot).not.toHaveBeenCalled();
  });
});
