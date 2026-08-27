import { describe, expect, it, vi } from "vitest";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  memoryVectorSpaceFingerprint,
  type ResolvedMemoryExecutionTarget,
  type ResolvedMemoryUtilityPolicy
} from "../execution/policy";
import type { MemoryExecutionRole } from "../execution/roles";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
} from "../persistence/lexical";
import type { MemorySettingsPersistenceSnapshot } from "../persistence/settings";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import {
  deriveMemorySettingsCapabilities,
  readMemoryCapabilityOperationalState,
  type MemoryCapabilityOperationalState
} from "./capabilities";

const NOW = new Date("2026-08-21T12:00:00.000Z");

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
    embeddingProviderModelId: "embedding-model",
    learnAutomatically: true,
    memoryConsentRevision: 1,
    memoryGeneration: 1,
    memoryRevision: 1,
    referenceChatHistory: true,
    sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
    settingsRevision: 1,
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

function target(kind: "embedding" | "system"): ResolvedMemoryExecutionTarget {
  const providerModelId = kind === "embedding" ? "embedding-model" : "system-model";
  return {
    authority: {
      connectionId: `${kind}-connection`,
      connectionVersion: 1,
      credentialId: `${kind}-credential`,
      credentialVersionId: `${kind}-credential-version`,
      modelVersion: 1,
      providerModelId
    },
    compatibilityFingerprints: {
      configFingerprint: "b".repeat(64),
      deploymentFingerprint: "c".repeat(64),
      modelFingerprint: "d".repeat(64),
      providerFingerprint: "e".repeat(64)
    },
    credentialSource: "default",
    destinationFingerprint: "f".repeat(64),
    executionTargetFingerprint: "1".repeat(64),
    policyRevision: 1,
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: `${kind} provider`,
      connectionId: `${kind}-connection`,
      credentialId: `${kind}-credential`,
      credentialVersionId: `${kind}-credential-version`,
      model: kind === "embedding" ? {
        adapterKind: "openai_embeddings_compatible",
        answerSelectable: false,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          toolCalling: false,
          vision: false
        },
        defaultParams: {},
        embedding: {
          nativeDimension: 1_024,
          providerFamily: "openai_compatible",
          queryInstructionTemplate: null,
          supportsMrl: false,
          targetDimension: 1_024
        },
        modelClass: "embedding",
        upstreamModelId: "embedding-upstream"
      } : {
        adapterKind: "openai_responses_compatible",
        answerSelectable: true,
        capabilities: {
          nativePdfInput: false,
          nativeSearch: false,
          pdf: false,
          reasoning: false,
          structuredOutput: true,
          toolCalling: true,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "system-upstream"
      },
      modelDisplayName: `${kind} model`,
      providerFamily: "openai_compatible",
      providerModelId,
      version: 1
    }
  };
}

function policy(
  omitted: readonly MemoryExecutionRole[] = []
): ResolvedMemoryUtilityPolicy {
  const system = target("system");
  const embedding = target("embedding");
  const targets = new Map<MemoryExecutionRole, ResolvedMemoryExecutionTarget>();
  for (const role of [
    "MEMORY_CONTROL",
    "MEMORY_STATEMENT_CLASSIFY",
    "MEMORY_HISTORY_CLASSIFY",
    "MEMORY_FACT_EXTRACT",
    "MEMORY_CONSOLIDATE",
    "MEMORY_RERANK",
    "MEMORY_SYNTHESIZE",
    "MEMORY_DOCUMENT_EMBED",
    "MEMORY_QUERY_EMBED"
  ] as const) {
    if (!omitted.includes(role)) {
      targets.set(role, role.endsWith("EMBED") ? embedding : system);
    }
  }
  return {
    destinations: [],
    fingerprint: "a".repeat(64),
    policyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
    targets
  };
}

const operations: MemoryCapabilityOperationalState = Object.freeze({
  adminAcceptedDestinations: [],
  retrievalIndexAvailable: true,
  workerAvailable: true
});

function derive(input: Readonly<{
  adminAcceptedRoles?: readonly MemoryExecutionRole[];
  consentMode?: "ADMIN" | "PER_USER";
  omitted?: readonly MemoryExecutionRole[];
  operations?: Partial<Omit<typeof operations, "adminAcceptedDestinations">>;
  settings?: Partial<MemorySettingsPersistenceSnapshot>;
}> = {}) {
  const currentPolicy = policy(input.omitted);
  return deriveMemorySettingsCapabilities({
    base: { permanentChatDeletion: true, temporaryChats: true },
    consentMode: input.consentMode ?? "PER_USER",
    operations: {
      ...operations,
      ...input.operations,
      adminAcceptedDestinations: (input.adminAcceptedRoles ?? []).flatMap((role) => {
        const resolved = currentPolicy.targets.get(role);
        return resolved
          ? [{ destinationFingerprint: resolved.destinationFingerprint, role }]
          : [];
      })
    },
    policy: currentPolicy,
    settings: settings(input.settings)
  });
}

describe("Memory capability projection", () => {
  it("reports the five v1 capabilities independently", () => {
    expect(derive()).toMatchObject({
      automaticLearningAvailable: true,
      managementAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });

    expect(derive({ omitted: ["MEMORY_RERANK"] })).toMatchObject({
      automaticLearningAvailable: true,
      managementAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(derive({ omitted: ["MEMORY_DOCUMENT_EMBED"] })).toMatchObject({
      automaticLearningAvailable: true,
      managementAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(derive({ operations: { workerAvailable: false } })).toMatchObject({
      automaticLearningAvailable: false,
      managementAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: false,
      retrievalAvailable: true
    });
    expect(derive({ operations: { retrievalIndexAvailable: false } })).toMatchObject({
      automaticLearningAvailable: false,
      managementAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: false,
      retrievalAvailable: false
    });
  });

  it("keeps local and lexical fallbacks independent from optional utility roles", () => {
    expect(derive({ omitted: ["MEMORY_CONTROL"] })).toMatchObject({
      automaticLearningAvailable: true,
      naturalLanguageActionsAvailable: false,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(derive({ omitted: ["MEMORY_HISTORY_CLASSIFY"] })).toMatchObject({
      automaticLearningAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(derive({ omitted: ["MEMORY_QUERY_EMBED"] })).toMatchObject({
      automaticLearningAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
  });

  it.each([
    ["MEMORY_FACT_EXTRACT"],
    ["MEMORY_CONSOLIDATE"]
  ] as const)("fails automatic learning when %s alone is unavailable", (role) => {
    expect(derive({ omitted: [role] }).automaticLearningAvailable).toBe(false);
  });

  it("gates opt-in synthesis on its exact strict role, consent, and worker", () => {
    const enabled = { synthesisEnabled: true } as const;
    expect(derive({ settings: enabled })).toMatchObject({
      administratorSetupRequired: false,
      synthesisAvailable: true
    });
    expect(derive({
      omitted: ["MEMORY_SYNTHESIZE"],
      settings: enabled
    })).toMatchObject({
      administratorSetupRequired: true,
      synthesisAvailable: false
    });
    expect(derive({
      operations: { workerAvailable: false },
      settings: enabled
    })).toMatchObject({
      administratorSetupRequired: true,
      synthesisAvailable: false
    });
    expect(derive({ settings: {
      ...enabled,
      acceptedUtilityEgressAt: null,
      acceptedUtilityEgressFingerprint: null,
      acceptedUtilityPolicyVersion: null
    } })).toMatchObject({
      administratorSetupRequired: true,
      synthesisAvailable: false
    });
  });

  it("gates opt-in decay only on the admitted retrieval capability", () => {
    expect(derive()).toMatchObject({ decayAvailable: false });
    const enabled = {
      decayEnabled: true,
      decayPolicyVersion: "memory-decay-v1"
    } as const;
    expect(derive({ settings: enabled })).toMatchObject({
      decayAvailable: true,
      retrievalAvailable: true
    });
    expect(derive({ settings: {
      decayEnabled: true,
      decayPolicyVersion: "memory-decay-future"
    } })).toMatchObject({ decayAvailable: false, retrievalAvailable: true });
    expect(derive({
      omitted: ["MEMORY_RERANK"],
      settings: enabled
    })).toMatchObject({ decayAvailable: true, retrievalAvailable: true });
    expect(derive({
      operations: { workerAvailable: false },
      settings: enabled
    })).toMatchObject({ decayAvailable: true, retrievalAvailable: true });
    expect(derive({
      settings: { ...enabled, useMemoryFacts: false }
    })).toMatchObject({ decayAvailable: false, retrievalAvailable: false });
  });

  it("projects ADMIN consent per exact execution role and destination", () => {
    const allRoles = [
      "MEMORY_CONTROL",
      "MEMORY_STATEMENT_CLASSIFY",
      "MEMORY_HISTORY_CLASSIFY",
      "MEMORY_FACT_EXTRACT",
      "MEMORY_CONSOLIDATE",
      "MEMORY_RERANK",
      "MEMORY_SYNTHESIZE",
      "MEMORY_DOCUMENT_EMBED",
      "MEMORY_QUERY_EMBED"
    ] as const satisfies readonly MemoryExecutionRole[];
    const admin = (missing?: MemoryExecutionRole) => derive({
      adminAcceptedRoles: allRoles.filter((role) => role !== missing),
      consentMode: "ADMIN"
    });

    expect(admin()).toMatchObject({
      administratorSetupRequired: false,
      automaticLearningAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(admin("MEMORY_STATEMENT_CLASSIFY")).toMatchObject({
      administratorSetupRequired: false,
      automaticLearningAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(admin("MEMORY_CONTROL")).toMatchObject({
      administratorSetupRequired: false,
      automaticLearningAvailable: true,
      naturalLanguageActionsAvailable: false,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(admin("MEMORY_HISTORY_CLASSIFY")).toMatchObject({
      administratorSetupRequired: false,
      automaticLearningAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(admin("MEMORY_FACT_EXTRACT")).toMatchObject({
      administratorSetupRequired: true,
      automaticLearningAvailable: false,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(admin("MEMORY_CONSOLIDATE")).toMatchObject({
      administratorSetupRequired: true,
      automaticLearningAvailable: false,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(admin("MEMORY_RERANK")).toMatchObject({
      administratorSetupRequired: false,
      automaticLearningAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(admin("MEMORY_DOCUMENT_EMBED")).toMatchObject({
      administratorSetupRequired: false,
      automaticLearningAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(admin("MEMORY_QUERY_EMBED")).toMatchObject({
      administratorSetupRequired: false,
      automaticLearningAvailable: true,
      naturalLanguageActionsAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(derive({
      adminAcceptedRoles: allRoles,
      consentMode: "ADMIN",
      settings: { synthesisEnabled: true }
    })).toMatchObject({ synthesisAvailable: true });
    expect(derive({
      adminAcceptedRoles: allRoles.filter((role) => role !== "MEMORY_SYNTHESIZE"),
      consentMode: "ADMIN",
      settings: { synthesisEnabled: true }
    })).toMatchObject({
      administratorSetupRequired: true,
      synthesisAvailable: false
    });
  });

  it("keeps manual management available while master, subordinate, or consent gates pause inference", () => {
    expect(derive({ settings: { useMemoryFacts: false } })).toMatchObject({
      automaticLearningAvailable: false,
      managementAvailable: true,
      naturalLanguageActionsAvailable: false,
      pastChatIndexingAvailable: false,
      retrievalAvailable: false
    });
    expect(derive({ settings: { learnAutomatically: false } })).toMatchObject({
      automaticLearningAvailable: false,
      managementAvailable: true,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
    expect(derive({ settings: { referenceChatHistory: false } })).toMatchObject({
      automaticLearningAvailable: true,
      managementAvailable: true,
      pastChatIndexingAvailable: false,
      retrievalAvailable: true
    });
    expect(derive({ settings: {
      acceptedUtilityEgressAt: null,
      acceptedUtilityEgressFingerprint: null,
      acceptedUtilityPolicyVersion: null
    } })).toMatchObject({
      automaticLearningAvailable: false,
      managementAvailable: true,
      naturalLanguageActionsAvailable: false,
      pastChatIndexingAvailable: true,
      retrievalAvailable: true
    });
  });

  it("requires a fresh worker and a compatible active retrieval generation", async () => {
    const currentPolicy = policy();
    const embedding = currentPolicy.targets.get("MEMORY_QUERY_EMBED")!;
    const findGeneration = vi.fn(async () => ({
      chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
      embeddingConfigurationFingerprint: embedding.compatibilityFingerprints.configFingerprint,
      embeddingProviderModelId: embedding.snapshot.providerModelId,
      indexMode: "HYBRID",
      languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
      normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
      retrievalPipelineVersion: MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION,
      state: "ACTIVE",
      vectorSpaceFingerprint: memoryVectorSpaceFingerprint(embedding)
    }));
    const findHeartbeat = vi.fn(async () => ({
      lastSeenAt: new Date(NOW.getTime() - 1_000)
    }));
    const state = await readMemoryCapabilityOperationalState({
      memoryIndexGeneration: { findFirst: findGeneration },
      memoryWorkerHeartbeat: { findUnique: findHeartbeat }
    } as never, {
      consentMode: "PER_USER",
      now: NOW,
      policy: currentPolicy,
      settings: settings()
    });

    expect(state).toEqual({
      adminAcceptedDestinations: [],
      retrievalIndexAvailable: true,
      workerAvailable: true
    });
    expect(findGeneration).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "generation-1", userId: "user-1" }
    }));
    expect(findHeartbeat).toHaveBeenCalledWith({
      select: { lastSeenAt: true },
      where: { id: "installation" }
    });
  });

  it("admits an active lexical generation without a query-embedding target", async () => {
    const state = await readMemoryCapabilityOperationalState({
      memoryIndexGeneration: {
        findFirst: vi.fn(async () => ({
          chunkingVersion: MEMORY_LEXICAL_CHUNKING_VERSION,
          embeddingConfigurationFingerprint: null,
          embeddingProviderModelId: null,
          indexMode: "LEXICAL_ONLY",
          languageProfile: MEMORY_LEXICAL_LANGUAGE_PROFILE,
          normalizationVersion: MEMORY_LEXICAL_NORMALIZATION_VERSION,
          retrievalPipelineVersion: MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION,
          state: "ACTIVE",
          vectorSpaceFingerprint: null
        }))
      },
      memoryWorkerHeartbeat: {
        findUnique: vi.fn(async () => null)
      }
    } as never, {
      consentMode: "PER_USER",
      now: NOW,
      policy: policy(["MEMORY_QUERY_EMBED"]),
      settings: settings({ embeddingProviderModelId: null })
    });

    expect(state).toEqual({
      adminAcceptedDestinations: [],
      retrievalIndexAvailable: true,
      workerAvailable: false
    });
  });

  it("reads and validates the installation-owned ADMIN destination set", async () => {
    const currentPolicy = policy();
    const control = currentPolicy.targets.get("MEMORY_CONTROL")!;
    const acceptedDestinations = [{
      destinationFingerprint: control.destinationFingerprint,
      role: "MEMORY_CONTROL"
    }];
    const findAdminPolicy = vi.fn(async () => ({
      acceptedAt: NOW,
      acceptedDestinations,
      acceptedPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
    }));
    const client = {
      memoryEgressAdminPolicy: { findUnique: findAdminPolicy },
      memoryIndexGeneration: { findFirst: vi.fn(async () => null) },
      memoryWorkerHeartbeat: { findUnique: vi.fn(async () => null) }
    } as never;
    const input = {
      consentMode: "ADMIN",
      now: NOW,
      policy: currentPolicy,
      settings: settings({ activeIndexGenerationId: null })
    } as const;
    const state = await readMemoryCapabilityOperationalState(client, input);

    expect(state.adminAcceptedDestinations).toEqual(acceptedDestinations);
    expect(findAdminPolicy).toHaveBeenCalledWith({
      select: {
        acceptedAt: true,
        acceptedDestinations: true,
        acceptedPolicyVersion: true
      },
      where: { id: "installation" }
    });

    findAdminPolicy.mockResolvedValueOnce({
      acceptedAt: NOW,
      acceptedDestinations,
      acceptedPolicyVersion: "stale-policy"
    });
    await expect(readMemoryCapabilityOperationalState(client, input)).resolves
      .toMatchObject({ adminAcceptedDestinations: [] });
  });
});
