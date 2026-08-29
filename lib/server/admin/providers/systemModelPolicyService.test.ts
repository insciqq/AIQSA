import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { ProviderAdmissionError, type ProviderAdmissionRole } from "../../providerRuntime/admission";
import {
  AdminSystemModelPolicyServiceError,
  createAdminSystemModelPolicyService
} from "./systemModelPolicyService";

const NOW = new Date("2026-08-08T00:00:00.000Z");
const activeConfiguration = {
  adapterKind: "openai_responses_compatible",
  answerSelectable: true,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    defaultReasoningEffort: "medium",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    vision: false
  },
  defaultParams: {},
  modelClass: "answer",
  upstreamModelId: "vendor/answer"
};

const activeRerankerConfiguration = {
  adapterKind: "openrouter_rerank",
  answerSelectable: false,
  capabilities: {
    nativePdfInput: false,
    nativeSearch: false,
    pdf: false,
    reasoning: false,
    streaming: false,
    toolCalling: false,
    vision: false
  },
  defaultParams: {},
  modelClass: "reranker",
  openRouterRouting: { mode: "only_selected", providers: ["Together"] },
  upstreamModelId: "qwen/qwen3-reranker-8b"
};

function activeModel(overrides: Record<string, unknown> = {}) {
  return {
    activeConfig: activeConfiguration,
    activeVersion: 1,
    activatedAt: NOW,
    connection: {
      activeConfig: {},
      activeVersion: 1,
      activatedAt: NOW,
      displayName: "Answer provider",
      enabled: true,
      id: "connection-1",
      defaultCredential: null
    },
    activeCredentialChecks: [],
    connectionId: "connection-1",
    displayName: "Answer model",
    enabled: true,
    id: "model-1",
    ...overrides
  };
}

function verifiableModel(overrides: Record<string, unknown> = {}) {
  const base = activeModel();
  return activeModel({
    connection: {
      ...base.connection,
      defaultCredential: {
        activeVersion: {
          id: "credential-version-1",
          revokedAt: null
        },
        enabled: true,
        id: "credential-1"
      }
    },
    ...overrides
  });
}

function activeRerankerModel(overrides: Record<string, unknown> = {}) {
  const base = activeModel();
  return activeModel({
    activeConfig: activeRerankerConfiguration,
    connection: {
      ...base.connection,
      displayName: "OpenRouter"
    },
    displayName: "Qwen3 Reranker 8B",
    id: "reranker-1",
    ...overrides
  });
}

describe("administrator system model policy service", () => {
  it("projects and retains the independently selected dedicated reranker", async () => {
    const answer = activeModel();
    const reranker = activeRerankerModel();
    const findMany = vi.fn()
      .mockResolvedValueOnce([answer])
      .mockResolvedValueOnce([reranker]);
    const prisma = {
      providerModel: { findMany },
      systemModelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          providerModel: answer,
          providerModelId: "model-1",
          reasoningEffort: null,
          rerankerProviderModel: reranker,
          rerankerProviderModelId: "reranker-1",
          updatedAt: NOW,
          updatedBy: null,
          version: 6
        })
      }
    } as unknown as PrismaClient;

    const catalog = await createAdminSystemModelPolicyService(prisma, {
      resolveRerankerRole: vi.fn().mockResolvedValue({
        credentialScope: "installation",
        ok: true,
        policyVersion: 6,
        providerModelId: "reranker-1",
        role: {}
      }),
      resolveRole: vi.fn().mockResolvedValue({
        credentialScope: "installation",
        ok: true,
        policyVersion: 6,
        providerModelId: "model-1",
        reasoningEffort: null,
        role: {}
      })
    }).list();

    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { modelClass: "reranker" }
    }));
    expect(catalog.rerankerCandidates).toEqual([{
      connectionDisplayName: "OpenRouter",
      connectionId: "connection-1",
      displayName: "Qwen3 Reranker 8B",
      id: "reranker-1"
    }]);
    expect(catalog.policy.rerankerModel).toEqual({
      available: true,
      connectionDisplayName: "OpenRouter",
      connectionId: "connection-1",
      displayName: "Qwen3 Reranker 8B",
      id: "reranker-1"
    });
  });

  it("projects answer candidates and retains an unavailable exact target", async () => {
    const target = activeModel({ enabled: false, id: "model-old" });
    const prisma = {
      providerModel: {
        findMany: vi.fn().mockResolvedValue([
          activeModel(),
          activeModel({
            activeConfig: { ...activeConfiguration, answerSelectable: false },
            id: "technical-model"
          }),
          target
        ])
      },
      systemModelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          providerModel: target,
          providerModelId: "model-old",
          reasoningEffort: "xhigh",
          updatedAt: NOW,
          updatedBy: { displayName: "Administrator", id: "admin-1" },
          version: 4
        })
      }
    } as unknown as PrismaClient;

    await expect(createAdminSystemModelPolicyService(prisma, {
      resolveRole: vi.fn().mockResolvedValue({ code: "system_model_unavailable", ok: false })
    }).list()).resolves.toEqual({
      candidates: [{
        connectionDisplayName: "Answer provider",
        connectionId: "connection-1",
        defaultReasoningEffort: "medium",
        displayName: "Answer model",
        id: "model-1",
        reasoningEfforts: ["low", "medium", "high", "xhigh"],
        structuredOutput: "not_verified"
      }],
      policy: {
        reasoningEffort: "xhigh",
        rerankerModel: null,
        rerankerRoute: {
          entries: [],
          policyVersion: "openrouter-reranker-route-v1"
        },
        systemModel: {
          available: false,
          connectionDisplayName: "Answer provider",
          connectionId: "connection-1",
          defaultReasoningEffort: "medium",
          displayName: "Answer model",
          id: "model-old",
          reasoningEfforts: ["low", "medium", "high", "xhigh"],
          structuredOutput: "not_verified"
        },
        updatedAt: NOW.toISOString(),
        updatedBy: { displayName: "Administrator", id: "admin-1" },
        version: 4
      },
      rerankerCandidates: []
    });
  });

  it("marks the selected deployment available only for the matching resolved version", async () => {
    const target = activeModel();
    const prisma = {
      providerModel: { findMany: vi.fn().mockResolvedValue([target]) },
      systemModelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          providerModel: target,
          providerModelId: "model-1",
          reasoningEffort: "xhigh",
          updatedAt: NOW,
          updatedBy: { displayName: "Administrator", id: "admin-1" },
          version: 5
        })
      }
    } as unknown as PrismaClient;
    const role = {} as ProviderAdmissionRole;

    await expect(createAdminSystemModelPolicyService(prisma, {
      resolveRole: vi.fn().mockResolvedValue({
        credentialScope: "installation",
        ok: true,
        policyVersion: 5,
        providerModelId: "model-1",
        reasoningEffort: "xhigh",
        role
      })
    }).list()).resolves.toMatchObject({
      policy: { systemModel: { available: true, id: "model-1" } }
    });
  });

  it("derives verified and unsupported status from exact active tuple evidence", async () => {
    const base = activeModel();
    const verified = activeModel({
      activeCredentialChecks: [{
        connectionVersion: 1,
        credentialId: "credential-1",
        credentialVersionId: "credential-version-1",
        evidence: {
          structuredOutput: {
            adapterKind: "openai_responses_compatible",
            probeVersion: 2,
            upstreamModelId: "vendor/answer",
            verified: true
          }
        },
        modelVersion: 1,
        status: "available"
      }],
      connection: {
        ...base.connection,
        defaultCredential: {
          activeVersion: { id: "credential-version-1" },
          id: "credential-1"
        }
      }
    });
    const unsupported = activeModel({
      activeConfig: {
        ...activeConfiguration,
        adapterKind: "anthropic_messages"
      },
      id: "model-anthropic"
    });
    const prisma = {
      providerModel: { findMany: vi.fn().mockResolvedValue([verified, unsupported]) },
      systemModelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          providerModel: null,
          providerModelId: null,
          reasoningEffort: null,
          updatedAt: NOW,
          updatedBy: null,
          version: 1
        })
      }
    } as unknown as PrismaClient;

    await expect(createAdminSystemModelPolicyService(prisma, {
      resolveRole: vi.fn().mockResolvedValue({ code: "system_model_not_configured", ok: false })
    }).list()).resolves.toMatchObject({
      candidates: [
        { id: "model-1", structuredOutput: "verified" },
        { id: "model-anthropic", structuredOutput: "unsupported" }
      ]
    });
  });

  it("runs one paid exact-tuple verification for the current supported system model", async () => {
    const target = verifiableModel();
    const refreshActive = vi.fn().mockResolvedValue({
      evidence: {
        structuredOutput: {
          adapterKind: "openai_responses_compatible",
          probeVersion: 2,
          upstreamModelId: "vendor/answer",
          verified: true
        }
      },
      status: "available"
    });
    const prisma = {
      systemModelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          providerModel: target,
          providerModelId: "model-1"
        })
      }
    } as unknown as PrismaClient;

    await expect(createAdminSystemModelPolicyService(prisma, {
      refreshActive
    }).verifyStructuredOutput({
      providerModelId: "model-1"
    })).resolves.toBeUndefined();
    expect(refreshActive).toHaveBeenCalledWith({
      confirmPaidRequest: true,
      connectionId: "connection-1",
      credentialId: "credential-1",
      providerModelId: "model-1",
      signal: undefined
    });
  });

  it("does not repeat a paid verification when exact active evidence is already valid", async () => {
    const target = verifiableModel({
      activeCredentialChecks: [{
        connectionVersion: 1,
        credentialId: "credential-1",
        credentialVersionId: "credential-version-1",
        evidence: {
          structuredOutput: {
            adapterKind: "openai_responses_compatible",
            probeVersion: 2,
            upstreamModelId: "vendor/answer",
            verified: true
          }
        },
        modelVersion: 1,
        status: "available"
      }]
    });
    const refreshActive = vi.fn();
    const prisma = {
      systemModelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          providerModel: target,
          providerModelId: "model-1"
        })
      }
    } as unknown as PrismaClient;

    await expect(createAdminSystemModelPolicyService(prisma, {
      refreshActive
    }).verifyStructuredOutput({
      providerModelId: "model-1"
    })).resolves.toBeUndefined();
    expect(refreshActive).not.toHaveBeenCalled();
  });

  it("rejects verification for unsupported adapters and non-current models", async () => {
    const refreshActive = vi.fn();
    const unsupported = verifiableModel({
      activeConfig: {
        ...activeConfiguration,
        adapterKind: "anthropic_messages"
      }
    });
    const unsupportedPrisma = {
      systemModelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          providerModel: unsupported,
          providerModelId: "model-1"
        })
      }
    } as unknown as PrismaClient;
    await expect(createAdminSystemModelPolicyService(unsupportedPrisma, {
      refreshActive
    }).verifyStructuredOutput({
      providerModelId: "model-1"
    })).rejects.toEqual(new AdminSystemModelPolicyServiceError(
      "system_model_policy_structured_output_unsupported"
    ));

    const mismatchPrisma = {
      systemModelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          providerModel: verifiableModel(),
          providerModelId: "model-1"
        })
      }
    } as unknown as PrismaClient;
    await expect(createAdminSystemModelPolicyService(mismatchPrisma, {
      refreshActive
    }).verifyStructuredOutput({
      providerModelId: "model-other"
    })).rejects.toEqual(new AdminSystemModelPolicyServiceError(
      "system_model_policy_target_unavailable"
    ));
    expect(refreshActive).not.toHaveBeenCalled();
  });

  it("locks, revalidates administrator access, and validates installation authority", async () => {
    const loadRole = vi.fn().mockResolvedValue({
      snapshot: { model: { capabilities: { reasoning: true, reasoningEfforts: ["xhigh"] } } }
    });
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ version: 3 }]),
      systemModelPolicy: { update },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "admin-1" }) }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<void>) => operation(tx))
    } as unknown as PrismaClient;

    await createAdminSystemModelPolicyService(prisma, { loadRole }).update({
      expectedVersion: 3,
      providerModelId: "model-1",
      reasoningEffort: "xhigh",
      rerankerProviderModelId: null,
      userId: "admin-1"
    });

    expect(loadRole).toHaveBeenCalledWith(tx, {
      providerModelId: "model-1"
    });
    expect(update).toHaveBeenCalledWith({
      data: {
        providerModelId: "model-1",
        reasoningEffort: "xhigh",
        rerankerProviderModelId: null,
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
  });

  it("validates and updates answer and reranker roles atomically", async () => {
    const loadRole = vi.fn().mockResolvedValue({
      snapshot: { model: { capabilities: { reasoning: false } } }
    });
    const loadRerankerRole = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ version: 3 }]),
      systemModelPolicy: { update },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "admin-1" }) }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<void>) =>
        operation(tx))
    } as unknown as PrismaClient;

    await createAdminSystemModelPolicyService(prisma, {
      loadRerankerRole,
      loadRole
    }).update({
      expectedVersion: 3,
      providerModelId: "model-1",
      reasoningEffort: null,
      rerankerProviderModelId: "reranker-1",
      userId: "admin-1"
    });

    expect(loadRole).toHaveBeenCalledWith(tx, { providerModelId: "model-1" });
    expect(loadRerankerRole).toHaveBeenCalledWith(tx, {
      providerModelId: "reranker-1"
    });
    expect(update).toHaveBeenCalledWith({
      data: {
        providerModelId: "model-1",
        reasoningEffort: null,
        rerankerProviderModelId: "reranker-1",
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
  });

  it("rejects a reasoning effort the selected deployment does not advertise", async () => {
    const update = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ version: 3 }]),
      systemModelPolicy: { update },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "admin-1" }) }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<void>) => operation(tx))
    } as unknown as PrismaClient;

    await expect(createAdminSystemModelPolicyService(prisma, {
      loadRole: vi.fn().mockResolvedValue({
        snapshot: {
          model: {
            capabilities: { reasoning: true, reasoningEfforts: ["low", "medium"] }
          }
        }
      })
    }).update({
      expectedVersion: 3,
      providerModelId: "model-1",
      reasoningEffort: "xhigh",
      rerankerProviderModelId: null,
      userId: "admin-1"
    })).rejects.toEqual(
      new AdminSystemModelPolicyServiceError("system_model_policy_reasoning_unavailable")
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects reasoning without a selected system model", async () => {
    const update = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ version: 3 }]),
      systemModelPolicy: { update },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "admin-1" }) }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<void>) => operation(tx))
    } as unknown as PrismaClient;

    await expect(createAdminSystemModelPolicyService(prisma).update({
      expectedVersion: 3,
      providerModelId: null,
      reasoningEffort: "xhigh",
      rerankerProviderModelId: null,
      userId: "admin-1"
    })).rejects.toEqual(
      new AdminSystemModelPolicyServiceError("system_model_policy_reasoning_unavailable")
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects stale state and unavailable administrator model access", async () => {
    const staleTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ version: 2 }]),
      systemModelPolicy: { update: vi.fn() },
      user: { findFirst: vi.fn() }
    };
    const stalePrisma = {
      $transaction: vi.fn(async (operation: (store: typeof staleTx) => Promise<void>) =>
        operation(staleTx))
    } as unknown as PrismaClient;
    await expect(createAdminSystemModelPolicyService(stalePrisma).update({
      expectedVersion: 1,
      providerModelId: null,
      reasoningEffort: null,
      rerankerProviderModelId: null,
      userId: "admin-1"
    })).rejects.toEqual(new AdminSystemModelPolicyServiceError("system_model_policy_stale"));

    const targetTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ version: 2 }]),
      systemModelPolicy: { update: vi.fn() },
      user: { findFirst: vi.fn().mockResolvedValue({ id: "admin-1" }) }
    };
    const targetPrisma = {
      $transaction: vi.fn(async (operation: (store: typeof targetTx) => Promise<void>) =>
        operation(targetTx))
    } as unknown as PrismaClient;
    await expect(createAdminSystemModelPolicyService(targetPrisma, {
      loadRole: vi.fn().mockRejectedValue(new ProviderAdmissionError("model_not_available"))
    }).update({
      expectedVersion: 2,
      providerModelId: "model-1",
      reasoningEffort: null,
      rerankerProviderModelId: null,
      userId: "admin-1"
    })).rejects.toEqual(
      new AdminSystemModelPolicyServiceError("system_model_policy_target_unavailable")
    );
    expect(targetTx.systemModelPolicy.update).not.toHaveBeenCalled();
  });

  it("maps serializable and restrictive-FK races to stable policy errors", async () => {
    for (const [code, expected] of [
      ["P2034", "system_model_policy_stale"],
      ["P2003", "system_model_policy_target_unavailable"]
    ] as const) {
      const conflict = new Prisma.PrismaClientKnownRequestError("transaction conflict", {
        clientVersion: "test",
        code
      });
      const prisma = { $transaction: vi.fn().mockRejectedValue(conflict) } as unknown as PrismaClient;
      await expect(createAdminSystemModelPolicyService(prisma).update({
        expectedVersion: 1,
        providerModelId: null,
        reasoningEffort: null,
        rerankerProviderModelId: null,
        userId: "admin-1"
      })).rejects.toEqual(new AdminSystemModelPolicyServiceError(expected));
    }
  });
});
