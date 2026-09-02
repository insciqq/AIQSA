import { describe, expect, it } from "vitest";
import { MemoryExecutionError } from "./errors";
import type { ResolvedMemoryExecutionTarget } from "./policy";
import { resolveMemoryExecutionCompatibility } from "./compatibility";
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
  it("keeps the bounded role and strict-output declarations", () => {
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_FACT_EXTRACT");
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_RERANK");
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_QUERY_RESOLVE");
    expect(MEMORY_EXECUTION_ROLES).toContain("MEMORY_AGGREGATE");
    expect(MEMORY_EXECUTABLE_ROLES).not.toContain("MEMORY_AGGREGATE");
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
