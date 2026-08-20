import { describe, expect, it, vi } from "vitest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  KnowledgeRunAdmissionError,
  knowledgeRunAdmissionStillAuthorizes,
  loadKnowledgeRunAdmissionPlan,
  sameKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionStore
} from "./runAdmission";

const embeddingConfiguration = {
  adapterKind: "openai_embeddings_compatible",
  answerSelectable: false,
  capabilities: {
    contextWindow: 32_768,
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: false,
    vision: false
  },
  defaultParams: {},
  embedding: {
    nativeDimension: 1_536,
    providerFamily: "openai_compatible",
    queryInstructionTemplate: null,
    supportsMrl: false,
    targetDimension: 1_536
  },
  modelClass: "embedding",
  upstreamModelId: "embedding-v1"
} as const;

const vectorPin = createKnowledgeVectorSpacePin({
  configuration: embeddingConfiguration,
  deploymentId: "embedding-model-1"
})!;

type StoreOptions = Readonly<{
  baseAvailable?: boolean;
  baseReady?: boolean;
  checkAvailable?: boolean;
  fullAccess?: boolean;
  grantCount?: number;
  profileAuthority?: "installation" | "legacy_user";
  sourceOwnerUserId?: string;
  sourceSummary?: Readonly<{
    normalizedTextByteSize: number;
    passageCount: number;
    sourceCount: number;
  }>;
  userActive?: boolean;
  vectorFingerprint?: string;
}>;

function store(options: StoreOptions = {}) {
  const fullAccess = options.fullAccess ?? true;
  const memberships = fullAccess
    ? [{ group: { systemRole: "full_access" }, groupId: "full-access" }]
    : [{ group: { systemRole: null }, groupId: "knowledge-readers" }];
  return {
    accessGrant: {
      count: vi.fn(async () => options.grantCount ?? 0)
    },
    knowledgeBase: {
      findMany: vi.fn(async (input: { where?: { id?: { in?: string[] } } }) =>
        options.baseAvailable === false
          ? []
          : (input.where?.id?.in ?? []).map((id) => ({
              activeIndexGeneration: options.baseReady === false
                ? null
                : { status: "active" },
              id
            }))),
      findFirst: vi.fn(async (input: { where: { id: string } }) =>
        options.baseAvailable === false
          ? null
          : {
              activeIndexGeneration: {
                embeddingConfiguration: vectorPin.configuration,
                embeddingProviderModelId: "embedding-model-1",
                id: `generation:${input.where.id}`,
                indexedContentRevision: 4,
                profileRevisionId: "profile-revision-1",
                profileRevision: {
                  executionAuthority: options.profileAuthority ?? "legacy_user",
                  profileConfiguration: null
                },
                status: "active",
                targetDimension: 1_536,
                vectorSpaceFingerprint:
                  options.vectorFingerprint ?? vectorPin.fingerprint
              },
              contentRevision: 5,
              id: input.where.id,
              sourceMemberships: options.sourceSummary
                ? Array.from({ length: options.sourceSummary.sourceCount }, (_, index) => ({
                    sourceId: `source-${index + 1}`,
                    source: {
                      currentVersion: {
                        artifacts: [{
                          hierarchicalIndexes: [{
                            passageCount: options.sourceSummary!.passageCount,
                            state: "ready"
                          }],
                          id: `artifact-${index + 1}`,
                          normalizedTextByteSize: options.sourceSummary!.normalizedTextByteSize,
                          profileRevisionId: "profile-revision-1",
                          state: "ready"
                        }],
                        byteSize: options.sourceSummary!.normalizedTextByteSize,
                        fileName: `source-${index + 1}.md`,
                        id: `source-version-${index + 1}`,
                        versionNumber: 1
                      },
                      name: `Source ${index + 1}`,
                      ownerUserId: options.sourceOwnerUserId ?? "user-1"
                    }
                  }))
                : []
            })
    },
    knowledgeIndexProfile: {
      findUnique: vi.fn(async () => ({
        activeRevision: {
          embeddingConfiguration: vectorPin.configuration,
          embeddingProviderModelId: "embedding-model-1",
          executionAuthority: "installation",
          id: "profile-revision-1",
          preflightErrorCode: null,
          preflightStatus: "ready",
          profileConfiguration: null,
          targetDimension: 1_536,
          vectorSpaceFingerprint: vectorPin.fingerprint
        }
      }))
    },
    knowledgeSource: {
      count: vi.fn(async (_input: unknown) => 0),
      findMany: vi.fn(async (_input: unknown): Promise<unknown[]> => [])
    },
    projectKnowledgeSourceBinding: {
      count: vi.fn(async (_input: unknown) => 0),
      findMany: vi.fn(async (_input: unknown): Promise<Array<{ sourceId: string }>> => [])
    },
    providerCredentialVersion: {
      findFirst: vi.fn()
    },
    providerCredential: {
      findMany: vi.fn(async () => [{
        activeVersion: { id: "credential-version-1", revokedAt: null },
        enabled: true,
        id: "credential-1"
      }])
    },
    providerGroupCredentialAssignment: {
      findMany: vi.fn(async () => [])
    },
    providerModel: {
      findFirst: vi.fn(async () => ({
        activeConfig: embeddingConfiguration,
        activeVersion: 2,
        connection: {
          activeConfig: {
            allowPrivateNetwork: false,
            apiRoot: "https://embedding.example.test/v1",
            authenticationMode: "bearer",
            responseTimeoutMs: 300_000
          },
          activeVersion: 3,
          credentials: [{
            activeVersion: { id: "credential-version-1", revokedAt: null },
            enabled: true,
            id: "credential-1"
          }],
          defaultCredentialId: "credential-1",
          displayName: "Embedding endpoint",
          family: "openai_compatible",
          unassignedPolicy: "use_default"
        },
        connectionId: "embedding-connection-1",
        displayName: "Embedding model",
        id: "embedding-model-1",
        provider: "openai_compatible"
      })),
      findUnique: vi.fn(async () => ({
        connection: { family: "openai_compatible" },
        connectionId: "embedding-connection-1"
      }))
    },
    providerModelCredentialCheck: {
      findFirst: vi.fn(async () =>
        options.checkAvailable === false ? null : { id: "check-1" })
    },
    providerUserCredentialAssignment: {
      findUnique: vi.fn(async () => null)
    },
    user: {
      findFirst: vi.fn(async () =>
        options.userActive === false ? null : { id: "user-1" })
    },
    userGroup: {
      findMany: vi.fn(async () => memberships)
    }
  };
}

function admissionStore(options: StoreOptions = {}): KnowledgeRunAdmissionStore {
  return store(options) as unknown as KnowledgeRunAdmissionStore;
}

function readySource(ownerUserId = "user-1", knowledgeBaseIds: readonly string[] = []) {
  return {
    baseMemberships: knowledgeBaseIds.map((knowledgeBaseId) => ({
      knowledgeBase: {
        activeIndexGeneration: {
          id: `generation:${knowledgeBaseId}`,
          profileRevisionId: "profile-revision-1",
          status: "active"
        },
        id: knowledgeBaseId
      }
    })),
    currentVersion: {
      artifacts: [{
        hierarchicalIndexes: [{ passageCount: 3, state: "ready" }],
        id: "artifact-1",
        normalizedTextByteSize: 4_000,
        profileRevisionId: "profile-revision-1",
        state: "ready"
      }],
      byteSize: 5_000,
      fileName: "source-1.md",
      id: "source-version-1",
      versionNumber: 1
    },
    id: "source-1",
    name: "Source 1",
    ownerUserId
  };
}

describe("Knowledge run admission", () => {
  it("admits Off without consulting mutable base or provider state", async () => {
    const client = store();
    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      { knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 }, userId: "user-1" }
    );

    expect(plan).toMatchObject({
      bindings: [],
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
      userId: "user-1"
    });
    expect(client.knowledgeBase.findFirst).not.toHaveBeenCalled();
    expect(client.providerModel.findFirst).not.toHaveBeenCalled();
  });

  it("admits an explicitly selected owner Source without a Base proxy", async () => {
    const client = store();
    client.knowledgeSource.findMany.mockResolvedValue([readySource()]);

    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.bindings).toEqual([]);
    expect(plan.profiles).toEqual([
      expect.objectContaining({
        ordinal: 0,
        profileRevisionId: "profile-revision-1",
        vectorSpaceFingerprint: vectorPin.fingerprint
      })
    ]);
    expect(plan.sources).toEqual([{
      approxTokens: 1_000,
      authority: { knowledgeBaseIds: [], owner: true, projectId: null },
      baseProvenance: [],
      directSelected: true,
      ordinal: 0,
      passageCount: 3,
      privateLabels: { fileName: "source-1.md", sourceName: "Source 1" },
      profileOrdinal: 0,
      profileRevisionId: "profile-revision-1",
      selectionProvenance: ["explicit_source"],
      sourceAlias: "S1",
      sourceArtifactId: "artifact-1",
      sourceId: "source-1",
      sourceVersionId: "source-version-1",
      sourceVersionNumber: 1
    }]);
    expect(plan.resolvedSourceCount).toBe(1);
    expect(client.knowledgeBase.findFirst).not.toHaveBeenCalled();
    expect(client.knowledgeBase.findMany).not.toHaveBeenCalled();
  });

  it("reauthorizes the exact canonical Source tuple, not only legacy Base bindings", async () => {
    const client = store();
    client.knowledgeSource.findMany.mockResolvedValue([readySource()]);
    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1
        },
        userId: "user-1"
      }
    );
    const changed = {
      ...plan,
      sources: plan.sources?.map((source) => ({
        ...source,
        sourceArtifactId: "artifact-2"
      }))
    };

    expect(sameKnowledgeRunAdmissionPlan(plan, changed)).toBe(false);
    expect(knowledgeRunAdmissionStillAuthorizes(changed, {
      bindings: plan.bindings,
      knowledgePlan: plan.knowledgePlan,
      profiles: plan.profiles,
      sources: plan.sources
    })).toBe(false);
  });

  it("materializes an owner Source through constant-size All my knowledge", async () => {
    const client = store();
    client.knowledgeSource.count.mockResolvedValue(1);
    client.knowledgeSource.findMany.mockResolvedValue([readySource()]);

    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.sources).toEqual([
      expect.objectContaining({
        directSelected: false,
        selectionProvenance: ["all_my_knowledge"],
        sourceId: "source-1"
      })
    ]);
    expect(plan.bindings).toEqual([]);
    expect(client.knowledgeBase.findMany).not.toHaveBeenCalled();
  });

  it("rejects an explicit foreign Source without an accessible Base", async () => {
    const client = store();

    await expect(loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1
        },
        userId: "user-1"
      }
    )).rejects.toMatchObject({ code: "knowledge_base_not_available" });
    expect(client.knowledgeIndexProfile.findUnique).not.toHaveBeenCalled();
  });

  it("admits an explicit foreign Source only through its accessible ready Base", async () => {
    const client = store({
      sourceOwnerUserId: "source-owner",
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    client.knowledgeSource.findMany.mockResolvedValue([
      readySource("source-owner", ["base-a"])
    ]);

    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.bindings).toEqual([
      expect.objectContaining({
        includeWholeBase: false,
        knowledgeBaseId: "base-a",
        selectedSourceIds: ["source-1"]
      })
    ]);
    expect(plan.sources).toEqual([
      expect.objectContaining({
        authority: { knowledgeBaseIds: ["base-a"], owner: false, projectId: null },
        directSelected: true,
        sourceId: "source-1"
      })
    ]);
    expect(client.knowledgeIndexProfile.findUnique).not.toHaveBeenCalled();
  });

  it("requires an explicit Project Source binding and never falls back to personal access", async () => {
    const granted = store();
    granted.projectKnowledgeSourceBinding.findMany.mockResolvedValue([{ sourceId: "source-1" }]);
    granted.knowledgeSource.findMany.mockResolvedValue([readySource("source-owner")]);
    const input = {
      executionScope: "project" as const,
      knowledgePlan: {
        baseIds: [], mode: "explicit" as const, sourceIds: ["source-1"], version: 1 as const
      },
      projectId: "project-1",
      userId: "user-1"
    };

    const plan = await loadKnowledgeRunAdmissionPlan(
      granted as unknown as KnowledgeRunAdmissionStore,
      input
    );
    expect(plan.sources).toEqual([
      expect.objectContaining({
        authority: { knowledgeBaseIds: [], owner: false, projectId: "project-1" },
        sourceId: "source-1"
      })
    ]);
    expect(granted.knowledgeBase.findMany).not.toHaveBeenCalled();

    const denied = store();
    denied.knowledgeSource.findMany.mockResolvedValue([readySource()]);
    await expect(loadKnowledgeRunAdmissionPlan(
      denied as unknown as KnowledgeRunAdmissionStore,
      input
    )).rejects.toMatchObject({ code: "knowledge_base_not_available" });
    expect(denied.knowledgeSource.findMany).not.toHaveBeenCalled();
  });

  it("deduplicates one exact Source selected through Bases A+B and directly", async () => {
    const client = store({
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    client.knowledgeSource.findMany.mockResolvedValue([readySource()]);

    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-a", "base-b"],
          mode: "explicit",
          sourceIds: ["source-1"],
          version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.bindings).toHaveLength(2);
    expect(plan.profiles).toHaveLength(1);
    expect(plan.sources).toEqual([
      expect.objectContaining({
        authority: {
          knowledgeBaseIds: ["base-a", "base-b"],
          owner: true,
          projectId: null
        },
        baseProvenance: [
          { indexGenerationId: "generation:base-a", knowledgeBaseId: "base-a" },
          { indexGenerationId: "generation:base-b", knowledgeBaseId: "base-b" }
        ],
        directSelected: true,
        selectionProvenance: ["base", "explicit_source"],
        sourceAlias: "S1",
        sourceId: "source-1"
      })
    ]);
    expect(plan.resolvedSourceCount).toBe(1);
  });

  it.each([
    { baseIds: ["same", "same"], mode: "explicit", sourceIds: [], version: 1 },
    {
      baseIds: Array.from({ length: 129 }, (_, index) => `base-${index}`),
      mode: "explicit",
      sourceIds: [],
      version: 1
    },
    { baseIds: [" "], mode: "explicit", sourceIds: [], version: 1 }
  ])("rejects a malformed or unbounded internal plan before state lookup", async (knowledgePlan) => {
    const client = store();

    await expect(loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      { knowledgePlan: knowledgePlan as never, userId: "user-1" }
    )).rejects.toBeInstanceOf(KnowledgeRunAdmissionError);
    expect(client.user.findFirst).not.toHaveBeenCalled();
    expect(client.knowledgeBase.findFirst).not.toHaveBeenCalled();
  });

  it("pins the exact ordered generations, vector space, and embedding execution snapshot", async () => {
    const client = store();
    const input = {
      knowledgePlan: {
        baseIds: ["base-a", "base-b"],
        mode: "explicit" as const,
        sourceIds: [],
        version: 1 as const
      },
      userId: "user-1"
    };
    const first = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      input
    );
    const second = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      input
    );

    expect(first.bindings).toEqual([
      expect.objectContaining({
        baseContentRevision: 5,
        embeddingCredentialSource: "default",
        embeddingProviderModelId: "embedding-model-1",
        indexGenerationId: "generation:base-a",
        indexedContentRevision: 4,
        knowledgeBaseId: "base-a",
        ordinal: 0,
        targetDimension: 1_536,
        vectorSpaceFingerprint: vectorPin.fingerprint
      }),
      expect.objectContaining({
        indexGenerationId: "generation:base-b",
        knowledgeBaseId: "base-b",
        ordinal: 1
      })
    ]);
    expect(first.bindings[0]?.embeddingExecutionSnapshot).toMatchObject({
      connectionId: "embedding-connection-1",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      providerModelId: "embedding-model-1",
      version: 1
    });
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(sameKnowledgeRunAdmissionPlan(first, second)).toBe(true);
    expect(client.knowledgeBase.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          archivedAt: null,
          id: "base-a",
          OR: expect.any(Array)
        })
      })
    );
  });

  it("uses installation credential authority for a profile-owned generation", async () => {
    const client = store({ fullAccess: false, grantCount: 0, profileAuthority: "installation" });
    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-a"], mode: "explicit", sourceIds: [], version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.bindings[0]).toMatchObject({
      embeddingCredentialSource: "default",
      embeddingProviderModelId: "embedding-model-1"
    });
    expect(client.accessGrant.count).not.toHaveBeenCalled();
  });

  it("pins conservative ready-source size evidence for bounded full-context planning", async () => {
    const plan = await loadKnowledgeRunAdmissionPlan(admissionStore({
      sourceSummary: {
        normalizedTextByteSize: 4_000,
        passageCount: 3,
        sourceCount: 1
      }
    }), {
      knowledgePlan: {
        baseIds: ["base-a"], mode: "explicit", sourceIds: [], version: 1
      },
      userId: "user-1"
    });

    expect(plan.bindings[0]).toMatchObject({
      approxTokens: 1_000,
      passageCount: 3,
      readySourceCount: 1,
      sourceCount: 1
    });
  });

  it("admits remaining ready Bases and records stale processing Bases as partial readiness", async () => {
    const client = store();
    client.knowledgeBase.findMany.mockResolvedValueOnce([
      { activeIndexGeneration: { status: "active" }, id: "base-ready" },
      { activeIndexGeneration: null, id: "base-processing" }
    ]);
    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-ready", "base-processing"],
          mode: "explicit",
          sourceIds: [],
          version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.bindings).toHaveLength(1);
    expect(plan.bindings[0]?.knowledgeBaseId).toBe("base-ready");
    expect(plan.exclusions).toEqual([{
      count: 1,
      reason: "not_ready",
      resourceType: "base"
    }]);
  });

  it.each([
    ["inactive user", { userActive: false }],
    ["unknown, archived, or unentitled base", { baseAvailable: false }],
    ["missing embedding entitlement", { fullAccess: false, grantCount: 0 }],
    ["stale embedding availability check", { checkAvailable: false }],
    ["changed vector space", { vectorFingerprint: "f".repeat(64) }]
  ] as const)("returns the same privacy-neutral failure for %s", async (_label, options) => {
    await expect(loadKnowledgeRunAdmissionPlan(admissionStore(options), {
      knowledgePlan: {
        baseIds: ["base-a"], mode: "explicit", sourceIds: [], version: 1
      },
      userId: "user-1"
    })).rejects.toMatchObject({
      code: "knowledge_base_not_available",
      name: new KnowledgeRunAdmissionError().name
    });
  });
});
