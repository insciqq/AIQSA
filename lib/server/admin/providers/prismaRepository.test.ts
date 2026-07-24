import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { encryptProviderCredentialSecret } from "../../providers/credentialSecrets";
import { createPrismaAdminProviderRepository } from "./prismaRepository";
import type {
  ProviderActiveRefreshCandidate,
  ProviderDraftTestCandidate,
  StoredProviderDraftCheck
} from "./repositoryContract";

const KEY = Buffer.alloc(32, 20);
const NOW = new Date("2026-07-23T14:00:00.000Z");

function transactional<T extends Record<string, unknown>>(db: T): T & {
  $transaction: (operation: (tx: T) => Promise<unknown>) => Promise<unknown>;
} {
  return Object.assign(db, {
    $transaction: vi.fn(async (operation: (tx: T) => Promise<unknown>) => operation(db))
  });
}

function candidate(): ProviderDraftTestCandidate {
  return {
    connection: {
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1"
      },
      displayName: "Provider",
      draftVersion: 2,
      family: "openai_compatible",
      id: "connection-1"
    },
    credential: {
      id: "credential-1",
      source: {
        draftVersion: 3,
        envelope: encryptProviderCredentialSecret({
          credentialId: "credential-1",
          key: KEY,
          secret: "secret",
          valueId: "draft:3"
        }),
        kind: "draft"
      }
    },
    model: {
      configuration: {
        adapterKind: "openai_responses_compatible",
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          vision: false
        },
        defaultParams: {},
        upstreamModelId: "vendor/model"
      },
      displayName: "Model",
      draftVersion: 4,
      id: "model-1"
    }
  };
}

function storedCheck(): StoredProviderDraftCheck {
  return {
    checkedAt: NOW,
    connectionDraftVersion: 2,
    credentialDraftVersion: 3,
    credentialId: "credential-1",
    credentialVersionId: null,
    evidence: {
      detail: "ok",
      method: "tiny_generation",
      selectedProviders: [],
      upstreamModelId: "vendor/model"
    },
    fingerprint: "fingerprint-1",
    modelDraftVersion: 4,
    providerModelId: "model-1",
    status: "available"
  };
}

function activeCandidate(): ProviderActiveRefreshCandidate {
  return {
    connection: {
      configuration: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1"
      },
      displayName: "Provider",
      family: "openai_compatible",
      id: "connection-1",
      version: 2
    },
    credential: {
      envelope: "active-envelope",
      id: "credential-1",
      versionId: "version-1"
    },
    model: {
      configuration: candidate().model.configuration,
      displayName: "Model",
      id: "model-1",
      version: 4
    }
  };
}

describe("Prisma admin provider repository", () => {
  it("serializes configured-secret metadata without returning either ciphertext", async () => {
    const createdAt = new Date("2026-07-20T00:00:00.000Z");
    const db = {
      providerConnection: {
        findMany: vi.fn(async () => [{
          activatedAt: null,
          activeConfig: null,
          activeVersion: 0,
          createdAt,
          credentials: [{
            activatedAt: null,
            activeVersion: {
              activatedAt: NOW,
              id: "version-1",
              revokedAt: null,
              testedAt: NOW,
              version: 1
            },
            activeVersionId: "version-1",
            connectionId: "connection-1",
            createdAt,
            draftSecretEnvelope: "private-draft-ciphertext",
            draftVersion: 2,
            enabled: true,
            groupAssignments: [],
            id: "credential-1",
            label: "Primary",
            testedAt: NOW,
            updatedAt: NOW
          }],
          defaultCredentialId: "credential-1",
          displayName: "Compatible",
          draftConfig: {
            allowPrivateNetwork: false,
            apiRoot: "https://provider.example.test/v1"
          },
          draftVersion: 1,
          enabled: false,
          family: "openai_compatible",
          id: "connection-1",
          models: [],
          templateKey: null,
          unassignedPolicy: "use_default",
          updatedAt: NOW
        }])
      },
      providerDraftCheck: { findMany: vi.fn(async () => []) },
      providerModelCredentialCheck: { findMany: vi.fn(async () => []) }
    };
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    const result = await repository.listConnections();
    expect(result[0]?.credentials[0]).toMatchObject({
      draftSecretConfigured: true,
      id: "credential-1"
    });
    expect(JSON.stringify(result)).not.toContain("private-draft-ciphertext");
    expect(JSON.stringify(result)).not.toContain("secretEnvelope");
  });

  it("CAS-stores candidate evidence only while every draft source is exact", async () => {
    const draft = candidate();
    const upsert = vi.fn(async () => ({}));
    const update = vi.fn(async () => ({}));
    const db = transactional({
      providerConnection: {
        findUnique: vi.fn(async () => ({ draftVersion: 2 }))
      },
      providerCredential: {
        findFirst: vi.fn(async () => ({
          activeVersion: null,
          activeVersionId: null,
          draftSecretEnvelope: draft.credential.source.envelope,
          draftVersion: 3
        })),
        update
      },
      providerDraftCheck: { upsert },
      providerModel: {
        findFirst: vi.fn(async () => ({ draftVersion: 4 }))
      }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.storeDraftCheckCas(draft, storedCheck())).resolves.toBe("stored");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        credentialDraftVersion: 3,
        credentialVersionId: null,
        fingerprint: "fingerprint-1"
      })
    }));
    expect(update).toHaveBeenCalledWith({
      data: { testedAt: NOW },
      where: { id: "credential-1" }
    });

    db.providerModel.findFirst.mockResolvedValueOnce({ draftVersion: 5 });
    await expect(repository.storeDraftCheckCas(draft, storedCheck())).resolves.toBe("stale");
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("returns actionable model deletion conflicts and never silently cascades references", async () => {
    const remove = vi.fn(async () => ({}));
    const db = transactional({
      accessGrant: { count: vi.fn(async () => 2) },
      chat: { count: vi.fn(async () => 1) },
      providerModel: {
        delete: remove,
        findUnique: vi.fn(async () => ({ enabled: false, templateKey: null }))
      },
      providerCredentialVersion: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      providerRunBinding: {
        count: vi.fn(async () => 1),
        updateMany: vi.fn(async () => ({ count: 0 }))
      },
      runProfile: { count: vi.fn(async () => 1) },
      searchStrategy: { count: vi.fn(async () => 1) },
      userSettings: { count: vi.fn(async () => 1) }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteModel("model-1")).resolves.toEqual({
      blockers: [
        { count: 2, kind: "access_grants" },
        { count: 1, kind: "user_defaults" },
        { count: 1, kind: "chat_defaults" },
        { count: 1, kind: "search_references" },
        { count: 1, kind: "run_profiles" },
        { count: 1, kind: "run_bindings" }
      ],
      status: "conflict"
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("atomically materializes a tested draft credential and its complete active check", async () => {
    const candidateCheck = storedCheck();
    const createVersion = vi.fn(async () => ({}));
    const updateCredential = vi.fn(async () => ({ count: 1 }));
    const updateConnection = vi.fn(async () => ({ count: 1 }));
    const updateModel = vi.fn(async (_input: unknown) => ({ count: 1 }));
    const createChecks = vi.fn(async () => ({ count: 1 }));
    const db = transactional({
      providerConnection: {
        findUnique: vi.fn(async () => ({
          defaultCredentialId: "credential-1",
          draftConfig: {},
          draftVersion: 2,
          id: "connection-1"
        })),
        updateMany: updateConnection
      },
      providerCredential: {
        findMany: vi.fn(async () => [{
          activeVersion: null,
          activeVersionId: null,
          draftSecretEnvelope: "v2.draft.envelope.value",
          draftVersion: 3,
          enabled: true,
          id: "credential-1"
        }]),
        updateMany: updateCredential
      },
      providerCredentialVersion: {
        create: createVersion,
        deleteMany: vi.fn(async () => ({ count: 0 }))
      },
      providerDraftCheck: {
        findMany: vi.fn(async () => [{
          ...candidateCheck,
          evidence: candidateCheck.evidence
        }])
      },
      providerGroupCredentialAssignment: {
        findMany: vi.fn(async () => [])
      },
      providerModel: {
        findMany: vi.fn(async () => [{ draftVersion: 4, id: "model-1" }]),
        updateMany: updateModel
      },
      providerModelCredentialCheck: {
        createMany: createChecks,
        deleteMany: vi.fn(async () => ({ count: 0 }))
      },
      providerRunBinding: { updateMany: vi.fn(async () => ({ count: 0 })) }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.activateConnectionCas({
      checks: [candidateCheck],
      connection: {
        configuration: {
          allowPrivateNetwork: false,
          apiRoot: "https://provider.example.test/v1"
        },
        draftVersion: 2,
        enable: true,
        id: "connection-1"
      },
      credentials: [{
        checkedAt: NOW,
        draftVersion: 3,
        id: "credential-1",
        kind: "draft",
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        versionEnvelope: "v2.active.envelope.value",
        versionId: "version-1"
      }],
      models: [{
        configuration: {
          adapterKind: "openai_responses_compatible",
          capabilities: {
            nativePdfInput: false,
            nativeSearch: false,
            pdf: false,
            reasoning: false,
            vision: false
          },
          defaultParams: {},
          upstreamModelId: "vendor/model"
        },
        draftVersion: 4,
        id: "model-1"
      }],
      now: NOW
    })).resolves.toBe("updated");
    expect(createVersion).toHaveBeenCalledWith({
      data: expect.objectContaining({
        credentialId: "credential-1",
        id: "version-1",
        secretEnvelope: "v2.active.envelope.value",
        testEvidence: { method: "models_catalog", modelCount: 1, version: 1 },
        testedAt: NOW,
        version: 3
      })
    });
    expect(updateCredential).toHaveBeenCalledWith({
      data: expect.objectContaining({
        activeVersionId: "version-1",
        draftSecretEnvelope: null
      }),
      where: { draftVersion: 3, id: "credential-1" }
    });
    expect(createChecks).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        connectionVersion: 2,
        credentialVersionId: "version-1",
        modelVersion: 4,
        status: "available"
      })]
    });
    expect(
      (updateModel.mock.calls[0]?.[0] as { data?: object } | undefined)?.data
    ).not.toHaveProperty("contextWindow");
  });

  it("deletes a disabled unreferenced credential by clearing its pointer before versions", async () => {
    const operations: string[] = [];
    const detach = vi.fn(async () => ({ count: 1 }));
    const db = transactional({
      providerConnection: { count: vi.fn(async () => 0) },
      providerCredential: {
        delete: vi.fn(async () => { operations.push("credential"); }),
        findUnique: vi.fn(async () => ({ enabled: false })),
        update: vi.fn(async () => { operations.push("pointer"); })
      },
      providerCredentialVersion: {
        deleteMany: vi.fn(async () => { operations.push("versions"); return { count: 2 }; })
      },
      providerGroupCredentialAssignment: { count: vi.fn(async () => 0) },
      providerRunBinding: {
        count: vi.fn(async () => 0),
        updateMany: detach
      }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.deleteCredential("credential-1")).resolves.toEqual({
      status: "deleted"
    });
    expect(operations).toEqual(["versions", "pointer", "versions", "credential"]);
    expect(detach).toHaveBeenCalledWith({
      data: {
        connectionId: null,
        credentialId: null,
        credentialVersionId: null,
        providerModelId: null
      },
      where: {
        AND: [
          { credentialId: "credential-1" },
          { modelRun: { status: { notIn: ["in_progress", "queued", "streaming"] } } },
          {
            OR: [
              { recoverableUntil: null },
              { recoverableUntil: { lte: expect.any(Date) } }
            ]
          }
        ]
      }
    });
  });

  it("serializes emergency revocation with the same credential-version row lock", async () => {
    const update = vi.fn(async () => ({}));
    const query = vi.fn(async (_sql: unknown) => [{
      credentialId: "credential-1",
      id: "version-1",
      revokedAt: null
    }]);
    const db = transactional({
      $queryRaw: query,
      providerCredentialVersion: { update }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.revokeCredentialVersion({
      clearSecret: true,
      credentialId: "credential-1",
      now: NOW,
      versionId: "version-1"
    })).resolves.toBe("revoked");
    expect(update).toHaveBeenCalledWith({
      data: { revokedAt: NOW, secretEnvelope: null },
      where: { id: "version-1" }
    });
    const sql = query.mock.calls[0]?.[0] as { strings?: string[] } | undefined;
    expect(sql?.strings?.join(" ")).toContain("FOR UPDATE");
  });

  it("holds a conflicting shared lock while an active admin test decrypts a key version", async () => {
    const consume = vi.fn(() => "decrypted-for-one-call");
    const query = vi.fn(async (_sql: unknown) => [{
      credentialId: "credential-1",
      id: "version-1",
      revokedAt: null,
      secretEnvelope: "encrypted-value"
    }]);
    const db = transactional({ $queryRaw: query });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.withLockedCredential(
      "credential-1",
      "version-1",
      consume
    )).resolves.toBe("decrypted-for-one-call");
    expect(consume).toHaveBeenCalledWith(expect.objectContaining({
      credentialId: "credential-1",
      id: "version-1",
      secretEnvelope: "encrypted-value"
    }));
    const sql = query.mock.calls[0]?.[0] as { strings?: string[] } | undefined;
    expect(sql?.strings?.join(" ")).toContain("FOR SHARE");
  });

  it("assigns only a same-connection credential to a current non-archived group", async () => {
    const upsert = vi.fn(async () => ({}));
    const db = transactional({
      group: { findFirst: vi.fn(async () => ({ id: "group-1" })) },
      providerCredential: { findFirst: vi.fn(async () => ({ id: "credential-1" })) },
      providerGroupCredentialAssignment: { upsert }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.assignGroupCredential({
      connectionId: "connection-1",
      credentialId: "credential-1",
      groupId: "group-1"
    })).resolves.toBe("assigned");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: {
        connectionId: "connection-1",
        credentialId: "credential-1",
        groupId: "group-1"
      }
    }));
  });

  it("CAS-refreshes active authority and clears only its prior transient warning", async () => {
    const upsert = vi.fn(async () => ({}));
    const db = transactional({
      providerConnection: { findUnique: vi.fn(async () => ({ activeVersion: 2 })) },
      providerCredential: {
        findFirst: vi.fn(async () => ({
          activeVersion: { revokedAt: null, secretEnvelope: "active-envelope" },
          activeVersionId: "version-1"
        }))
      },
      providerModel: { findFirst: vi.fn(async () => ({ activeVersion: 4 })) },
      providerModelCredentialCheck: { upsert }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.storeActiveRefreshCas({
      candidate: activeCandidate(),
      checkedAt: NOW,
      evidence: {
        detail: "model_missing",
        method: "openrouter_account_catalog",
        selectedProviders: [],
        upstreamModelId: "vendor/model"
      },
      status: "unavailable"
    })).resolves.toBe("stored");
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ status: "unavailable" }),
      update: expect.objectContaining({
        checkedAt: NOW,
        refreshFailedAt: null,
        status: "unavailable"
      }),
      where: {
        providerModelId_credentialVersionId_connectionVersion_modelVersion: {
          connectionVersion: 2,
          credentialVersionId: "version-1",
          modelVersion: 4,
          providerModelId: "model-1"
        }
      }
    }));
  });

  it("records a value-free refresh warning without overwriting prior active status", async () => {
    const updateMany = vi.fn(async (_args: unknown) => ({ count: 1 }));
    const db = transactional({
      providerConnection: { findUnique: vi.fn(async () => ({ activeVersion: 2 })) },
      providerCredential: {
        findFirst: vi.fn(async () => ({
          activeVersion: { revokedAt: null, secretEnvelope: "active-envelope" },
          activeVersionId: "version-1"
        }))
      },
      providerModel: { findFirst: vi.fn(async () => ({ activeVersion: 4 })) },
      providerModelCredentialCheck: { updateMany }
    });
    const repository = createPrismaAdminProviderRepository(db as unknown as PrismaClient);

    await expect(repository.recordActiveRefreshFailureCas({
      candidate: activeCandidate(),
      failedAt: NOW
    })).resolves.toBe("stored");
    const update = updateMany.mock.calls[0]?.[0] as
      | { data: Record<string, unknown> }
      | undefined;
    expect(update).toEqual(expect.objectContaining({
      data: {
        latestRefreshError: { code: "provider_refresh_failed", version: 1 },
        refreshFailedAt: NOW
      }
    }));
    expect(update?.data).not.toHaveProperty("status");
    expect(update?.data).not.toHaveProperty("evidence");
    expect(JSON.stringify(update)).not.toContain("active-envelope");
  });
});
