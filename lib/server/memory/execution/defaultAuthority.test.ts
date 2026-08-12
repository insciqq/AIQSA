import { verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MEMORY_CAPABILITY_QUALIFICATION_PUBLIC_KEY,
  MEMORY_CAPABILITY_QUALIFICATION_REGISTRY,
  canonicalMemoryQualificationPayload,
  decideMemoryCapabilityQualification
} from "../../../evaluation/memory/qualification";
import {
  MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION,
  MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH,
  MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION,
  MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION
} from "../../../evaluation/memory/automaticLearning";
import { MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES } from "../learning/betaQualification";
import { defaultMemoryExecutionAuthority } from "./defaultAuthority";

const LANGUAGES = ["EN", "RU"] as const;
const APPROVED_AT = "2026-08-11T18:54:05.000Z";
const EXPIRES_AT = "2027-08-11T18:54:05.000Z";

describe("code-owned Memory execution authority", () => {
  it("contains one valid signed qualification for every beta role and language", () => {
    expect(defaultMemoryExecutionAuthority.qualification).toMatchObject({
      corpusHash: MEMORY_AUTOMATIC_LEARNING_HOLDOUT_CORPUS_HASH,
      corpusVersion: MEMORY_AUTOMATIC_LEARNING_CORPUS_VERSION,
      scorerVersion: MEMORY_AUTOMATIC_LEARNING_SCORER_VERSION,
      suiteVersion: MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION
    });
    const expectedCapabilities = MEMORY_AUTOMATIC_LEARNING_QUALIFIED_ROLES
      .flatMap((role) => LANGUAGES.map((language) => `${role}:${language}`))
      .sort();
    const actualCapabilities = MEMORY_CAPABILITY_QUALIFICATION_REGISTRY
      .map(({ key }) => `${key.role}:${key.language}`)
      .sort();

    expect(MEMORY_CAPABILITY_QUALIFICATION_PUBLIC_KEY).not.toBe("");
    expect(MEMORY_CAPABILITY_QUALIFICATION_REGISTRY).toHaveLength(12);
    expect(actualCapabilities).toEqual(expectedCapabilities);

    const publicKey = {
      format: "der" as const,
      key: Buffer.from(MEMORY_CAPABILITY_QUALIFICATION_PUBLIC_KEY, "base64"),
      type: "spki" as const
    };
    for (const qualification of MEMORY_CAPABILITY_QUALIFICATION_REGISTRY) {
      expect(qualification.approval).toMatchObject({
        approvalId: "memory-beta-rollout-20260811-v5",
        approved: true,
        approvedAt: APPROVED_AT,
        approvedBy: "operator",
        expiresAt: EXPIRES_AT
      });
      expect(qualification.evidenceDigest).toBe(
        "a44bbcdb98197ec584ae413d9df71cc80dd60b460b76e8e83b4da213828e670f"
      );
      expect(qualification.key).toMatchObject({
        corpusHash: "85e8eab6184c0c5e7140cc27b907936d1687586e66a02144bbf09ec48ad0c4e3",
        corpusVersion: "memory-corpus-v2",
        scorerVersion: "memory-scorers-v2",
        suiteVersion: MEMORY_AUTOMATIC_LEARNING_SUITE_VERSION
      });
      expect(verify(
        null,
        Buffer.from(canonicalMemoryQualificationPayload(qualification), "utf8"),
        publicKey,
        Buffer.from(qualification.approval.signature, "base64url")
      ), qualification.qualificationId).toBe(true);
      expect(decideMemoryCapabilityQualification({
        now: "2026-08-11T18:54:06.000Z",
        registry: MEMORY_CAPABILITY_QUALIFICATION_REGISTRY,
        requirement: qualification.key,
        verifySignature: defaultMemoryExecutionAuthority.qualification.verifySignature
      }), qualification.qualificationId).toEqual({
        code: "QUALIFIED",
        qualificationId: qualification.qualificationId,
        qualified: true
      });
    }
  });
});
