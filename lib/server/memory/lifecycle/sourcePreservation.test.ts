import { describe, expect, it } from "vitest";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../learning/extraction/contract";
import type { MemoryEvidenceSourceProjections } from "../persistence/eligibility";
import { memorySha256 } from "../persistence/lexical";
import {
  independentForgetEvidence,
  memoryForgetPeerCascadeCount,
  rememberMemoryForgetPeerCascade
} from "./sourcePreservation";

const first = "My lamp is amber.";
const second = "My bicycle is silver.";
const text = `${first} ${second}`;
const direct = { retrievalOnly: false };
const echo = { retrievalOnly: true };

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
  const peer = evidence(first.length + 1, text.length);

  it("keeps a peer of a direct source even when spans overlap or support is inexact", () => {
    expect(independentForgetEvidence(peer, direct)).toBe(true);
    expect(independentForgetEvidence(evidence(0, text.length), direct)).toBe(true);
    expect(independentForgetEvidence({ ...peer, safeExcerpt: first }, direct)).toBe(true);
    expect(independentForgetEvidence({ ...peer, sourceMessageContentHash: "b".repeat(64) }, direct)).toBe(true);
    expect(independentForgetEvidence({ ...peer, sourceProjectionVersion: "historical-projection" }, direct)).toBe(true);
    expect(independentForgetEvidence({ ...peer, evidenceFingerprint: null, sourceEndOffset: null,
      sourceMessageContentHash: null, sourceStartOffset: null }, {})).toBe(true);
  });

  it("keeps only exact current testimony beside a retrieval-only echo", () => {
    expect(independentForgetEvidence(peer, echo)).toBe(true);
    expect(independentForgetEvidence({ ...peer, safeExcerpt: first }, echo)).toBe(false);
    expect(independentForgetEvidence({ ...peer, sourceMessageContentHash: "b".repeat(64) }, echo)).toBe(false);
    expect(independentForgetEvidence({ ...peer, sourceProjectionVersion: "historical-projection" }, echo)).toBe(false);
    expect(independentForgetEvidence({ ...peer, sourceEndOffset: null }, echo)).toBe(false);
  });

  it("projects each retrieval-only message once per Forget", () => {
    const projections: MemoryEvidenceSourceProjections = new Map();
    expect(independentForgetEvidence(peer, echo, projections)).toBe(true);
    expect(projections.size).toBe(1);
    projections.set("message", { hash: "c".repeat(64), safeText: text });
    expect(independentForgetEvidence(peer, echo, projections)).toBe(false);
  });

  it("carries only a positive cascade count beside the committed result", () => {
    const result = {};
    rememberMemoryForgetPeerCascade(result, 0);
    expect(memoryForgetPeerCascadeCount(result)).toBe(0);
    rememberMemoryForgetPeerCascade(result, 2);
    expect(memoryForgetPeerCascadeCount(result)).toBe(2);
    expect(memoryForgetPeerCascadeCount(null)).toBe(0);
    expect(JSON.stringify(result)).toBe("{}");
  });
});
