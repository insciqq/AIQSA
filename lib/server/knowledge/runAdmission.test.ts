import { describe, expect, it, vi } from "vitest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  KnowledgeRunAdmissionError,
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
  profileAuthority?: "installation";
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
                profileRevision: options.profileAuthority
                  ? { executionAuthority: options.profileAuthority }
                  : null,
                status: "active",
                targetDimension: 1_536,
                vectorSpaceFingerprint:
                  options.vectorFingerprint ?? vectorPin.fingerprint
              },
              contentRevision: 5,
              id: input.where.id,
              sourceMemberships: options.sourceSummary
                ? Array.from({ length: options.sourceSummary.sourceCount }, () => ({
                    source: {
                      currentVersion: {
                        artifacts: [{
                          hierarchicalIndexes: [{
                            passageCount: options.sourceSummary!.passageCount,
                            state: "ready"
                          }],
                          normalizedTextByteSize: options.sourceSummary!.normalizedTextByteSize,
                          profileRevisionId: "profile-revision-1",
                          state: "ready"
                        }],
                        byteSize: options.sourceSummary!.normalizedTextByteSize
                      }
                    }
                  }))
                : []
            })
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
