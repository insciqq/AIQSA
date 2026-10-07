import { describe, expect, it } from "vitest";
import { MemoryExecutionError } from "./errors";
import type { ResolvedMemoryExecutionTarget } from "./policy";
import { resolveMemoryExecutionCompatibility } from "./compatibility";
import {
  createMemoryExecutionSnapshot,
  freezeMemoryCatalogTokenPricing,
  memoryExecutionCatalogTokenPricing,
  memoryExecutionSnapshotIdentity,
  parseMemoryExecutionSnapshot,
  storedMemoryExecutionSnapshot
} from "./snapshot";
import { memoryFactProviderEvidence } from "../learning/extraction/runtime";
import { memoryFactDecisionProviderEvidence } from "../learning/consolidation/runtime";
import { jevModelConfiguration, JEV_SERVED_MODEL_ID } from "../../../domain/decisionModels";
import {
  MEMORY_EXECUTABLE_ROLES,
  MEMORY_EXECUTION_ROLES,
  MEMORY_STRICT_OUTPUT_ROLES
} from "./roles";

const versions = {
  pipelineVersion: "memory-pipeline-v2",
  policyVersion: "memory-policy-v2",
  promptVersion: "memory-prompt-v2",
  retrievalConfigFingerprint: "memory-retrieval-v2",
  schemaVersion: "memory-schema-v2"
} as const;

function target(
  toolCalling: boolean,
  structuredOutput = toolCalling
): ResolvedMemoryExecutionTarget {
  return {
    authority: {
      connectionId: "connection-1",
      connectionVersion: 2,
      credentialId: "credential-1",
      credentialVersionId: "credential-version-1",
      modelVersion: 3,
      providerModelId: "provider-model-1"
    },
    credentialSource: "default",
    destinationFingerprint: "1".repeat(64),
    executionTargetFingerprint: "2".repeat(64),
    policyRevision: 4,
    compatibilityFingerprints: {
      configFingerprint: "3".repeat(64),
      deploymentFingerprint: "4".repeat(64),
      modelFingerprint: "5".repeat(64),
      providerFingerprint: "6".repeat(64)
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        authenticationMode: "bearer",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: "Custom provider",
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
          forcedToolCalling: toolCalling,
          reasoning: false,
          structuredOutput,
          toolCalling,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "custom-strict-model"
      },
      modelDisplayName: "Custom strict model",
      providerFamily: "openai_compatible",
      providerModelId: "provider-model-1",
      version: 1
    }
  };
}

describe("Memory execution compatibility", () => {
  it("accepts a verified decision target only for the optional control screen", () => {
    const base = target(false);
    const decisionTarget = { ...base, snapshot: {
      ...base.snapshot,
      providerFamily: "openrouter" as const,
      model: jevModelConfiguration(),
      decisionVerification: { probeVersion: 1 as const, adapterKind: "openrouter_decisions" as const,
        upstreamModelId: "typesafe/jev-1.13", servedModelId: JEV_SERVED_MODEL_ID,
        provider: "TypeSafe", noul: true as const, choice: true as const }
    } };
    expect(resolveMemoryExecutionCompatibility({ role: "MEMORY_CONTROL_SCREEN",
      target: decisionTarget, versions })).toMatchObject({ requirement: expect.anything() });
    expect(() => resolveMemoryExecutionCompatibility({ role: "MEMORY_CONTROL",
      target: decisionTarget, versions })).toThrow("memory_execution_capability_unavailable");
  });
  it("pins the new output policy and preserves the version of previously accepted work", () => {
    const acceptedTarget = target(true);
    const compatibility = resolveMemoryExecutionCompatibility({
      role: "MEMORY_FACT_EXTRACT", target: acceptedTarget, versions
    });
    const snapshot = createMemoryExecutionSnapshot({
      acceptedUtilityEgressFingerprint: "7".repeat(64),
      compatibilityId: compatibility.compatibilityId,
      compatibilityRequirement: compatibility.requirement,
      requiresStrictStructuredOutput: true,
      role: "MEMORY_FACT_EXTRACT", target: acceptedTarget, utilityPolicyVersion: "test-v1"
    });
    expect(snapshot.version).toBe(4);
    expect(snapshot.requiredToolModes).toEqual(["native"]);
    expect(memoryFactProviderEvidence(snapshot).memorySnapshotVersion).toBe(4);
    expect(memoryFactProviderEvidence(snapshot).requiredToolModes).toEqual(["native"]);
    expect(memoryFactDecisionProviderEvidence({ ...snapshot, logicalRole: "MEMORY_CONSOLIDATE" })
      .memorySnapshotVersion).toBe(4);
    const { generationBudget: _budget, ...oldSnapshot } = snapshot as Extract<typeof snapshot, { version: 4 }>;
    void _budget;
    const legacy = { ...oldSnapshot, version: 2 as const };
    expect(parseMemoryExecutionSnapshot(legacy)).toEqual(legacy);
    expect(memoryFactProviderEvidence(legacy).memorySnapshotVersion).toBeUndefined();
    expect(() => parseMemoryExecutionSnapshot({ ...snapshot, version: 5 }))
      .toThrow("memory_execution_snapshot_invalid");
    expect(() => parseMemoryExecutionSnapshot({ ...snapshot, requiredToolModes: ["native", "native"] }))
      .toThrow("memory_execution_snapshot_invalid");
    const autoBase = target(true);
    const autoTarget = { ...autoBase, snapshot: { ...autoBase.snapshot, model: { ...autoBase.snapshot.model,
      capabilities: { ...autoBase.snapshot.model.capabilities,
        forcedToolCalling: false, validatedAutoToolCalling: true, nativeForcedToolChoice: false }
    } } };
    const autoCompatibility = resolveMemoryExecutionCompatibility({
      role: "MEMORY_FACT_EXTRACT", target: autoTarget, versions
    });
    const autoSnapshot = createMemoryExecutionSnapshot({
      acceptedUtilityEgressFingerprint: "7".repeat(64),
      compatibilityId: autoCompatibility.compatibilityId,
      compatibilityRequirement: autoCompatibility.requirement,
      requiresStrictStructuredOutput: true,
      role: "MEMORY_FACT_EXTRACT", target: autoTarget, utilityPolicyVersion: "test-v1"
    });
    expect(autoSnapshot.requiredToolModes).toEqual(["validated_auto"]);
  });
  it("keeps the frozen catalog price beside, never inside, the execution identity", () => {
    const acceptedTarget = target(true);
    const compatibility = resolveMemoryExecutionCompatibility({
      role: "MEMORY_FACT_EXTRACT", target: acceptedTarget, versions
    });
    const snapshot = createMemoryExecutionSnapshot({
      acceptedUtilityEgressFingerprint: "7".repeat(64),
      compatibilityId: compatibility.compatibilityId,
      compatibilityRequirement: compatibility.requirement,
      requiresStrictStructuredOutput: true,
      role: "MEMORY_FACT_EXTRACT", target: acceptedTarget, utilityPolicyVersion: "test-v1"
    });
    const pricing = {
      cachedInputTokenPriceUsdPerMillion: 0.01, cacheWriteInputTokenPriceUsdPerMillion: null,
      inputTokenPriceUsdPerMillion: 0.1, outputTokenPriceUsdPerMillion: 0.5
    };
    expect(freezeMemoryCatalogTokenPricing({
      cachedInputTokenPriceUsdPerMillion: 0.01, inputTokenPriceUsdPerMillion: 0.1,
      outputTokenPriceUsdPerMillion: 0.5
    })).toEqual(pricing);
    // As persisted: the snapshot and its frozen price after a JSON round trip.
    const stored = JSON.parse(JSON.stringify(storedMemoryExecutionSnapshot(snapshot, pricing)));
    expect(memoryExecutionCatalogTokenPricing(stored)).toEqual(pricing);
    expect(parseMemoryExecutionSnapshot(stored)).toEqual(snapshot);
    expect(memoryExecutionSnapshotIdentity(stored)).toEqual(JSON.parse(JSON.stringify(snapshot)));
    // Bindings admitted before freezing, and models without an input price, have none.
    expect(memoryExecutionCatalogTokenPricing(JSON.parse(JSON.stringify(snapshot)))).toBeNull();
    expect(memoryExecutionCatalogTokenPricing(storedMemoryExecutionSnapshot(snapshot, null))).toBeNull();
    expect(freezeMemoryCatalogTokenPricing({
      inputTokenPriceUsdPerMillion: null, outputTokenPriceUsdPerMillion: 0.5
    })).toBeNull();
    // Embedding and reranker models carry an input price only.
    const inputOnly = {
      cachedInputTokenPriceUsdPerMillion: null, cacheWriteInputTokenPriceUsdPerMillion: null,
      inputTokenPriceUsdPerMillion: 0.13, outputTokenPriceUsdPerMillion: null
    };
    expect(freezeMemoryCatalogTokenPricing({
      inputTokenPriceUsdPerMillion: 0.13, outputTokenPriceUsdPerMillion: null
    })).toEqual(inputOnly);
    expect(memoryExecutionCatalogTokenPricing(JSON.parse(JSON.stringify(
      storedMemoryExecutionSnapshot(snapshot, inputOnly))))).toEqual(inputOnly);
    for (const invalid of [
      { ...pricing, inputTokenPriceUsdPerMillion: -1 },
      { ...pricing, inputTokenPriceUsdPerMillion: null },
      { ...pricing, outputTokenPriceUsdPerMillion: -1 },
      { ...pricing, reasoningTokenPriceUsdPerMillion: 1 },
      "0.1"
    ]) {
      expect(() => parseMemoryExecutionSnapshot({ ...stored, catalogTokenPricing: invalid }))
        .toThrow("memory_execution_snapshot_invalid");
    }
  });
  it("keeps the bounded role and strict-output declarations", () => {
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_FACT_EXTRACT");
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_RERANK");
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_CONTROL_SCREEN");
    expect(MEMORY_EXECUTABLE_ROLES).toContain("MEMORY_CONTROL_SCREEN");
    expect(MEMORY_STRICT_OUTPUT_ROLES).not.toContain("MEMORY_CONTROL_SCREEN");
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_QUERY_RESOLVE");
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_AGGREGATE");
    expect(MEMORY_EXECUTABLE_ROLES).not.toContain("MEMORY_AGGREGATE");
    expect(MEMORY_EXECUTABLE_ROLES).not.toContain("MEMORY_HISTORY_CLASSIFY");
    expect(MEMORY_EXECUTABLE_ROLES).not.toContain("MEMORY_QUERY_RESOLVE");
    expect(MEMORY_STRICT_OUTPUT_ROLES).toContain("MEMORY_FACT_EXTRACT");
    expect(MEMORY_STRICT_OUTPUT_ROLES).toContain("MEMORY_QUERY_RESOLVE");
    expect(MEMORY_STRICT_OUTPUT_ROLES).not.toContain("MEMORY_AGGREGATE");
    expect(MEMORY_STRICT_OUTPUT_ROLES).not.toContain("MEMORY_RERANK");
    expect(MEMORY_STRICT_OUTPUT_ROLES).not.toContain("MEMORY_QUERY_EMBED");
  });

  it("admits any compatible administrator-selected model", () => {
    const compatible = resolveMemoryExecutionCompatibility({
      role: "MEMORY_FACT_EXTRACT",
      target: target(true),
      versions
    });

    expect(compatible).toMatchObject({
      compatibilityId: expect.stringMatching(/^compat\.[a-f0-9]{64}$/u),
      requirement: {
        compatibilityVersion: "memory-runtime-compatibility-v2",
        role: "MEMORY_FACT_EXTRACT",
        vectorSpaceFingerprint: null
      },
      requiresStrictStructuredOutput: true
    });
  });

  it("still rejects an incompatible strict-output transport", () => {
    expect(() => resolveMemoryExecutionCompatibility({
      role: "MEMORY_FACT_EXTRACT",
      target: target(false),
      versions
    })).toThrow(new MemoryExecutionError("memory_execution_capability_unavailable"));
  });

  it("rejects tool calling without verified structured output", () => {
    expect(() => resolveMemoryExecutionCompatibility({
      role: "MEMORY_RERANK",
      target: target(true, false),
      versions
    })).toThrow(new MemoryExecutionError("memory_execution_capability_unavailable"));
  });
});
