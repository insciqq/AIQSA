import { describe, expect, it } from "vitest";
import {
  canonicalMemoryQualificationPayload,
  decideAllMemoryCapabilityQualifications,
  decideMemoryCapabilityQualification,
  type MemoryCapabilityQualification,
  type MemoryQualificationKey
} from "./qualification";

const now = "2026-08-09T12:00:00.000Z";

function key(): MemoryQualificationKey {
  return {
    configFingerprint: "config-v1",
    corpusHash: "a".repeat(64),
    corpusVersion: "corpus-v1",
    deploymentFingerprint: "deployment-v1",
    language: "RU",
    modelFingerprint: "model-v1",
    pipelineVersion: "pipeline-v1",
    policyVersion: "policy-v1",
    promptVersion: "prompt-v1",
    providerFingerprint: "provider-v1",
    retrievalConfigFingerprint: "retrieval-v1",
    role: "MEMORY_FACT_EXTRACT",
    schemaVersion: "schema-v1",
    scorerVersion: "scorer-v1",
    suiteVersion: "suite-v1",
    vectorSpaceFingerprint: "vector-v1"
  };
}

function qualification(overrides: Partial<MemoryCapabilityQualification> = {}): MemoryCapabilityQualification {
  return {
    approval: {
      approved: true,
      approvedAt: "2026-08-01T00:00:00.000Z",
      approvedBy: "operator-1",
      approvalId: "approval-1",
      expiresAt: "2027-08-01T00:00:00.000Z",
      signature: "valid-signature"
    },
    evidenceDigest: "b".repeat(64),
    key: key(),
    qualificationId: "qualification-1",
    ...overrides
  };
}

const verifySignature = (_payload: string, signature: string) => signature === "valid-signature";

describe("Memory capability qualification registry", () => {
  it("qualifies only an exact approved, unexpired, signature-verified key", () => {
    const entry = qualification();
    expect(canonicalMemoryQualificationPayload(entry)).not.toContain("valid-signature");
    expect(decideMemoryCapabilityQualification({
      now,
      registry: [entry],
      requirement: key(),
      verifySignature
    })).toEqual({
      code: "QUALIFIED",
      qualificationId: "qualification-1",
      qualified: true
    });
  });

  it("accepts the complete base64url alphabet at the start of a signature", () => {
    const entry = qualification({
      approval: { ...qualification().approval, signature: "-valid_signature" }
    });
    expect(decideMemoryCapabilityQualification({
      now,
      registry: [entry],
      requirement: key(),
      verifySignature: (_payload, signature) => signature === "-valid_signature"
    })).toMatchObject({ code: "QUALIFIED", qualified: true });
  });

  it("stales every material model, policy, schema, corpus, scorer, and vector change", () => {
    const changedRequirements: MemoryQualificationKey[] = [
      { ...key(), modelFingerprint: "model-v2" },
      { ...key(), providerFingerprint: "provider-v2" },
      { ...key(), deploymentFingerprint: "deployment-v2" },
      { ...key(), configFingerprint: "config-v2" },
      { ...key(), vectorSpaceFingerprint: "vector-v2" },
      { ...key(), policyVersion: "policy-v2" },
      { ...key(), promptVersion: "prompt-v2" },
      { ...key(), schemaVersion: "schema-v2" },
      { ...key(), pipelineVersion: "pipeline-v2" },
      { ...key(), corpusHash: "c".repeat(64) },
      { ...key(), corpusVersion: "corpus-v2" },
      { ...key(), scorerVersion: "scorer-v2" },
      { ...key(), suiteVersion: "suite-v2" },
      { ...key(), retrievalConfigFingerprint: "retrieval-v2" }
    ];
    for (const requirement of changedRequirements) {
      expect(decideMemoryCapabilityQualification({
        now,
        registry: [qualification()],
        requirement,
        verifySignature
      })).toMatchObject({ code: "STALE", qualified: false });
    }
  });

  it("fails closed for missing, expired, future, unapproved, and invalid signatures", () => {
    expect(decideMemoryCapabilityQualification({
      now,
      registry: [],
      requirement: key(),
      verifySignature
    })).toMatchObject({ code: "MISSING", qualified: false });

    const expired = qualification({
      approval: { ...qualification().approval, expiresAt: "2026-08-09T12:00:00.000Z" }
    });
    expect(decideMemoryCapabilityQualification({
      now,
      registry: [expired],
      requirement: key(),
      verifySignature
    })).toMatchObject({ code: "EXPIRED", qualified: false });

    const future = qualification({
      approval: { ...qualification().approval, approvedAt: "2026-09-01T00:00:00.000Z" }
    });
    expect(decideMemoryCapabilityQualification({
      now,
      registry: [future],
      requirement: key(),
      verifySignature
    })).toMatchObject({ code: "NOT_YET_VALID", qualified: false });

    const unapproved = qualification({
      approval: { ...qualification().approval, approved: false }
    });
    expect(decideMemoryCapabilityQualification({
      now,
      registry: [unapproved],
      requirement: key(),
      verifySignature
    })).toMatchObject({ code: "UNAPPROVED", qualified: false });

    expect(decideMemoryCapabilityQualification({
      now,
      registry: [qualification()],
      requirement: key(),
      verifySignature: () => false
    })).toMatchObject({ code: "SIGNATURE_INVALID", qualified: false });
  });

  it("requires every effective role/language requirement and rejects empty capability sets", () => {
    expect(decideAllMemoryCapabilityQualifications({
      now,
      registry: [qualification()],
      requirements: [],
      verifySignature
    })).toEqual({ decisions: [], qualified: false });

    const result = decideAllMemoryCapabilityQualifications({
      now,
      registry: [qualification()],
      requirements: [
        key(),
        { ...key(), language: "EN" }
      ],
      verifySignature
    });
    expect(result.qualified).toBe(false);
    expect(result.decisions.map(({ code }) => code)).toEqual(["QUALIFIED", "MISSING"]);
  });

  it("treats duplicate exact entries or malformed registry data as invalid authority", () => {
    const duplicate = { ...qualification(), qualificationId: "qualification-2" };
    expect(decideMemoryCapabilityQualification({
      now,
      registry: [qualification(), duplicate],
      requirement: key(),
      verifySignature
    })).toMatchObject({ code: "AMBIGUOUS", qualified: false });

    expect(decideMemoryCapabilityQualification({
      now,
      registry: [{ ...qualification(), evidenceDigest: "not-a-digest" }],
      requirement: key(),
      verifySignature
    })).toMatchObject({ code: "REGISTRY_INVALID", qualified: false });

    expect(decideMemoryCapabilityQualification({
      now,
      registry: [{ ...qualification(), unexpectedAuthority: true } as never],
      requirement: key(),
      verifySignature
    })).toMatchObject({ code: "REGISTRY_INVALID", qualified: false });
  });
});
