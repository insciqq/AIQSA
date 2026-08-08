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
    reasoning: false,
    vision: false
  },
  defaultParams: {},
  upstreamModelId: "vendor/answer"
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
      id: "connection-1"
    },
    connectionId: "connection-1",
    displayName: "Answer model",
    enabled: true,
    id: "model-1",
    ...overrides
  };
}

describe("administrator system model policy service", () => {
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
        displayName: "Answer model",
        id: "model-1"
      }],
      policy: {
        systemModel: {
          available: false,
          connectionDisplayName: "Answer provider",
          connectionId: "connection-1",
          displayName: "Answer model",
          id: "model-old"
        },
        updatedAt: NOW.toISOString(),
        updatedBy: { displayName: "Administrator", id: "admin-1" },
        version: 4
      }
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
        role
      })
    }).list()).resolves.toMatchObject({
      policy: { systemModel: { available: true, id: "model-1" } }
    });
  });

  it("locks, revalidates administrator access, and validates installation authority", async () => {
    const loadRole = vi.fn().mockResolvedValue({});
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
      userId: "admin-1"
    });

    expect(loadRole).toHaveBeenCalledWith(tx, {
      providerModelId: "model-1"
    });
    expect(update).toHaveBeenCalledWith({
      data: {
        providerModelId: "model-1",
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
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
        userId: "admin-1"
      })).rejects.toEqual(new AdminSystemModelPolicyServiceError(expected));
    }
  });
});
