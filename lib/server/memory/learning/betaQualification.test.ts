import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalMemoryQualificationPayload,
  type MemoryCapabilityQualification,
  type MemoryQualificationRequirement
} from "../../../evaluation/memory/qualification";
import { memoryVectorSpaceFingerprint } from "../execution/policy";
import type {
  ResolvedMemoryExecutionTarget,
  ResolvedMemoryUtilityPolicy
} from "../execution/policy";
import type { MemoryExecutionRole } from "../execution/roles";
import {
  MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES,
  memoryAutomaticLearningIsQualified,
  memoryAutomaticLearningVersions
} from "./betaQualification";

const NOW = new Date("2026-08-11T12:00:00.000Z");
const HMAC_KEY = Buffer.from("memory-learning-capability-test-key", "utf8");

function target(kind: "ANSWER" | "EMBEDDING"): ResolvedMemoryExecutionTarget {
  const embedding = kind === "EMBEDDING";
  const providerModelId = embedding ? "embedding-model" : "answer-model";
  return {
    authority: {
      connectionId: embedding ? "embedding-connection" : "answer-connection",
      connectionVersion: 2,
      credentialId: embedding ? "embedding-credential" : "answer-credential",
      credentialVersionId: embedding
        ? "embedding-credential-version"
        : "answer-credential-version",
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
      connectionDisplayName: embedding ? "Embedding" : "Answer",
      connectionId: embedding ? "embedding-connection" : "answer-connection",
      credentialId: embedding ? "embedding-credential" : "answer-credential",
      credentialVersionId: embedding
        ? "embedding-credential-version"
        : "answer-credential-version",
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
            upstreamModelId: "qualified-embedding"
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
            upstreamModelId: "qualified-answer"
          },
      modelDisplayName: embedding ? "Embedding" : "Answer",
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

function requirement(
  role: (typeof MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES)[number],
  executionTarget: ResolvedMemoryExecutionTarget,
  language: "EN" | "RU" = "RU"
): MemoryQualificationRequirement {
  return {
    ...executionTarget.qualificationFingerprints,
    corpusHash: "e".repeat(64),
    corpusVersion: "memory-learning-corpus-v2",
    language,
    ...memoryAutomaticLearningVersions(role),
    role,
    scorerVersion: "memory-evaluation-scorer-v1",
    suiteVersion: "memory-automatic-learning-beta-v2",
    vectorSpaceFingerprint: memoryVectorSpaceFingerprint(executionTarget)
  };
}

function signed(
  key: MemoryQualificationRequirement,
  index: number
): MemoryCapabilityQualification {
  const unsigned: MemoryCapabilityQualification = {
    approval: {
      approvalId: "memory-learning-approval-v1",
      approved: true,
      approvedAt: "2026-08-11T00:00:00.000Z",
      approvedBy: "memory-test-operator",
      expiresAt: "2026-09-11T00:00:00.000Z",
      signature: "pending"
    },
    evidenceDigest: "f".repeat(64),
    key,
    qualificationId: `memory-learning-${key.role.toLowerCase()}-${index}`
  };
  return {
    ...unsigned,
    approval: {
      ...unsigned.approval,
      signature: createHmac("sha256", HMAC_KEY)
        .update(canonicalMemoryQualificationPayload(unsigned), "utf8")
        .digest("hex")
    }
  };
}

function authority(currentPolicy: ResolvedMemoryUtilityPolicy) {
  const registry = MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES.map((role, index) => {
    const executionTarget = currentPolicy.targets.get(role)!;
    return signed(requirement(role, executionTarget), index);
  });
  return {
    corpusHash: "e".repeat(64),
    corpusVersion: "memory-learning-corpus-v2",
    registry,
    scorerVersion: "memory-evaluation-scorer-v1",
    suiteVersion: "memory-automatic-learning-beta-v2",
    verifySignature: (payload: string, signature: string) =>
      createHmac("sha256", HMAC_KEY).update(payload, "utf8").digest("hex") === signature
  } as const;
}

describe("automatic Memory learning beta qualification", () => {
  it("advertises one capability only when every effective role is exactly qualified", () => {
    const currentPolicy = policy();
    const complete = authority(currentPolicy);
    expect(memoryAutomaticLearningIsQualified({
      authority: complete,
      language: "RU",
      now: NOW,
      policy: currentPolicy
    })).toBe(true);

    for (const role of MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES) {
      expect(memoryAutomaticLearningIsQualified({
        authority: {
          ...complete,
          registry: complete.registry.filter(({ key }) => key.role !== role)
        },
        language: "RU",
        now: NOW,
        policy: currentPolicy
      }), role).toBe(false);
    }
  });

  it("fails closed for a missing target, stale deployment, language gap, or expiry", () => {
    const currentPolicy = policy();
    const complete = authority(currentPolicy);
    const missingTarget = new Map(currentPolicy.targets);
    missingTarget.delete("MEMORY_VERIFY");
    expect(memoryAutomaticLearningIsQualified({
      authority: complete,
      language: "RU",
      now: NOW,
      policy: { ...currentPolicy, targets: missingTarget }
    })).toBe(false);

    const staleTargets = new Map(currentPolicy.targets);
    staleTargets.set("MEMORY_FACT_EXTRACT", {
      ...staleTargets.get("MEMORY_FACT_EXTRACT")!,
      qualificationFingerprints: {
        ...staleTargets.get("MEMORY_FACT_EXTRACT")!.qualificationFingerprints,
        modelFingerprint: "0".repeat(64)
      }
    });
    expect(memoryAutomaticLearningIsQualified({
      authority: complete,
      language: "RU",
      now: NOW,
      policy: { ...currentPolicy, targets: staleTargets }
    })).toBe(false);
    expect(memoryAutomaticLearningIsQualified({
      authority: complete,
      language: "EN",
      now: NOW,
      policy: currentPolicy
    })).toBe(false);
    expect(memoryAutomaticLearningIsQualified({
      authority: complete,
      language: "RU",
      now: new Date("2026-09-11T00:00:00.000Z"),
      policy: currentPolicy
    })).toBe(false);
  });
});
