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
  checkAvailable?: boolean;
  fullAccess?: boolean;
  grantCount?: number;
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
      findFirst: vi.fn(async (input: { where: { id: string } }) =>
        options.baseAvailable === false
          ? null
          : {
              activeIndexGeneration: {
                embeddingConfiguration: vectorPin.configuration,
                embeddingProviderModelId: "embedding-model-1",
                id: `generation:${input.where.id}`,
                indexedContentRevision: 4,
                status: "active",
                targetDimension: 1_536,
                vectorSpaceFingerprint:
                  options.vectorFingerprint ?? vectorPin.fingerprint
              },
              contentRevision: 5,
              id: input.where.id
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
      findUnique: vi.fn(async () => ({ connectionId: "embedding-connection-1" }))
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
      { knowledgePlan: { baseIds: [] }, userId: "user-1" }
    );

    expect(plan).toMatchObject({
      bindings: [],
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u),
      knowledgePlan: { baseIds: [] },
      userId: "user-1"
    });
    expect(client.knowledgeBase.findFirst).not.toHaveBeenCalled();
    expect(client.providerModel.findFirst).not.toHaveBeenCalled();
  });

  it.each([
    { baseIds: ["same", "same"] },
    { baseIds: ["a", "b", "c", "d"] },
    { baseIds: [" "] }
  ])("rejects a malformed or unbounded internal plan before state lookup", async (knowledgePlan) => {
    const client = store();

    await expect(loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      { knowledgePlan, userId: "user-1" }
    )).rejects.toBeInstanceOf(KnowledgeRunAdmissionError);
    expect(client.user.findFirst).not.toHaveBeenCalled();
    expect(client.knowledgeBase.findFirst).not.toHaveBeenCalled();
  });

  it("pins the exact ordered generations, vector space, and embedding execution snapshot", async () => {
    const client = store();
    const input = {
      knowledgePlan: { baseIds: ["base-a", "base-b"] },
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

  it.each([
    ["inactive user", { userActive: false }],
    ["unknown, archived, or unentitled base", { baseAvailable: false }],
    ["missing embedding entitlement", { fullAccess: false, grantCount: 0 }],
    ["stale embedding availability check", { checkAvailable: false }],
    ["changed vector space", { vectorFingerprint: "f".repeat(64) }]
  ] as const)("returns the same privacy-neutral failure for %s", async (_label, options) => {
    await expect(loadKnowledgeRunAdmissionPlan(admissionStore(options), {
      knowledgePlan: { baseIds: ["base-a"] },
      userId: "user-1"
    })).rejects.toMatchObject({
      code: "knowledge_base_not_available",
      name: new KnowledgeRunAdmissionError().name
    });
  });
});
