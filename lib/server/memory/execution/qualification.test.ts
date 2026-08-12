import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type {
  MemoryCapabilityQualification,
  MemoryQualificationRequirement
} from "../../../evaluation/memory/qualification";
import { canonicalMemoryQualificationPayload } from "../../../evaluation/memory/qualification";
import { MemoryExecutionError } from "./errors";
import type { ResolvedMemoryExecutionTarget } from "./policy";
import { qualifyMemoryExecution } from "./qualification";
import { MEMORY_EXECUTION_ROLES, MEMORY_STRICT_OUTPUT_ROLES } from "./roles";

const KEY = Buffer.from("memory-execution-strict-output-test", "utf8");
const versions = {
  pipelineVersion: "memory-pipeline-v1",
  policyVersion: "memory-policy-v1",
  promptVersion: "memory-prompt-v1",
  retrievalConfigFingerprint: "memory-retrieval-v1",
  schemaVersion: "memory-schema-v1"
} as const;

function target(toolCalling: boolean): ResolvedMemoryExecutionTarget {
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
    qualificationFingerprints: {
      configFingerprint: "3".repeat(64),
      deploymentFingerprint: "4".repeat(64),
      modelFingerprint: "5".repeat(64),
      providerFingerprint: "6".repeat(64)
    },
    snapshot: {
      connection: {
        allowPrivateNetwork: false,
        apiRoot: "https://provider.example.test/v1",
        responseTimeoutMs: 30_000
      },
      connectionDisplayName: "Provider",
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
          toolCalling,
          vision: false
        },
        defaultParams: {},
        modelClass: "answer",
        upstreamModelId: "strict-model"
      },
      modelDisplayName: "Strict model",
      providerFamily: "openai_compatible",
      providerModelId: "provider-model-1",
      version: 1
    }
  };
}

function requirementFor(executionTarget: ResolvedMemoryExecutionTarget): MemoryQualificationRequirement {
  return {
    ...executionTarget.qualificationFingerprints,
    corpusHash: "7".repeat(64),
    corpusVersion: "memory-corpus-v1",
    language: "RU",
    pipelineVersion: versions.pipelineVersion,
    policyVersion: versions.policyVersion,
    promptVersion: versions.promptVersion,
    retrievalConfigFingerprint: versions.retrievalConfigFingerprint,
    role: "MEMORY_FACT_EXTRACT",
    schemaVersion: versions.schemaVersion,
    scorerVersion: "memory-scorer-v1",
    suiteVersion: "memory-suite-v1",
    vectorSpaceFingerprint: null
  };
}

function signed(requirement: MemoryQualificationRequirement): MemoryCapabilityQualification {
  const qualification: MemoryCapabilityQualification = {
    approval: {
      approvalId: "approval-v1",
      approved: true,
      approvedAt: "2026-08-10T00:00:00.000Z",
      approvedBy: "operator-v1",
      expiresAt: "2026-09-10T00:00:00.000Z",
      signature: "pending"
    },
    evidenceDigest: "8".repeat(64),
    key: requirement,
    qualificationId: "qualification-v1"
  };
  return {
    ...qualification,
    approval: {
      ...qualification.approval,
      signature: createHmac("sha256", KEY)
        .update(canonicalMemoryQualificationPayload(qualification), "utf8")
        .digest("hex")
    }
  };
}

describe("Memory execution qualification", () => {
  it("covers every approved logical role and marks only schema-bound roles strict", () => {
    expect(MEMORY_EXECUTION_ROLES).toEqual([
      "MEMORY_EPISODE_EXTRACT",
      "MEMORY_FACT_EXTRACT",
      "MEMORY_CONSOLIDATE",
      "MEMORY_VERIFY",
      "MEMORY_QUERY_EXPAND",
      "MEMORY_RERANK",
      "MEMORY_PROFILE",
      "MEMORY_DOCUMENT_EMBED",
      "MEMORY_QUERY_EMBED"
    ]);
    expect(MEMORY_STRICT_OUTPUT_ROLES).toEqual([
      "MEMORY_EPISODE_EXTRACT",
      "MEMORY_FACT_EXTRACT",
      "MEMORY_CONSOLIDATE",
      "MEMORY_VERIFY",
      "MEMORY_PROFILE"
    ]);
  });

  it("requires both declared schema transport and an exact signed role qualification", () => {
    const capable = target(true);
    const qualification = signed(requirementFor(capable));
    const authority = {
      corpusHash: "7".repeat(64),
      corpusVersion: "memory-corpus-v1",
      registry: [qualification],
      scorerVersion: "memory-scorer-v1",
      suiteVersion: "memory-suite-v1",
      verifySignature: (payload: string, signature: string) =>
        createHmac("sha256", KEY).update(payload, "utf8").digest("hex") === signature
    };
    expect(qualifyMemoryExecution({
      authority,
      now: new Date("2026-08-10T12:00:00.000Z"),
      role: "MEMORY_FACT_EXTRACT",
      settings: { memoryUiLocale: "RU" },
      target: capable,
      versions
    })).toMatchObject({
      qualificationId: "qualification-v1",
      requiresStrictStructuredOutput: true
    });

    expect(() => qualifyMemoryExecution({
      authority,
      now: new Date("2026-08-10T12:00:00.000Z"),
      role: "MEMORY_FACT_EXTRACT",
      settings: { memoryUiLocale: "RU" },
      target: target(false),
      versions
    })).toThrow(new MemoryExecutionError("memory_execution_capability_unavailable"));
  });

  it("selects the preregistered evidence identity for a Phase-specific role", () => {
    const capable = target(true);
    const profileRequirement: MemoryQualificationRequirement = {
      ...requirementFor(capable),
      corpusHash: "9".repeat(64),
      corpusVersion: "memory-corpus-v2",
      role: "MEMORY_PROFILE",
      scorerVersion: "memory-scorers-v2",
      suiteVersion: "memory-phase7-quality-v1"
    };
    const qualification = signed(profileRequirement);
    const authority = {
      corpusHash: "7".repeat(64),
      corpusVersion: "memory-corpus-v1",
      identitiesByRole: {
        MEMORY_PROFILE: {
          corpusHash: "9".repeat(64),
          corpusVersion: "memory-corpus-v2",
          scorerVersion: "memory-scorers-v2",
          suiteVersion: "memory-phase7-quality-v1"
        }
      },
      registry: [qualification],
      scorerVersion: "memory-scorer-v1",
      suiteVersion: "memory-suite-v1",
      verifySignature: (payload: string, signature: string) =>
        createHmac("sha256", KEY).update(payload, "utf8").digest("hex") === signature
    } as const;
    expect(qualifyMemoryExecution({
      authority,
      now: new Date("2026-08-10T12:00:00.000Z"),
      role: "MEMORY_PROFILE",
      settings: { memoryUiLocale: "RU" },
      target: capable,
      versions
    }).requirement).toMatchObject({
      corpusHash: "9".repeat(64),
      role: "MEMORY_PROFILE",
      suiteVersion: "memory-phase7-quality-v1"
    });
    expect(() => qualifyMemoryExecution({
      authority: { ...authority, identitiesByRole: undefined },
      now: new Date("2026-08-10T12:00:00.000Z"),
      role: "MEMORY_PROFILE",
      settings: { memoryUiLocale: "RU" },
      target: capable,
      versions
    })).toThrow(new MemoryExecutionError("memory_execution_qualification_required"));
  });
});
