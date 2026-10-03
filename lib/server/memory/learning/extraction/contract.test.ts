import { describe, expect, it } from "vitest";
import type { MemoryJobDescriptor } from "../../coordinator/types";
import { memorySha256 } from "../../persistence/lexical";
import {
  MEMORY_FACT_EXTRACTION_HEAL_JOB_PREFIX,
  MEMORY_FACT_EXTRACTION_JOB_PREFIX,
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS,
  MEMORY_FACT_EXTRACTION_VERSIONS,
  MEMORY_FACT_MAX_SOURCE_PAGES,
  MEMORY_FACT_MAX_TARGET_CHARACTERS,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  memoryFactExtractionClaimIsValid,
  memoryFactExtractionHealJobFingerprint,
  memoryFactExtractionHealJobPrefix,
  memoryFactExtractionJobFingerprint,
  memoryFactExtractionJobIdentity,
  memoryFactNextPage,
  memoryFactTargetView,
  type MemoryFactExtractionInput,
  type MemoryFactJobPage,
  type MemoryFactSourceIdentity
} from "./contract";

const source: MemoryFactSourceIdentity = {
  activeLeafMessageId: "assistant-1",
  branchGeneration: 1,
  chatId: "chat-1",
  memoryGenerationSnapshot: 2,
  sourceHash: "a".repeat(64),
  sourceMessageId: "message-1",
  sourceRevision: 3,
  userId: "user-1"
};

function job(idempotencyFingerprint: string): MemoryJobDescriptor {
  return {
    ...source,
    attemptCount: 1,
    id: "job-1",
    idempotencyFingerprint,
    kind: "EXTRACT_FACTS",
    memoryRevisionSnapshot: 1,
    pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
    stage: null,
    targetFactVersionId: null
  };
}

function inputFor(text: string, page?: MemoryFactJobPage, unprocessed = false) {
  const view = page ? memoryFactTargetView(text, page, unprocessed) : null;
  const pageText = view?.kind === "PAGE" ? view.text : text;
  const input: MemoryFactExtractionInput = {
    contextRefs: [],
    folderId: null,
    identityProfile: "UNICODE_V2",
    inputHash: "b".repeat(64),
    messages: [{
      contentHash: memorySha256(text),
      createdAt: "2026-09-27T10:00:00.000Z",
      evidenceEligible: true,
      id: source.sourceMessageId,
      languageCode: "en",
      redactionSpans: [],
      role: "user",
      text: pageText,
      updatedAt: "2026-09-27T10:00:00.000Z"
    }],
    source,
    sourceProjectionHash: "c".repeat(64),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    suppressionIdentitySnapshot: "d".repeat(64),
    ...(view?.kind === "PAGE" ? { targetPage: view.page } : {}),
    timeZone: "UTC"
  };
  return input;
}

describe("Memory fact extraction pages", () => {
  it("keeps pipeline v8 job identity and retains exactly the previous v51 contract", () => {
    expect(MEMORY_FACT_EXTRACTION_VERSIONS).toMatchObject({
      pipelineVersion: "memory-fact-extraction-vnext-v8",
      policyVersion: "memory-fact-extraction-policy-v38",
      promptVersion: "memory-fact-extraction-prompt-v52",
      schemaVersion: "memory-fact-extraction-schema-v7"
    });
    expect(MEMORY_FACT_EXTRACTION_RETAINED_VERSIONS).toEqual({
      ...MEMORY_FACT_EXTRACTION_VERSIONS,
      promptVersion: "memory-fact-extraction-prompt-v51"
    });
  });

  it("keeps page 0 on the established job identity and proves later pages", () => {
    const first = memoryFactExtractionJobFingerprint(source, "UNICODE_V2");
    expect(first).toBe(`${MEMORY_FACT_EXTRACTION_JOB_PREFIX}${memorySha256({
      chatId: source.chatId,
      memoryGenerationSnapshot: source.memoryGenerationSnapshot,
      identityProfile: "UNICODE_V2",
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      sourceMessageId: source.sourceMessageId,
      userId: source.userId
    })}`);
    expect(memoryFactExtractionJobIdentity(job(first))).toEqual({
      identityProfile: "UNICODE_V2",
      page: { cursor: 0, ordinal: 0 }
    });

    const page = { cursor: 20_000, ordinal: 1 };
    const later = memoryFactExtractionJobFingerprint(source, "UNICODE_V2", page);
    expect(later).toMatch(/^extract-facts:vnext:p1\.20000:[a-f0-9]{64}$/u);
    expect(later.length).toBeLessThanOrEqual(128);
    expect(memoryFactExtractionJobIdentity(job(later))).toEqual({
      identityProfile: "UNICODE_V2",
      page
    });
    expect(memoryFactExtractionClaimIsValid(job(later))).toBe(true);
    // A forged cursor or ordinal does not match the hashed page identity.
    expect(memoryFactExtractionJobIdentity(job(later.replace("p1.20000", "p1.20001"))))
      .toBeNull();
    expect(memoryFactExtractionJobIdentity(job(later.replace("p1.", "p2.")))).toBeNull();
    expect(() => memoryFactExtractionJobFingerprint(source, "UNICODE_V2", {
      cursor: 0,
      ordinal: 1
    })).toThrow("memory_fact_source_invalid");
    expect(() => memoryFactExtractionJobFingerprint(source, "UNICODE_V2", {
      cursor: 10,
      ordinal: MEMORY_FACT_MAX_SOURCE_PAGES + 1
    })).toThrow("memory_fact_source_invalid");
  });

  it("proves only the two first-page re-extraction keys of one Memory-role policy version", () => {
    const key = (samePolicy: boolean, utilityPolicyVersion = 22) => ({ samePolicy, utilityPolicyVersion });
    const newer = memoryFactExtractionHealJobFingerprint(source, "UNICODE_V2", key(false));
    const same = memoryFactExtractionHealJobFingerprint(source, "UNICODE_V2", key(true));
    expect(newer).toMatch(/^extract-facts:vnext:heal\.u22:[a-f0-9]{64}$/u);
    expect(same).toMatch(/^extract-facts:vnext:heal\.u22\.same-policy:[a-f0-9]{64}$/u);
    expect(memoryFactExtractionHealJobFingerprint(source, "UNICODE_V2", key(true, 2_147_483_647)).length)
      .toBeLessThanOrEqual(128);
    // A new job of the same source: neither the ordinary first page nor the
    // other key, nor the same key of another policy version.
    expect(new Set([newer, same, memoryFactExtractionJobFingerprint(source, "UNICODE_V2"),
      memoryFactExtractionHealJobFingerprint(source, "UNICODE_V2", key(false, 23))]).size).toBe(4);
    for (const fingerprint of [newer, same]) {
      expect(fingerprint.startsWith(MEMORY_FACT_EXTRACTION_HEAL_JOB_PREFIX)).toBe(true);
      expect(memoryFactExtractionJobIdentity(job(fingerprint))).toEqual({
        identityProfile: "UNICODE_V2",
        page: { cursor: 0, ordinal: 0 }
      });
      expect(memoryFactExtractionClaimIsValid(job(fingerprint))).toBe(true);
      expect(memoryFactExtractionClaimIsValid({ ...job(fingerprint), sourceMessageId: "message-2" }))
        .toBe(false);
    }
    expect(newer.startsWith(memoryFactExtractionHealJobPrefix(key(false)))).toBe(true);
    expect(same.startsWith(memoryFactExtractionHealJobPrefix(key(false)))).toBe(false);
    expect(same.startsWith(memoryFactExtractionHealJobPrefix(key(true)))).toBe(true);
    for (const forged of [
      newer.replace("heal.u22:", "heal.u23:"),
      newer.replace("heal.u22:", "heal.u022:"),
      same.replace(".same-policy:", ":"),
      same.replace(".same-policy:", ".same:"),
      newer.replace("heal.u22:", "heal.u22.p1.20000:")
    ]) {
      expect(memoryFactExtractionJobIdentity(job(forged)), forged).toBeNull();
    }
    expect(() => memoryFactExtractionHealJobFingerprint(source, "UNICODE_V2", key(false, 0)))
      .toThrow("memory_fact_source_invalid");
  });

  it("keeps a target that fits one input whole and pages a longer one", () => {
    const fits = "x".repeat(MEMORY_FACT_MAX_TARGET_CHARACTERS);
    expect(memoryFactTargetView(fits, { cursor: 0, ordinal: 0 }, false))
      .toEqual({ kind: "WHOLE" });

    const long = "y".repeat(50_000);
    const first = memoryFactTargetView(long, { cursor: 0, ordinal: 0 }, false);
    expect(first).toMatchObject({
      kind: "PAGE",
      page: { coreEnd: 20_000, coreStart: 0, precedingText: "", sourceLength: 50_000 }
    });
    expect(first.kind === "PAGE" && first.text.length).toBe(22_000);

    const middle = memoryFactTargetView(long, { cursor: 20_000, ordinal: 1 }, false);
    expect(middle).toMatchObject({
      kind: "PAGE",
      page: { coreEnd: 40_000, coreStart: 20_000 }
    });
    expect(middle.kind === "PAGE" && middle.page.precedingText.length).toBe(2_000);

    const last = memoryFactTargetView(long, { cursor: 40_000, ordinal: 2 }, false);
    expect(last).toMatchObject({
      kind: "PAGE",
      page: { coreEnd: 50_000, coreStart: 40_000 }
    });
    expect(last.kind === "PAGE" && last.text).toBe(long.slice(40_000));

    expect(memoryFactTargetView(long, { cursor: 50_000, ordinal: 3 }, true))
      .toEqual({ kind: "COVERED" });
    expect(memoryFactTargetView(long, { cursor: 50_001, ordinal: 3 }, false))
      .toEqual({ kind: "INVALID" });
  });

  it("never splits a surrogate pair at a page boundary", () => {
    const emoji = "\u{1F600}";
    const text = `${"a".repeat(21_999)}${emoji}${"b".repeat(1_997)}${emoji}${"c".repeat(20_000)}`;
    const view = memoryFactTargetView(text, { cursor: 0, ordinal: 0 }, false);
    if (view.kind !== "PAGE") throw new Error("page_expected");
    expect(view.text).toBe("a".repeat(21_999));
    // The core ends after, never inside, the pair that would straddle it.
    expect(text.slice(0, view.page.coreEnd).endsWith("a")).toBe(true);
    expect(view.page.coreEnd).toBe(19_999);
    const next = memoryFactTargetView(text, { cursor: 22_000, ordinal: 1 }, false);
    expect(next).toEqual({ kind: "INVALID" });
    const afterPair = memoryFactTargetView(text, { cursor: 22_001, ordinal: 1 }, false);
    if (afterPair.kind !== "PAGE") throw new Error("page_expected");
    expect(afterPair.page.precedingText.startsWith("a")).toBe(true);
    expect(afterPair.page.precedingText.endsWith(emoji)).toBe(true);
  });

  it("continues coverage to the end and records only real gaps", () => {
    const short = "I prefer tea.";
    expect(memoryFactNextPage(inputFor(short))).toBeNull();
    expect(memoryFactNextPage(inputFor(short), 5)).toEqual({ cursor: 5, ordinal: 1 });

    const long = "z".repeat(45_000);
    expect(memoryFactNextPage(inputFor(long, { cursor: 0, ordinal: 0 })))
      .toEqual({ cursor: 20_000, ordinal: 1 });
    expect(memoryFactNextPage(inputFor(long, { cursor: 20_000, ordinal: 1 })))
      .toEqual({ cursor: 40_000, ordinal: 2 });
    expect(memoryFactNextPage(inputFor(long, { cursor: 40_000, ordinal: 2 })))
      .toBeNull();
    // An unscanned remainder is reported by one never-dispatched page.
    expect(memoryFactNextPage(inputFor(long, { cursor: 40_000, ordinal: 2 }, true)))
      .toEqual({ cursor: 45_000, ordinal: 3 });
    // The page budget ends in a never-dispatched page that records the gap.
    expect(memoryFactNextPage(inputFor(long, {
      cursor: 20_000,
      ordinal: MEMORY_FACT_MAX_SOURCE_PAGES - 1
    }))).toEqual({ cursor: 40_000, ordinal: MEMORY_FACT_MAX_SOURCE_PAGES });
  });
});
