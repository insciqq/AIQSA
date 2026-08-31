import { describe, expect, it } from "vitest";
import {
  LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX,
  longMemEvalPreparedCaseAdvisoryKey,
  longMemEvalPreparedCaseBuildingEmail,
  longMemEvalPreparedCaseDisplayName,
  longMemEvalPreparedCaseFingerprint,
  longMemEvalPreparedCaseReadyFingerprint,
  longMemEvalPreparedCaseReadyEmail
} from "./preparedCaseCache";

describe("LongMemEval prepared-case cache identity", () => {
  it("hashes object keys canonically while preserving array order", () => {
    const left = longMemEvalPreparedCaseFingerprint({
      case: { messages: ["one", "two"], questionId: "q1" },
      version: 1
    });
    const right = longMemEvalPreparedCaseFingerprint({
      version: 1,
      case: { questionId: "q1", messages: ["one", "two"] }
    });
    const reordered = longMemEvalPreparedCaseFingerprint({
      case: { messages: ["two", "one"], questionId: "q1" },
      version: 1
    });

    expect(left).toBe(right);
    expect(left).not.toBe(reordered);
    expect(left).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("derives bounded private identities from a full fingerprint", () => {
    const fingerprint = "0123456789abcdef".repeat(4);
    const ready = longMemEvalPreparedCaseReadyEmail(fingerprint);
    const building = longMemEvalPreparedCaseBuildingEmail(
      fingerprint,
      "00000000-0000-4000-8000-000000000001"
    );

    expect(ready).toHaveLength(63 + LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX.length);
    expect(ready.endsWith(LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX)).toBe(true);
    expect(building.endsWith(LONGMEMEVAL_PREPARED_CASE_EMAIL_SUFFIX)).toBe(true);
    expect(longMemEvalPreparedCaseDisplayName("case_1", fingerprint))
      .toContain(fingerprint);
    expect(longMemEvalPreparedCaseAdvisoryKey(fingerprint))
      .toEqual([0x01234567, -1985229329]);
  });

  it("rejects malformed cache identities", () => {
    expect(() => longMemEvalPreparedCaseReadyEmail("not-a-hash"))
      .toThrow("longmemeval_prepared_case_fingerprint_invalid");
    expect(() => longMemEvalPreparedCaseDisplayName("bad id", "0".repeat(64)))
      .toThrow("longmemeval_prepared_case_question_id_invalid");
  });

  it("recognizes only settled prepared identities for compatibility promotion", () => {
    const fingerprint = "abcdef0123456789".repeat(4);
    const displayName = longMemEvalPreparedCaseDisplayName("case_1", fingerprint);
    const email = longMemEvalPreparedCaseReadyEmail(fingerprint);

    expect(longMemEvalPreparedCaseReadyFingerprint({
      displayName,
      email,
      questionId: "case_1"
    })).toBe(fingerprint);
    expect(longMemEvalPreparedCaseReadyFingerprint({
      displayName,
      email: longMemEvalPreparedCaseBuildingEmail(
        fingerprint,
        "00000000-0000-4000-8000-000000000001"
      ),
      questionId: "case_1"
    })).toBeNull();
    expect(longMemEvalPreparedCaseReadyFingerprint({
      displayName,
      email,
      questionId: "different_case"
    })).toBeNull();
  });
});
