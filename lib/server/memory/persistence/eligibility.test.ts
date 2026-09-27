import type { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import {
  projectMemoryHistorySafeText,
  projectMemoryHistorySourceText
} from "../history/safety";
import { memoryExactMessageEvidenceIsCurrent } from "./eligibility";
import { memorySha256 } from "./lexical";

function evidence(text: string, safeText: string, excerpt: string) {
  const start = safeText.indexOf(excerpt);
  const hash = memorySha256(safeText);
  return {
    content: { blocks: [{ text, type: "text" }] } as Prisma.JsonValue,
    evidenceFingerprint: "f".repeat(64),
    safeExcerpt: excerpt,
    safeSourceHash: hash,
    sourceEndOffset: start + excerpt.length,
    sourceMessageContentHash: hash,
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
    sourceStartOffset: start
  };
}

describe("exact Message evidence revalidation", () => {
  it("keeps evidence recorded by the former single pass current", () => {
    const text = "My sister lives in Porto; token sk-abcdefghijklmnopqrstuvwxyz123456.";
    const recorded = projectMemoryHistorySafeText(text);
    expect(recorded.eligible).toBe(true);

    expect(memoryExactMessageEvidenceIsCurrent(evidence(
      text,
      recorded.safeText!,
      "My sister lives in Porto"
    ))).toBe(true);
  });

  it("revalidates evidence in a message above 100k with the same windowed projection", () => {
    const text = `${"Garden notes, tomatoes and basil. ".repeat(4_000)}` +
      "token sk-abcdefghijklmnopqrstuvwxyz123456; I moved to Rome in May.";
    expect(text.length).toBeGreaterThan(100_000);
    const projected = projectMemoryHistorySourceText(text);
    expect(projected.eligible).toBe(true);
    const current = evidence(text, projected.safeText!, "I moved to Rome in May.");

    expect(memoryExactMessageEvidenceIsCurrent(current)).toBe(true);
    expect(memoryExactMessageEvidenceIsCurrent({
      ...current,
      content: { blocks: [{ text: `${text} Edited.`, type: "text" }] }
    })).toBe(false);
    expect(memoryExactMessageEvidenceIsCurrent({
      ...current,
      sourceProjectionVersion: "memory-fact-source-projection-v4"
    })).toBe(false);
  });
});
