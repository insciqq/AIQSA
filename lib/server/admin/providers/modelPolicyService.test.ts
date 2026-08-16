import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  AdminModelPolicyServiceError,
  createAdminModelPolicyService
} from "./modelPolicyService";

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
  modelClass: "answer",
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

describe("administrator model policy service", () => {
  it("projects only active answer-selectable candidates and retains an unavailable target", async () => {
    const unavailableTarget = activeModel({ enabled: false, id: "model-old" });
    const prisma = {
      modelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          defaultProviderModel: unavailableTarget,
          maxToolCalls: 20n,
          maxToolRounds: 8n,
          updatedAt: NOW,
          updatedBy: { displayName: "Administrator", id: "admin-1" },
          version: 4
        })
      },
      providerModel: {
        findMany: vi.fn().mockResolvedValue([
          activeModel(),
          activeModel({
            activeConfig: { ...activeConfiguration, answerSelectable: false },
            id: "technical-model"
          }),
          unavailableTarget
        ])
      }
    } as unknown as PrismaClient;

    await expect(createAdminModelPolicyService(prisma).list()).resolves.toEqual({
      candidates: [{
        connectionDisplayName: "Answer provider",
        connectionId: "connection-1",
        displayName: "Answer model",
        id: "model-1"
      }],
      policy: {
        defaultModel: {
          available: false,
          connectionDisplayName: "Answer provider",
          connectionId: "connection-1",
          displayName: "Answer model",
          id: "model-old"
        },
        maxToolCalls: 20,
        maxToolRounds: 8,
        updatedAt: NOW.toISOString(),
        updatedBy: { displayName: "Administrator", id: "admin-1" },
        version: 4
      }
    });
  });

  it("locks and revalidates the exact active target before an optimistic update", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ version: 3 }])
      .mockResolvedValueOnce([{
        activeConfig: activeConfiguration,
        activeVersion: 1,
        activatedAt: NOW,
        connectionActiveConfig: {},
        connectionActivatedAt: NOW,
        connectionActiveVersion: 1,
        connectionEnabled: true,
        enabled: true,
        id: "model-1"
      }]);
    const update = vi.fn().mockResolvedValue({});
    const tx = { $queryRaw: queryRaw, modelPolicy: { update } };
    const prisma = {
      $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<void>) => operation(tx))
    } as unknown as PrismaClient;

    await createAdminModelPolicyService(prisma).update({
      expectedVersion: 3,
      providerModelId: "model-1",
      userId: "admin-1"
    });

    expect(update).toHaveBeenCalledWith({
      data: {
        defaultProviderModelId: "model-1",
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
  });

  it("rejects stale and technical-only targets without mutating the policy", async () => {
    const staleTx = {
      $queryRaw: vi.fn().mockResolvedValue([{ version: 2 }]),
      modelPolicy: { update: vi.fn() }
    };
    const stalePrisma = {
      $transaction: vi.fn(async (operation: (store: typeof staleTx) => Promise<void>) =>
        operation(staleTx))
    } as unknown as PrismaClient;
    await expect(createAdminModelPolicyService(stalePrisma).update({
      expectedVersion: 1,
      providerModelId: null,
      userId: "admin-1"
    })).rejects.toEqual(new AdminModelPolicyServiceError("model_policy_stale"));
    expect(staleTx.modelPolicy.update).not.toHaveBeenCalled();

    const targetTx = {
      $queryRaw: vi.fn()
        .mockResolvedValueOnce([{ version: 2 }])
        .mockResolvedValueOnce([{
          activeConfig: { ...activeConfiguration, answerSelectable: false },
          activeVersion: 1,
          activatedAt: NOW,
          connectionActiveConfig: {},
          connectionActivatedAt: NOW,
          connectionActiveVersion: 1,
          connectionEnabled: true,
          enabled: true,
          id: "technical-model"
        }]),
      modelPolicy: { update: vi.fn() }
    };
    const targetPrisma = {
      $transaction: vi.fn(async (operation: (store: typeof targetTx) => Promise<void>) =>
        operation(targetTx))
    } as unknown as PrismaClient;
    await expect(createAdminModelPolicyService(targetPrisma).update({
      expectedVersion: 2,
      providerModelId: "technical-model",
      userId: "admin-1"
    })).rejects.toEqual(
      new AdminModelPolicyServiceError("model_policy_target_unavailable")
    );
    expect(targetTx.modelPolicy.update).not.toHaveBeenCalled();
  });

  it("updates positive safe tool budgets without imposing a product cap", async () => {
    const update = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ version: 5 }]),
      modelPolicy: { update }
    };
    const prisma = {
      $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<void>) => operation(tx))
    } as unknown as PrismaClient;

    await createAdminModelPolicyService(prisma).updateToolBudgets({
      expectedVersion: 5,
      maxToolCalls: 200,
      maxToolRounds: 200,
      userId: "admin-1"
    });

    expect(update).toHaveBeenCalledWith({
      data: {
        maxToolCalls: 200n,
        maxToolRounds: 200n,
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
  });

  it("maps a serializable transaction conflict to a stable stale-policy error", async () => {
    const conflict = new Prisma.PrismaClientKnownRequestError("serialization failure", {
      clientVersion: "test",
      code: "P2034"
    });
    const prisma = {
      $transaction: vi.fn().mockRejectedValue(conflict)
    } as unknown as PrismaClient;

    await expect(createAdminModelPolicyService(prisma).update({
      expectedVersion: 1,
      providerModelId: null,
      userId: "admin-1"
    })).rejects.toEqual(new AdminModelPolicyServiceError("model_policy_stale"));
  });
});
