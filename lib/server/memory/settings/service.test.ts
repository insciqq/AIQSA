import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  type ResolvedMemoryExecutionTarget,
  type ResolvedMemoryUtilityPolicy
} from "../execution/policy";
import { MemoryPersistenceError } from "../persistence/errors";
import type { MemorySettingsPersistenceSnapshot } from "../persistence/settings";
import {
  createMemorySettingsService,
  DEFAULT_MEMORY_SETTINGS_CAPABILITIES,
  MemorySettingsServiceError,
  type MemorySettingsRepository
} from "./service";

const NOW = new Date("2026-08-10T12:00:00.000Z");

function settings(
  overrides: Partial<MemorySettingsPersistenceSnapshot> = {}
): MemorySettingsPersistenceSnapshot {
  return {
    acceptedUtilityEgressAt: NOW,
    acceptedUtilityEgressFingerprint: "a".repeat(64),
    acceptedUtilityPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
    activeIndexGenerationId: "generation-1",
    decayEnabled: false,
    decayPolicyVersion: null,
    embeddingProviderModelId: "embedding-1",
    learnAutomatically: false,
    memoryConsentRevision: 2,
    memoryGeneration: 0,
    memoryRevision: 3,
    referenceChatHistory: true,
    sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
    settingsRevision: 4,
    synthesisEnabled: false,
    synthesisEnabledAt: null,
    synthesisPolicyVersion: null,
    lastSynthesisAt: null,
    updatedAt: NOW,
    useMemoryFacts: true,
    userId: "user-1",
    ...overrides
  };
}

function executionTarget(input: Readonly<{
  connection: string;
  model: string;
  providerModelId: string;
}>): ResolvedMemoryExecutionTarget {
  return {
    authority: {
      connectionId: "connection-1",
      connectionVersion: 2,
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      modelVersion: 3,
      providerModelId: input.providerModelId
    },
    credentialSource: "default",
    destinationFingerprint: "b".repeat(64),
    executionTargetFingerprint: "c".repeat(64),
    policyRevision: 1,
    compatibilityFingerprints: {
      configFingerprint: "d".repeat(64),
      deploymentFingerprint: "e".repeat(64),
      modelFingerprint: "f".repeat(64),
      providerFingerprint: "1".repeat(64)
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: input.connection,
      connectionId: "connection-1",
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      model: {
        adapterKind: "openai_responses_compatible",
        answerSelectable: true,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          toolCalling: false,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: input.model
      },
      modelDisplayName: input.model,
      providerFamily: "openai_compatible",
      providerModelId: input.providerModelId,
      version: 1
    }
  };
}

function policy(input: Readonly<{
  fingerprint?: string;
  withTargets?: boolean;
}> = {}): ResolvedMemoryUtilityPolicy {
  const targets = new Map();
  if (input.withTargets !== false) {
    const system = executionTarget({
      connection: "System provider",
      model: "System model",
      providerModelId: "system-1"
    });
    const embedding = executionTarget({
      connection: "Embedding provider",
      model: "Embedding model",
      providerModelId: "embedding-1"
    });
    targets.set("MEMORY_FACT_EXTRACT", system);
    targets.set("MEMORY_RERANK", system);
    targets.set("MEMORY_DOCUMENT_EMBED", embedding);
  }
  return {
    destinations: [],
    fingerprint: input.fingerprint ?? "a".repeat(64),
    policyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
    targets
  };
}

function repository(
  overrides: Partial<MemorySettingsRepository> = {}
): MemorySettingsRepository {
  return {
    get: vi.fn(async () => settings()),
    patch: vi.fn(async () => settings()),
    ...overrides
  };
}

describe("Memory settings service", () => {
  it("advertises released Memory surfaces with learning available by default", async () => {
    const service = createMemorySettingsService({
      repository: repository(),
      resolveCurrentUtilityPolicy: async () => policy()
    });

    const response = await service.get("user-1");

    expect(response.capabilities).toEqual(DEFAULT_MEMORY_SETTINGS_CAPABILITIES);
    expect(response.capabilities).toEqual({
      administratorSetupRequired: false,
      automaticLearning: true,
      automaticLearningAvailable: true,
      decayAvailable: true,
      explicitMemory: true,
      historyRecall: true,
      managementAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      permanentChatDeletion: false,
      retrievalAvailable: true,
      synthesisAvailable: true,
      temporaryChats: true
    });
  });

  it("reports history indexing disabled while the Memory master switch is off", async () => {
    const service = createMemorySettingsService({
      repository: repository({
        get: vi.fn(async () => settings({
          referenceChatHistory: true,
          useMemoryFacts: false
        }))
      }),
      resolveCurrentUtilityPolicy: async () => policy()
    });

    await expect(service.get("user-1")).resolves.toMatchObject({
      historyIndexing: {
        completedChats: 0,
        state: "DISABLED",
        totalChats: 0
      },
      settings: {
        referenceChatHistory: true,
        useMemoryFacts: false
      }
    });
  });

  it("derives rollout capabilities from the current settings and utility policy", async () => {
    const currentSettings = settings();
    const currentPolicy = policy();
    const resolveCapabilities = vi.fn(() => ({
      ...DEFAULT_MEMORY_SETTINGS_CAPABILITIES,
      automaticLearning: true
    }));
    const service = createMemorySettingsService({
      repository: repository({ get: vi.fn(async () => currentSettings) }),
      resolveCapabilities,
      resolveCurrentUtilityPolicy: async () => currentPolicy
    });

    await expect(service.get("user-1")).resolves.toMatchObject({
      capabilities: { automaticLearning: true, historyRecall: true }
    });
    expect(resolveCapabilities).toHaveBeenCalledWith(
      currentSettings,
      currentPolicy
    );
  });

  it("projects bounded settings and capabilities without an acceptance contract", async () => {
    const service = createMemorySettingsService({
      capabilities: {
        ...DEFAULT_MEMORY_SETTINGS_CAPABILITIES,
        automaticLearning: false,
        automaticLearningAvailable: false,
        historyRecall: false,
        pastChatIndexingAvailable: false
      },
      repository: repository(),
      resolveCurrentUtilityPolicy: async () => policy()
    });

    await expect(service.get("user-1")).resolves.toEqual({
      capabilities: {
        ...DEFAULT_MEMORY_SETTINGS_CAPABILITIES,
        automaticLearning: false,
        automaticLearningAvailable: false,
        historyRecall: false,
        pastChatIndexingAvailable: false
      },
      historyIndexing: {
        completedChats: 0,
        state: "READY",
        totalChats: 0
      },
      settings: {
        decayEnabled: false,
        embeddingDeployment: {
          connectionDisplayName: "Embedding provider",
          id: "embedding-1",
          modelDisplayName: "Embedding model"
        },
        learnAutomatically: false,
        memoryGeneration: 0,
        memoryRevision: 3,
        referenceChatHistory: true,
        sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
        settingsRevision: 4,
        synthesisEnabled: false,
        updatedAt: NOW.toISOString(),
        useMemoryFacts: true
      }
    });
  });

  it("keeps local management available when utility destinations are unavailable", async () => {
    const service = createMemorySettingsService({
      capabilities: {
        ...DEFAULT_MEMORY_SETTINGS_CAPABILITIES,
        automaticLearning: false,
        automaticLearningAvailable: false,
        historyRecall: false,
        pastChatIndexingAvailable: false
      },
      repository: repository(),
      resolveCurrentUtilityPolicy: async () => policy({
        fingerprint: "9".repeat(64),
        withTargets: false
      })
    });

    const response = await service.get("user-1");
    expect(response.capabilities.explicitMemory).toBe(true);
    expect(response.settings.embeddingDeployment).toBeNull();
  });

  it("ignores empty legacy acceptance and requires no additional settings mutation", async () => {
    const persisted = settings({ acceptedUtilityEgressAt: null, acceptedUtilityEgressFingerprint: null,
      acceptedUtilityPolicyVersion: null, useMemoryFacts: true, learnAutomatically: true });
    const repo = repository({ get: vi.fn(async () => persisted) });
    const service = createMemorySettingsService({ repository: repo, resolveCurrentUtilityPolicy: async () => policy() });
    const response = await service.get("user-1");
    expect(response.settings).toMatchObject({ useMemoryFacts: true, learnAutomatically: true });
    expect(response).not.toHaveProperty("egress");
    expect(response.settings).not.toHaveProperty("memoryConsentRevision");
    expect(repo.patch).not.toHaveBeenCalled();
    expect(persisted.acceptedUtilityEgressAt).toBeNull();
  });

  it("projects bounded history progress and wakes automatic enablement", async () => {
    const kick = vi.fn();
    const readHistoryIndexing = vi.fn(async () => ({
      completedChats: 2,
      state: "INDEXING" as const,
      totalChats: 5
    }));
    const service = createMemorySettingsService({
      kick,
      readHistoryIndexing,
      repository: repository(),
      resolveCurrentUtilityPolicy: async () => policy()
    });

    await expect(service.get("user-1")).resolves.toMatchObject({
      historyIndexing: {
        completedChats: 2,
        state: "INDEXING",
        totalChats: 5
      }
    });
    await service.patch("user-1", {
      expectedMemoryRevision: 3,
      expectedSettingsRevision: 4,
      referenceChatHistory: true
    });

    expect(readHistoryIndexing).toHaveBeenCalledTimes(2);
    expect(kick).toHaveBeenCalledOnce();
  });

  it("does not backfill when a patch resumes the master and history together", async () => {
    const kick = vi.fn();
    const patch = vi.fn(async () => settings({
      referenceChatHistory: true,
      useMemoryFacts: true
    }));
    const service = createMemorySettingsService({
      kick,
      repository: repository({ patch }),
      resolveCurrentUtilityPolicy: async () => policy()
    });

    await service.patch("user-1", {
      expectedMemoryRevision: 3,
      expectedSettingsRevision: 4,
      referenceChatHistory: true,
      useMemoryFacts: true
    });

    expect(patch).toHaveBeenCalledOnce();
    expect(kick).not.toHaveBeenCalled();
  });

  it("maps only stable persistence failures", async () => {
    const service = createMemorySettingsService({
      repository: repository({
        patch: vi.fn(async () => {
          throw new MemoryPersistenceError("memory_settings_conflict");
        })
      }),
      resolveCurrentUtilityPolicy: async () => policy()
    });
    await expect(service.patch("user-1", {
      expectedMemoryRevision: 3,
      expectedSettingsRevision: 4,
      useMemoryFacts: false
    })).rejects.toEqual(new MemorySettingsServiceError("memory_version_stale"));
  });
});
