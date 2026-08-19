import type { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "../knowledge/knowledgeBudget";
import type { KnowledgeRunAdmissionPlan } from "../knowledge/runAdmission";

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
        credentialVersionId: "embedding-credential-version"
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
    const queryRaw = vi.fn(async () => [{
      indexGenerationId: "generation-1",
      ownerUserId: "owner-1"
    }]);
    const tx = {
      $queryRaw: queryRaw,
      knowledgeRunBinding: { create },
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
  });
});
