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
const reasoningConfiguration = {
  ...activeConfiguration,
  capabilities: {
    ...activeConfiguration.capabilities,
    reasoning: true,
    reasoningEfforts: ["low", "high", "max"],
    defaultReasoningEffort: "low"
  }
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
  it.each(["high", "max", null])("saves supported reasoning or Provider default: %s", async (reasoningEffort) => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ version: 3 }])
      .mockResolvedValueOnce([{
        ...activeModel(),
        activeConfig: reasoningConfiguration,
        connectionActiveConfig: {}, connectionActiveVersion: 1,
        connectionActivatedAt: NOW, connectionEnabled: true, connectionFamily: "openai_compatible"
      }]);
    const update = vi.fn();
    const tx = { $queryRaw: queryRaw, modelPolicy: { update } };
    const prisma = { $transaction: async (run: (store: typeof tx) => Promise<void>) => run(tx) };
    await createAdminModelPolicyService(prisma as never).update({
      expectedVersion: 3, providerModelId: "model-1", reasoningEffort, userId: "admin-1"
    });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      defaultProviderModelId: "model-1", reasoningEffort, version: { increment: 1 }
    }) }));
  });

  it.each([
    { reasoning: false, effort: "high", modelId: "model-1" },
    { reasoning: true, effort: "unsupported", modelId: "model-1" },
    { reasoning: true, effort: "high", modelId: null }
  ])("rejects invalid reasoning without updating the policy: %j", async ({ reasoning, effort, modelId }) => {
    const update = vi.fn();
    const tx = {
      $queryRaw: vi.fn().mockResolvedValueOnce([{ version: 1 }]).mockResolvedValueOnce([{
        ...activeModel(), activeConfig: { ...activeConfiguration, capabilities: { ...activeConfiguration.capabilities, reasoning } },
        connectionActiveConfig: {}, connectionActiveVersion: 1,
        connectionActivatedAt: NOW, connectionEnabled: true, connectionFamily: "openai_compatible"
      }]),
      modelPolicy: { update }
    };
    const prisma = { $transaction: async (run: (store: typeof tx) => Promise<void>) => run(tx) };
    await expect(createAdminModelPolicyService(prisma as never).update({
      expectedVersion: 1, providerModelId: modelId, reasoningEffort: effort, userId: "admin-1"
    })).rejects.toMatchObject({ code: "model_policy_reasoning_invalid" });
    expect(update).not.toHaveBeenCalled();
  });

  it("projects only active answer-selectable candidates and retains an unavailable target", async () => {
    const unavailableTarget = activeModel({ enabled: false, id: "model-old" });
    const prisma = {
      modelPolicy: {
        findUnique: vi.fn().mockResolvedValue({
          defaultProviderModel: unavailableTarget,
          reasoningEffort: null,
          mcpAutoDiscoveryTimeoutSeconds: 60n, mcpAutoDiscoveryMaxOutputTokens: 8192n,
          maxMcpToolsPerDiscovery: 10n,
          maxToolCalls: 20n,
          maxToolRounds: 8n,
          updatedAt: NOW,
          updatedBy: { displayName: "Administrator", id: "admin-1" },
          version: 4
        })
      },
      providerModel: {
        findMany: vi.fn().mockResolvedValue([
          activeModel({ activeConfig: reasoningConfiguration }),
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
        id: "model-1",
        defaultReasoningEffort: "low",
        reasoningEfforts: ["low", "high", "max"]
      }],
      policy: {
        defaultModel: {
          available: false,
          connectionDisplayName: "Answer provider",
          connectionId: "connection-1",
          displayName: "Answer model",
          id: "model-old",
          defaultReasoningEffort: null,
          reasoningEfforts: []
        },
        reasoningEffort: null,
        mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192,
        maxMcpToolsPerDiscovery: 10,
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
        connectionFamily: "openai_compatible",
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
      reasoningEffort: null,
      userId: "admin-1"
    });

    expect(update).toHaveBeenCalledWith({
      data: {
        defaultProviderModelId: "model-1",
        reasoningEffort: null,
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
      reasoningEffort: null,
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
          connectionFamily: "openai_compatible",
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
      reasoningEffort: null,
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

    await createAdminModelPolicyService(prisma).update({
      expectedVersion: 5,
      mcpAutoDiscoveryTimeoutSeconds: 60, mcpAutoDiscoveryMaxOutputTokens: 8192,
      maxMcpToolsPerDiscovery: 10,
      maxToolCalls: 200,
      maxToolRounds: 200,
      userId: "admin-1"
    });

    expect(update).toHaveBeenCalledWith({
      data: {
        mcpAutoDiscoveryTimeoutSeconds: 60n, mcpAutoDiscoveryMaxOutputTokens: 8192n,
        maxMcpToolsPerDiscovery: 10n,
        maxToolCalls: 200n,
        maxToolRounds: 200n,
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
  });

  it("saves the default model and tool limits together under one version check", async () => {
    const queryRaw = vi.fn()
      .mockResolvedValueOnce([{ version: 7 }])
      .mockResolvedValueOnce([{
        ...activeModel(),
        activeConfig: reasoningConfiguration,
        connectionActiveConfig: {}, connectionActiveVersion: 1,
        connectionActivatedAt: NOW, connectionEnabled: true, connectionFamily: "openai_compatible"
      }]);
    const update = vi.fn().mockResolvedValue({});
    const tx = { $queryRaw: queryRaw, modelPolicy: { update } };
    const prisma = {
      $transaction: vi.fn(async (operation: (store: typeof tx) => Promise<void>) => operation(tx))
    } as unknown as PrismaClient;

    await createAdminModelPolicyService(prisma).update({
      expectedVersion: 7,
      maxMcpToolsPerDiscovery: 12,
      maxToolCalls: 24,
      maxToolRounds: 8,
      mcpAutoDiscoveryTimeoutSeconds: 20, mcpAutoDiscoveryMaxOutputTokens: 8192,
      providerModelId: "model-1",
      reasoningEffort: "high",
      userId: "admin-1"
    });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      data: {
        defaultProviderModelId: "model-1",
        maxMcpToolsPerDiscovery: 12n,
        maxToolCalls: 24n,
        maxToolRounds: 8n,
        mcpAutoDiscoveryTimeoutSeconds: 20n, mcpAutoDiscoveryMaxOutputTokens: 8192n,
        reasoningEffort: "high",
        updatedByUserId: "admin-1",
        version: { increment: 1 }
      },
      where: { id: "installation" }
    });
  });

  it("rejects a half-present model pair or limit set before touching the policy", async () => {
    const transaction = vi.fn();
    const service = createAdminModelPolicyService({ $transaction: transaction } as never);
    await expect(service.update({ expectedVersion: 1, providerModelId: "model-1", userId: "admin-1" }))
      .rejects.toThrow("model_policy_update_invalid");
    await expect(service.update({ expectedVersion: 1, maxToolCalls: 4, userId: "admin-1" }))
      .rejects.toThrow("model_policy_update_invalid");
    await expect(service.update({ expectedVersion: 1, userId: "admin-1" }))
      .rejects.toThrow("model_policy_update_invalid");
    expect(transaction).not.toHaveBeenCalled();
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
      reasoningEffort: null,
      userId: "admin-1"
    })).rejects.toEqual(new AdminModelPolicyServiceError("model_policy_stale"));
  });
});
