import { describe, expect, it } from "vitest";
import type {
  ResolvedMemoryExecutionTarget,
  ResolvedMemoryUtilityPolicy
} from "../execution/policy";
import type { MemoryExecutionRole } from "../execution/roles";
import {
  MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES,
  memoryAutomaticLearningIsQualified
} from "./betaQualification";

const NOW = new Date("2026-08-11T12:00:00.000Z");

function target(kind: "ANSWER" | "EMBEDDING"): ResolvedMemoryExecutionTarget {
  const embedding = kind === "EMBEDDING";
  const providerModelId = embedding ? "embedding-model" : "answer-model";
  return {
    authority: {
      connectionId: `${kind.toLowerCase()}-connection`,
      connectionVersion: 2,
      credentialId: `${kind.toLowerCase()}-credential`,
      credentialVersionId: `${kind.toLowerCase()}-credential-version`,
      modelVersion: 3,
      providerModelId
    },
    credentialSource: "default",
    destinationFingerprint: (embedding ? "1" : "2").repeat(64),
    executionTargetFingerprint: (embedding ? "3" : "4").repeat(64),
    policyRevision: embedding ? null : 5,
    qualificationFingerprints: {
      configFingerprint: (embedding ? "5" : "6").repeat(64),
      deploymentFingerprint: (embedding ? "7" : "8").repeat(64),
      modelFingerprint: (embedding ? "9" : "a").repeat(64),
      providerFingerprint: (embedding ? "b" : "c").repeat(64)
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: embedding
          ? "https://embedding.example.test/v1"
          : "https://answer.example.test/v1",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: kind,
      connectionId: `${kind.toLowerCase()}-connection`,
      credentialId: `${kind.toLowerCase()}-credential`,
      credentialVersionId: `${kind.toLowerCase()}-credential-version`,
      model: embedding
        ? {
            adapterKind: "openai_embeddings_compatible",
            answerSelectable: false,
            capabilities: {
              nativePdfInput: false,
              nativeSearch: false,
              pdf: false,
              reasoning: false,
              vision: false
            },
            defaultParams: {},
            embedding: {
              nativeDimension: 4_096,
              providerFamily: "openai_compatible",
              queryInstructionTemplate: null,
              supportsMrl: true,
              targetDimension: 4_096
            },
            modelClass: "embedding",
            upstreamModelId: "custom-embedding"
          }
        : {
            adapterKind: "openai_responses_compatible",
            answerSelectable: true,
            capabilities: {
              nativePdfInput: false,
              nativeSearch: false,
              pdf: false,
              reasoning: true,
              toolCalling: true,
              vision: false
            },
            defaultParams: {},
            modelClass: "answer",
            upstreamModelId: "custom-answer"
          },
      modelDisplayName: kind,
      providerFamily: "openai_compatible",
      providerModelId,
      version: 1
    }
  };
}

function policy(): ResolvedMemoryUtilityPolicy {
  const answer = target("ANSWER");
  const embedding = target("EMBEDDING");
  const targets = new Map<MemoryExecutionRole, ResolvedMemoryExecutionTarget>();
  for (const role of MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES) {
    targets.set(
      role,
      role === "MEMORY_DOCUMENT_EMBED" || role === "MEMORY_QUERY_EMBED"
        ? embedding
        : answer
    );
  }
  return {
    destinations: [],
    fingerprint: "d".repeat(64),
    policyVersion: "memory-utility-egress-v1",
    targets
  };
}

describe("automatic Memory runtime compatibility", () => {
  it("ignores signed registries, language gates, and expiry dates", () => {
    const currentPolicy = policy();
    const authority = {
      registry: [],
      verifySignature: () => false
    };
    expect(memoryAutomaticLearningIsQualified({
      authority,
      language: "RU",
      now: NOW,
      policy: currentPolicy
    })).toBe(true);
    expect(memoryAutomaticLearningIsQualified({
      authority,
      language: "EN",
      now: new Date("2099-01-01T00:00:00.000Z"),
      policy: currentPolicy
    })).toBe(true);

    const changedFingerprints = new Map(currentPolicy.targets);
    changedFingerprints.set("MEMORY_FACT_EXTRACT", {
      ...changedFingerprints.get("MEMORY_FACT_EXTRACT")!,
      qualificationFingerprints: {
        ...changedFingerprints.get("MEMORY_FACT_EXTRACT")!.qualificationFingerprints,
        modelFingerprint: "0".repeat(64)
      }
    });
    expect(memoryAutomaticLearningIsQualified({
      authority,
      language: "RU",
      now: NOW,
      policy: { ...currentPolicy, targets: changedFingerprints }
    })).toBe(true);
  });

  it("fails only when the resolved topology is missing or transport-incompatible", () => {
    const currentPolicy = policy();
    const missingTarget = new Map(currentPolicy.targets);
    missingTarget.delete("MEMORY_FACT_EXTRACT");
    expect(memoryAutomaticLearningIsQualified({
      authority: {},
      language: "RU",
      now: NOW,
      policy: { ...currentPolicy, targets: missingTarget }
    })).toBe(false);

    const incompatibleTargets = new Map(currentPolicy.targets);
    const incompatible = incompatibleTargets.get("MEMORY_FACT_EXTRACT")!;
    incompatibleTargets.set("MEMORY_FACT_EXTRACT", {
      ...incompatible,
      snapshot: {
        ...incompatible.snapshot,
        model: {
          ...incompatible.snapshot.model,
          capabilities: {
            ...incompatible.snapshot.model.capabilities,
            toolCalling: false
          }
        }
      }
    });
    expect(memoryAutomaticLearningIsQualified({
      authority: {},
      language: "RU",
      now: NOW,
      policy: { ...currentPolicy, targets: incompatibleTargets }
    })).toBe(false);
  });
});
