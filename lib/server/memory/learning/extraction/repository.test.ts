import { describe, expect, it } from "vitest";
import type { MemoryExtractedCandidate } from "./contract";
import {
  currentDirectUserMessageId,
  memoryAutomaticCandidateContainsSecret
} from "./repository";

describe("automatic-learning source admission", () => {
  it("selects only the direct parent of a settled assistant leaf", () => {
    expect(currentDirectUserMessageId([
      { id: "old-user", parentMessageId: null, role: "user", status: "complete" },
      { id: "current-user", parentMessageId: "old-user", role: "user", status: "complete" },
      { id: "assistant", parentMessageId: "current-user", role: "assistant", status: "complete" }
    ], "assistant")).toBe("current-user");
    expect(currentDirectUserMessageId([
      { id: "user", parentMessageId: null, role: "user", status: "complete" }
    ], "user")).toBeNull();
  });

  it("does not treat assistant/tool leaves or missing parents as user evidence", () => {
    expect(currentDirectUserMessageId([
      { id: "tool", parentMessageId: "user", role: "tool", status: "complete" },
      { id: "user", parentMessageId: null, role: "user", status: "complete" }
    ], "tool")).toBeNull();
    expect(currentDirectUserMessageId([
      { id: "assistant", parentMessageId: "missing", role: "assistant", status: "complete" }
    ], "assistant")).toBeNull();
  });

  it("rechecks generated candidate text immediately before persistence", () => {
    const candidate = {
      displayText: "The user prefers concise replies.",
      evidence: [{
        endOffset: 48,
        messageId: "user",
        quote: "My recovery code is ABCD-EFGH-IJKL-MNOP.",
        sourceTextHash: "a".repeat(64),
        startOffset: 0
      }]
    } as unknown as MemoryExtractedCandidate;

    expect(memoryAutomaticCandidateContainsSecret(candidate)).toBe(true);
    expect(memoryAutomaticCandidateContainsSecret({
      ...candidate,
      evidence: [{ ...candidate.evidence[0]!, quote: "I prefer concise replies." }]
    })).toBe(false);
  });

  it("recursively rejects a secret present only in model-derived structured values", () => {
    const candidate = {
      displayText: "The user prefers concise replies.",
      evidence: [{
        endOffset: 25,
        messageId: "user",
        quote: "I prefer concise replies.",
        sourceTextHash: "a".repeat(64),
        startOffset: 0
      }],
      proposedValue: {
        nested: [{ responsePreference: "sk-abcdefghijklmnopqrstuvwxyz123456" }],
        statement: "The user prefers concise replies."
      },
      quote: "I prefer concise replies.",
      rawTemporalExpression: null,
      responsePreference: "concise replies",
      statement: "The user prefers concise replies.",
      temporalResolutionEvidence: null
    } as unknown as MemoryExtractedCandidate;

    expect(memoryAutomaticCandidateContainsSecret(candidate)).toBe(true);
  });
});
