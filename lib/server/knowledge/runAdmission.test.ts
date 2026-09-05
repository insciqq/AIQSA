import { describe, expect, it, vi } from "vitest";
import { createKnowledgeVectorSpacePin } from "./indexProfile";
import {
  authorizeKnowledgeRunAdmissionSnapshot,
  KnowledgeRunAdmissionError,
  knowledgeRunAdmissionStillAuthorizes,
  loadKnowledgeRunAdmissionPlan,
  sameKnowledgeRunAdmissionPlan,
  type KnowledgeRunAdmissionAuthorizationSnapshot,
  type KnowledgeRunAdmissionPlan,
  type KnowledgeRunSnapshotAuthorizationStore,
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
  embeddingProviderModelIdByBaseId?: Readonly<Record<string, string>>;
  profileAuthority?: "installation" | "legacy_user";
  profileRevisionIdByBaseId?: Readonly<Record<string, string>>;
  sourceIdsByBaseId?: Readonly<Record<string, readonly string[]>>;
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
          : (() => {
              const embeddingProviderModelId =
                options.embeddingProviderModelIdByBaseId?.[input.where.id] ?? "embedding-model-1";
              const generationPin = createKnowledgeVectorSpacePin({
                configuration: embeddingConfiguration,
                deploymentId: embeddingProviderModelId
              })!;
              const profileRevisionId =
                options.profileRevisionIdByBaseId?.[input.where.id] ?? "profile-revision-1";
              const customSourceIds = options.sourceIdsByBaseId?.[input.where.id];
              const sourceIds = customSourceIds ??
                (options.sourceSummary
                  ? Array.from(
                      { length: options.sourceSummary.sourceCount },
                      (_, index) => `source-${index + 1}`
                    )
                  : []);
              return {
              activeIndexGeneration: {
                embeddingConfiguration: generationPin.configuration,
                embeddingProviderModelId,
                id: `generation:${input.where.id}`,
                indexedContentRevision: 4,
                profileRevisionId,
                profileRevision: {
                  executionAuthority: options.profileAuthority ?? "legacy_user",
                  profileConfiguration: null
                },
                status: "active",
                targetDimension: 1_536,
                vectorSpaceFingerprint:
                  options.vectorFingerprint ?? generationPin.fingerprint
              },
              contentRevision: 5,
              id: input.where.id,
              sourceMemberships: options.sourceSummary
                ? sourceIds.map((sourceId, index) => ({
                    sourceId,
                    source: {
                      currentVersion: {
                        artifacts: [{
                          hierarchicalIndexes: [{
                            passageCount: options.sourceSummary!.passageCount,
                            state: "ready"
                          }],
                          id: customSourceIds
                            ? `artifact:${sourceId}:${profileRevisionId}`
                            : `artifact-${index + 1}`,
                          normalizedTextByteSize: options.sourceSummary!.normalizedTextByteSize,
                          profileRevisionId,
                          state: "ready"
                        }],
                        byteSize: options.sourceSummary!.normalizedTextByteSize,
                        fileName: `${sourceId}.md`,
                        id: customSourceIds
                          ? `source-version:${sourceId}`
                          : `source-version-${index + 1}`,
                        versionNumber: 1
                      },
                      name: customSourceIds ? `Source ${sourceId}` : `Source ${index + 1}`,
                      ownerUserId: options.sourceOwnerUserId ?? "user-1"
                    }
                  }))
                : []
              };
            })())
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
      findFirst: vi.fn(async (input?: { where?: { id?: string } }) => ({
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
        id: input?.where?.id ?? "embedding-model-1",
        provider: "openai_compatible"
      })),
      findUnique: vi.fn(async (input?: { where?: { id?: string } }) => ({
        connection: { family: "openai_compatible" },
        connectionId: "embedding-connection-1",
        id: input?.where?.id ?? "embedding-model-1"
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

function authorizationSnapshot(
  plan: KnowledgeRunAdmissionPlan
): KnowledgeRunAdmissionAuthorizationSnapshot {
  return {
    bindings: plan.bindings,
    knowledgePlan: plan.knowledgePlan,
    profiles: plan.profiles ?? [],
    sources: plan.sources ?? []
  };
}

function snapshotAuthorizationStore(options: Readonly<{
  baseAuthorized?: boolean;
  baseDeleting?: boolean;
  projectActive?: boolean;
  projectBaseBound?: boolean;
  projectSourceBound?: boolean;
  sourceAvailable?: boolean;
  sourceDeleting?: boolean;
  sourcePurged?: boolean;
}> = {}) {
  return {
    knowledgeBase: {
      findMany: vi.fn(async (input: { where: { id: { in: string[] } } }) =>
        input.where.id.in.length === 0 ? [] : [{
        activeIndexGenerationId: "generation:new",
        archivedAt: new Date("2026-08-20T00:00:00.000Z"),
        deletionRequestedAt: options.baseDeleting ? new Date("2026-08-21T00:00:00.000Z") : null,
        id: "base-1",
        indexGenerations: [{
          embeddingProviderModelId: "embedding-model-1",
          id: "generation:base-1",
          profileRevisionId: "profile-revision-1",
          status: "retired",
          targetDimension: 1_536,
          vectorSpaceFingerprint: vectorPin.fingerprint
        }],
        ownerUserId: "another-user",
        projectBindings: options.projectBaseBound === false
          ? []
          : [{ projectId: "project-1" }],
        publications: options.baseAuthorized === false
          ? []
          : [{ groupId: null, scope: "installation" }],
        sourceMemberships: [],
        trashedAt: new Date("2026-08-20T00:00:00.000Z")
      }])
    },
    knowledgeSource: {
      findMany: vi.fn(async () => options.sourcePurged || options.sourceAvailable === false
        ? []
        : [{
            currentVersionId: "source-version-new",
            deletionRequestedAt: options.sourceDeleting
              ? new Date("2026-08-21T00:00:00.000Z")
              : null,
            id: "source-1",
            ownerUserId: "user-1",
            projectBindings: options.projectSourceBound === false
              ? []
              : [{ projectId: "project-1" }],
            versions: [{
              artifacts: [{
                hierarchicalIndexes: [{ state: "ready" }],
                id: "artifact-1",
                profileRevisionId: "profile-revision-1",
                state: "ready"
              }],
              id: "source-version-1"
            }],
            trashedAt: new Date("2026-08-20T00:00:00.000Z")
          }])
    },
    project: {
      findFirst: vi.fn(async () => options.projectActive === false ? null : { id: "project-1" })
    },
    user: {
      findFirst: vi.fn(async () => ({ groups: [], id: "user-1" }))
    }
  } as unknown as KnowledgeRunSnapshotAuthorizationStore;
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
  it.each(["base", "all_my_knowledge", "inherited", "explicit"].flatMap((mode) =>
    [999, 1_000, 1_001].map((count) => ({ mode, count }))
  ))("accounts for every requested Source in $mode scope at $count", async ({ mode, count }) => {
    const client = store(mode === "base" ? { sourceSummary: {
      normalizedTextByteSize: 4, passageCount: 1, sourceCount: count
    } } : {});
    const sources = Array.from({ length: count }, (_, index) => {
      const original = readySource();
      const id = `item-${String(index + 1).padStart(4, "0")}`;
      return { ...original, id, currentVersion: { ...original.currentVersion,
        id: `version-${id}`, artifacts: [{ ...original.currentVersion.artifacts[0]!, id: `artifact-${id}` }] } };
    });
    if (mode !== "base") {
      client.knowledgeSource.count.mockResolvedValue(count);
      client.knowledgeSource.findMany.mockImplementation(async (value) => {
        const query = value as { take?: number; where?: { id?: { in?: string[] } } };
        const selected = query.where?.id?.in;
        return sources.filter(({ id }) => !selected || selected.includes(id)).slice(0, query.take ?? count);
      });
      client.projectKnowledgeSourceBinding.count.mockResolvedValue(count);
      client.projectKnowledgeSourceBinding.findMany.mockResolvedValue(sources.slice(0, 999).map(({ id }) => ({ sourceId: id })));
    }
    const knowledgePlan: KnowledgeRunAdmissionPlan["knowledgePlan"] = mode === "base"
      ? { baseIds: ["base-1"], sourceIds: [], mode: "explicit", version: 1 }
      : mode === "inherited" ? { baseIds: [], sourceIds: [], mode: "inherited", inheritedFrom: "project", version: 1 }
      : mode === "all_my_knowledge" ? { baseIds: [], sourceIds: [], mode: "all_my_knowledge", version: 1 }
      : { baseIds: [], sourceIds: sources.map(({ id }) => id), mode: "explicit", version: 1 };
    const loading = loadKnowledgeRunAdmissionPlan(client as unknown as KnowledgeRunAdmissionStore, {
      knowledgePlan, userId: "user-1", ...(mode === "inherited" ? { executionScope: "project" as const, projectId: "project-1" } : {})
    });
    // Explicit selection has its own stricter public bound (128 resources).
    if (mode === "explicit") { await expect(loading).rejects.toBeInstanceOf(KnowledgeRunAdmissionError); return; }
    const accepted = await loading;
    const admittedCount = mode === "base" ? count : Math.min(count, 999);
    expect(accepted.sources).toHaveLength(admittedCount);
    expect(accepted.resolvedSourceCount).toBe(admittedCount);
    expect(accepted.exclusions).toEqual(count === admittedCount ? [] : [{ resourceType: "source", reason: "binding_budget", count: count - admittedCount }]);
    expect(accepted.resolvedSourceCount + accepted.exclusions.reduce((sum, item) => sum + item.count, 0)).toBe(count);
    if (mode !== "base") {
      expect(accepted.sources?.map(({ sourceId }) => sourceId)).toEqual(sources.slice(0, admittedCount).map(({ id }) => id));
      expect(JSON.parse(JSON.stringify(accepted)).exclusions).toEqual(accepted.exclusions);
    }
  });

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

  it("keeps the accepted retired generation and exact Source artifact authorized across rollout", async () => {
    const client = store({
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    const admitted = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1
        },
        userId: "user-1"
      }
    );
    const authorizationStore = snapshotAuthorizationStore();

    await expect(authorizeKnowledgeRunAdmissionSnapshot(authorizationStore, {
      snapshot: authorizationSnapshot(admitted),
      userId: "user-1"
    })).resolves.toBe(true);
    expect(authorizationStore.knowledgeBase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({ activeIndexGeneration: expect.anything() })
      })
    );
    expect(authorizationStore.knowledgeSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.not.objectContaining({
          baseMemberships: expect.anything(),
          currentVersion: expect.anything()
        })
      })
    );
  });

  it("reauthorizes a large immutable Base snapshot before any Source alias is disclosed", async () => {
    const client = store({
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    const admitted = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1
        },
        userId: "user-1"
      }
    );
    const authorizationStore = snapshotAuthorizationStore({ sourceAvailable: false });
    const snapshot: KnowledgeRunAdmissionAuthorizationSnapshot = {
      ...authorizationSnapshot(admitted),
      resolvedSourceCount: 5_183,
      sourceBindingStrategy: "disclosed_v1",
      sources: []
    };

    await expect(authorizeKnowledgeRunAdmissionSnapshot(authorizationStore, {
      snapshot,
      userId: "user-1"
    })).resolves.toBe(true);
    expect(authorizationStore.knowledgeSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [] } } })
    );
  });

  it("keyset-pages a large whole-Base admission without changing its Source set", async () => {
    const client = store({
      sourceSummary: {
        normalizedTextByteSize: 4_000,
        passageCount: 3,
        sourceCount: 1_000
      }
    });
    const extra = readySource();
    client.knowledgeSource.findMany.mockResolvedValueOnce([{
      ...extra,
      currentVersion: {
        ...extra.currentVersion,
        artifacts: [{
          ...extra.currentVersion.artifacts[0],
          id: "artifact-1001"
        }],
        id: "source-version-1001"
      },
      id: "source-z-extra",
      name: "Source 1001"
    }]);

    const admitted = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1
        },
        userId: "user-1"
      }
    );

    expect(admitted.resolvedSourceCount).toBe(1_001);
    expect(admitted.sources).toHaveLength(1_001);
    expect(admitted.sources?.at(-1)).toMatchObject({
      sourceArtifactId: "artifact-1001",
      sourceId: "source-z-extra",
      sourceVersionId: "source-version-1001"
    });
    expect(client.knowledgeSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: { id: "asc" },
        take: 1_000,
        where: expect.objectContaining({ id: { gt: "source-1000" } })
      })
    );
  });

  it("blocks an accepted Base snapshot after its personal ACL is revoked", async () => {
    const client = store({
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    const admitted = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1
        },
        userId: "user-1"
      }
    );

    await expect(authorizeKnowledgeRunAdmissionSnapshot(
      snapshotAuthorizationStore({ baseAuthorized: false }),
      { snapshot: authorizationSnapshot(admitted), userId: "user-1" }
    )).resolves.toBe(false);
    await expect(authorizeKnowledgeRunAdmissionSnapshot(
      snapshotAuthorizationStore({ baseDeleting: true }),
      { snapshot: authorizationSnapshot(admitted), userId: "user-1" }
    )).resolves.toBe(false);
  });

  it("blocks a directly Project-bound Source after the Project binding is revoked", async () => {
    const client = store();
    client.knowledgeSource.findMany.mockResolvedValue([readySource()]);
    const admitted = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1
        },
        userId: "user-1"
      }
    );
    const snapshot = authorizationSnapshot({
      ...admitted,
      sources: admitted.sources?.map((source) => ({
        ...source,
        authority: { knowledgeBaseIds: [], owner: false, projectId: "project-1" }
      }))
    });

    await expect(authorizeKnowledgeRunAdmissionSnapshot(
      snapshotAuthorizationStore({ projectSourceBound: false }),
      {
        executionScope: "project",
        projectId: "project-1",
        snapshot,
        userId: "user-1"
      }
    )).resolves.toBe(false);
  });

  it("blocks an accepted Project Base after its canonical Project binding is revoked", async () => {
    const client = store({
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    const admitted = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-1"], mode: "explicit", sourceIds: [], version: 1
        },
        userId: "user-1"
      }
    );
    const snapshot = authorizationSnapshot({
      ...admitted,
      sources: admitted.sources?.map((source) => ({
        ...source,
        authority: {
          knowledgeBaseIds: source.authority.knowledgeBaseIds,
          owner: false,
          projectId: "project-1"
        }
      }))
    });

    await expect(authorizeKnowledgeRunAdmissionSnapshot(
      snapshotAuthorizationStore({ projectBaseBound: false }),
      {
        executionScope: "project",
        projectId: "project-1",
        snapshot,
        userId: "user-1"
      }
    )).resolves.toBe(false);
  });

  it("blocks a purged exact Source/Version/artifact tuple", async () => {
    const client = store();
    client.knowledgeSource.findMany.mockResolvedValue([readySource()]);
    const admitted = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1
        },
        userId: "user-1"
      }
    );

    await expect(authorizeKnowledgeRunAdmissionSnapshot(
      snapshotAuthorizationStore({ sourcePurged: true }),
      { snapshot: authorizationSnapshot(admitted), userId: "user-1" }
    )).resolves.toBe(false);
  });

  it("blocks a deletion-requested Source while ordinary Trash remains snapshot-neutral", async () => {
    const client = store();
    client.knowledgeSource.findMany.mockResolvedValue([readySource()]);
    const admitted = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: [], mode: "explicit", sourceIds: ["source-1"], version: 1
        },
        userId: "user-1"
      }
    );
    const snapshot = authorizationSnapshot(admitted);

    await expect(authorizeKnowledgeRunAdmissionSnapshot(
      snapshotAuthorizationStore(),
      { snapshot, userId: "user-1" }
    )).resolves.toBe(true);
    await expect(authorizeKnowledgeRunAdmissionSnapshot(
      snapshotAuthorizationStore({ sourceDeleting: true }),
      { snapshot, userId: "user-1" }
    )).resolves.toBe(false);
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

  it("retains compatible ready profile revisions during a mixed-profile rollout", async () => {
    const client = store({
      profileRevisionIdByBaseId: {
        "base-a": "profile-revision-1",
        "base-b": "profile-revision-2"
      },
      sourceIdsByBaseId: {
        "base-a": ["source-a"],
        "base-b": ["source-b1", "source-b2"]
      },
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    const input = {
      knowledgePlan: {
        baseIds: ["base-a", "base-b"],
        mode: "explicit" as const,
        sourceIds: [],
        version: 1 as const
      },
      userId: "user-1"
    };

    const maximumCoverage = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      input
    );
    const acceptedGroup = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      { ...input, preferredProfileRevisionId: "profile-revision-1" }
    );

    expect(maximumCoverage.bindings).toEqual([
      expect.objectContaining({ knowledgeBaseId: "base-a", ordinal: 0 }),
      expect.objectContaining({ knowledgeBaseId: "base-b", ordinal: 1 })
    ]);
    expect(maximumCoverage.profiles).toEqual([
      expect.objectContaining({ ordinal: 0, profileRevisionId: "profile-revision-1" }),
      expect.objectContaining({ ordinal: 1, profileRevisionId: "profile-revision-2" })
    ]);
    expect(maximumCoverage.sources?.map(({ profileOrdinal, sourceAlias, sourceId }) => ({
      profileOrdinal,
      sourceAlias,
      sourceId
    }))).toEqual([
      { profileOrdinal: 0, sourceAlias: "S1", sourceId: "source-a" },
      { profileOrdinal: 1, sourceAlias: "S2", sourceId: "source-b1" },
      { profileOrdinal: 1, sourceAlias: "S3", sourceId: "source-b2" }
    ]);
    expect(maximumCoverage.exclusions).toEqual([]);
    expect(acceptedGroup).toEqual(maximumCoverage);

    const profilesByRevision = new Map(maximumCoverage.profiles?.map((profile) => [
      profile.profileRevisionId,
      profile
    ]) ?? []);
    const authorizationStore = {
      knowledgeBase: {
        findMany: vi.fn(async (query: { where: { id: { in: string[] } } }) =>
          query.where.id.in.map((knowledgeBaseId) => {
            const binding = maximumCoverage.bindings.find((candidate) =>
              candidate.knowledgeBaseId === knowledgeBaseId)!;
            const source = maximumCoverage.sources?.find((candidate) =>
              candidate.baseProvenance.some((provenance) =>
                provenance.knowledgeBaseId === knowledgeBaseId))!;
            const profile = profilesByRevision.get(source.profileRevisionId)!;
            return {
              deletionRequestedAt: null,
              id: knowledgeBaseId,
              indexGenerations: [{
                embeddingProviderModelId: profile.embeddingProviderModelId,
                id: binding.indexGenerationId,
                profileRevisionId: profile.profileRevisionId,
                status: "retired",
                targetDimension: profile.targetDimension,
                vectorSpaceFingerprint: profile.vectorSpaceFingerprint
              }],
              ownerUserId: "user-1",
              projectBindings: [],
              publications: []
            };
          }))
      },
      knowledgeSource: {
        findMany: vi.fn(async (query: { where: { id: { in: string[] } } }) =>
          query.where.id.in.map((sourceId) => {
            const source = maximumCoverage.sources?.find((candidate) =>
              candidate.sourceId === sourceId)!;
            return {
              deletionRequestedAt: null,
              id: sourceId,
              ownerUserId: "user-1",
              projectBindings: [],
              versions: [{
                artifacts: [{
                  hierarchicalIndexes: [{ state: "ready" }],
                  id: source.sourceArtifactId,
                  profileRevisionId: source.profileRevisionId,
                  state: "ready"
                }],
                id: source.sourceVersionId
              }]
            };
          }))
      },
      project: { findFirst: vi.fn() },
      user: { findFirst: vi.fn(async () => ({ groups: [], id: "user-1" })) }
    } as unknown as KnowledgeRunSnapshotAuthorizationStore;
    await expect(authorizeKnowledgeRunAdmissionSnapshot(authorizationStore, {
      snapshot: authorizationSnapshot(maximumCoverage),
      userId: "user-1"
    })).resolves.toBe(true);
  });

  it("keeps one deterministic embedding group and excludes only incompatible ready Sources", async () => {
    const client = store({
      embeddingProviderModelIdByBaseId: {
        "base-a": "embedding-model-1",
        "base-b": "embedding-model-2"
      },
      profileRevisionIdByBaseId: {
        "base-a": "profile-revision-1",
        "base-b": "profile-revision-2"
      },
      sourceIdsByBaseId: {
        "base-a": ["source-a"],
        "base-b": ["source-b1", "source-b2"]
      },
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });

    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-a", "base-b"],
          mode: "explicit",
          sourceIds: [],
          version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.bindings).toEqual([
      expect.objectContaining({ knowledgeBaseId: "base-b", ordinal: 0 })
    ]);
    expect(plan.profiles).toEqual([
      expect.objectContaining({
        embeddingProviderModelId: "embedding-model-2",
        ordinal: 0,
        profileRevisionId: "profile-revision-2"
      })
    ]);
    expect(plan.sources?.map(({ sourceId }) => sourceId)).toEqual(["source-b1", "source-b2"]);
    expect(plan.exclusions).toContainEqual({
      count: 1,
      reason: "not_ready",
      resourceType: "source"
    });
  });

  it("keeps a foreign explicit Source through the winning rollout profile", async () => {
    const client = store({
      profileRevisionIdByBaseId: {
        "base-a": "profile-revision-1",
        "base-b": "profile-revision-2"
      },
      sourceIdsByBaseId: {
        "base-a": ["source-explicit"],
        "base-b": ["source-explicit", "source-b2"]
      },
      sourceOwnerUserId: "source-owner",
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    const source = readySource("source-owner", ["base-a", "base-b"]);
    source.id = "source-explicit";
    source.currentVersion.id = "source-version:source-explicit";
    source.baseMemberships[1]!.knowledgeBase.activeIndexGeneration.profileRevisionId =
      "profile-revision-2";
    source.currentVersion.artifacts.push({
      hierarchicalIndexes: [{ passageCount: 3, state: "ready" }],
      id: "artifact-direct-2",
      normalizedTextByteSize: 4_000,
      profileRevisionId: "profile-revision-2",
      state: "ready"
    });
    client.knowledgeSource.findMany.mockResolvedValue([source]);

    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-b"],
          mode: "explicit",
          sourceIds: ["source-explicit"],
          version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.profiles?.map(({ profileRevisionId }) => profileRevisionId)).toEqual([
      "profile-revision-1",
      "profile-revision-2"
    ]);
    expect(plan.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({
        directSelected: false,
        selectionProvenance: ["base"],
        sourceId: "source-b2"
      }),
      expect.objectContaining({
        directSelected: true,
        selectionProvenance: ["base", "explicit_source"],
        sourceId: "source-explicit"
      })
    ]));
    expect(plan.sources?.filter(({ sourceId }) => sourceId === "source-explicit"))
      .toHaveLength(2);
    const rolloutBindings = plan.sources?.filter(
      ({ sourceId }) => sourceId === "source-explicit"
    ) ?? [];
    expect(new Set(rolloutBindings.map(({ sourceId }) => sourceId))).toEqual(
      new Set(["source-explicit"])
    );
    expect(new Set(rolloutBindings.map(({ profileRevisionId }) => profileRevisionId)).size)
      .toBe(2);
    expect(new Set(rolloutBindings.map(({ sourceArtifactId }) => sourceArtifactId)).size)
      .toBe(2);
    expect(plan.exclusions).toEqual([]);
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

  it("records a processing Source inside an otherwise ready Base as partial readiness", async () => {
    const client = store({
      sourceSummary: { normalizedTextByteSize: 4_000, passageCount: 3, sourceCount: 1 }
    });
    const readyBase = await client.knowledgeBase.findFirst({ where: { id: "base-a" } });
    if (!readyBase) throw new Error("missing_ready_base_fixture");
    client.knowledgeBase.findFirst.mockResolvedValue({
      ...readyBase,
      sourceMemberships: [
        ...readyBase.sourceMemberships,
        {
          sourceId: "source-processing",
          source: {
            currentVersion: {
              artifacts: [{
                hierarchicalIndexes: [],
                id: "artifact-processing",
                normalizedTextByteSize: 500,
                profileRevisionId: "profile-revision-1",
                state: "processing"
              }],
              byteSize: 500,
              fileName: "processing.md",
              id: "source-version-processing",
              versionNumber: 1
            },
            name: "Processing Source",
            ownerUserId: "user-1"
          }
        }
      ]
    });

    const plan = await loadKnowledgeRunAdmissionPlan(
      client as unknown as KnowledgeRunAdmissionStore,
      {
        knowledgePlan: {
          baseIds: ["base-a"], mode: "explicit", sourceIds: [], version: 1
        },
        userId: "user-1"
      }
    );

    expect(plan.sources).toHaveLength(1);
    expect(plan.exclusions).toEqual([{
      count: 1,
      reason: "not_ready",
      resourceType: "source"
    }]);
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
