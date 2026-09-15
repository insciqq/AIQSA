import { describe, expect, it } from "vitest";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import { memorySha256 } from "../persistence/lexical";
import { independentForgetEvidence } from "./sourcePreservation";

const first = "My lamp is amber.";
const second = "My bicycle is silver.";
const text = `${first} ${second}`;

function evidence(start: number, end: number) {
  return {
    branchGeneration: 0, chatId: "chat", messageId: "message",
    content: { blocks: [{ type: "text", text }] },
    evidenceFingerprint: "a".repeat(64), factVersionId: "version", id: "evidence",
    safeExcerpt: text.slice(start, end), safeSourceHash: memorySha256(text),
    sourceEndOffset: end, sourceMessageContentHash: memorySha256(text),
    sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION, sourceStartOffset: start
  };
}

describe("selective source forget", () => {
  const forgotten = evidence(0, first.length);
  const peer = evidence(first.length + 1, text.length);

  it("retains the separate exact evidence without authorizing the full message", () => {
    expect(independentForgetEvidence(peer, [forgotten])).toBe(true);
    expect(independentForgetEvidence(evidence(0, text.length), [forgotten])).toBe(false);
    expect(independentForgetEvidence(forgotten, [forgotten])).toBe(false);
  });

  it("rejects missing, changed, and overlapping support before broadening deletion", () => {
    expect(independentForgetEvidence(peer, [])).toBe(false);
    expect(independentForgetEvidence(peer, [{ ...forgotten, sourceEndOffset: null }])).toBe(false);
    expect(independentForgetEvidence({ ...peer, safeExcerpt: first }, [forgotten])).toBe(false);
    expect(independentForgetEvidence(peer, [forgotten, peer])).toBe(false);
    expect(independentForgetEvidence({ ...peer, sourceMessageContentHash: "b".repeat(64) }, [forgotten])).toBe(false);
    expect(independentForgetEvidence(peer, [{ ...forgotten, messageId: "another-source" }])).toBe(false);
  });
});
