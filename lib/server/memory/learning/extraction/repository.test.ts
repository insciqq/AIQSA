import { describe, expect, it } from "vitest";
import type { MemoryExtractedCandidate } from "./contract";
import {
  buildMemorySafeSourceSnapshot,
  type MemoryHistorySourceMessageInput
} from "../../history/sourceProjection";
import {
  boundedMemoryFactContextMessageIds,
  currentDirectUserMessageId,
  memoryAssistantContextRunIsEligible,
  memoryAutomaticCandidateContainsSecret
} from "./repository";

const observedAt = new Date("2026-08-27T10:00:00.000Z");

function userMessage(
  id: string,
  parentMessageId: string | null,
  text: string
): MemoryHistorySourceMessageInput {
  return {
    chatId: "chat-1",
    content: { blocks: [{ text, type: "text" }] },
    createdAt: observedAt,
    id,
    parentMessageId,
    provenance: {
      assistantId: null,
      complete: true,
      influencedByMessageIds: [],
      modelRunId: null,
      origin: "DIRECT_USER",
      taintSources: []
    },
    role: "user",
    status: "complete",
    updatedAt: observedAt
  };
}

function assistantMessage(
  id: string,
  parentMessageId: string,
  text: string,
  tainted = false
): MemoryHistorySourceMessageInput {
  return {
    chatId: "chat-1",
    content: { blocks: [{ text, type: "text" }] },
    createdAt: observedAt,
    id,
    parentMessageId,
    provenance: {
      assistantId: null,
      complete: true,
      influencedByMessageIds: [parentMessageId],
      modelRunId: `run-${id}`,
      origin: "VISIBLE_ASSISTANT",
      taintSources: tainted ? ["TOOL"] : []
    },
    role: "assistant",
    status: "complete",
    updatedAt: observedAt
  };
}

function sourceSnapshot(messages: readonly MemoryHistorySourceMessageInput[]) {
  return buildMemorySafeSourceSnapshot({
    activeLeafMessageId: messages.at(-1)?.id ?? null,
    branchGeneration: 1,
    chatId: "chat-1",
    folderId: null,
    messages,
    mode: "NORMAL",
    sourceContentHash: "a".repeat(64),
    sourceRevision: 1,
    timeZone: "UTC",
    userId: "user-1"
  });
}

describe("automatic-learning source admission", () => {
  it("admits assistant context only from its unique completed parent-bound run", () => {
    const run = { status: "complete", userMessageId: "u1" };
    expect(memoryAssistantContextRunIsEligible(run, "u1", 1)).toBe(true);
    expect(memoryAssistantContextRunIsEligible(run, "another-user", 1))
      .toBe(false);
    expect(memoryAssistantContextRunIsEligible(run, "u1", 2)).toBe(false);
    expect(memoryAssistantContextRunIsEligible(
      { ...run, status: "streaming" },
      "u1",
      1
    )).toBe(false);
  });

  it("selects only the two nearest complete turn groups plus the user target", () => {
    const messages = [
      userMessage("u1", null, "first user turn"),
      assistantMessage("a1", "u1", "first assistant turn"),
      userMessage("u2", "a1", "second user turn"),
      assistantMessage("a2", "u2", "second assistant turn"),
      userMessage("u3", "a2", "third user turn"),
      assistantMessage("a3", "u3", "third assistant turn"),
      userMessage("target", "a3", "That one is my preferred option.")
    ];

    expect(boundedMemoryFactContextMessageIds(
      sourceSnapshot(messages),
      "target"
    )).toEqual(["u2", "a2", "u3", "a3", "target"]);
  });

  it("never skips an oversized or tainted nearest group to reach older context", () => {
    const oversized = [
      userMessage("u1", null, "older user"),
      assistantMessage("a1", "u1", "older assistant"),
      userMessage("u2", "a1", "x".repeat(4_500)),
      assistantMessage("a2", "u2", "y".repeat(3_600)),
      userMessage("target", "a2", "current target")
    ];
    expect(boundedMemoryFactContextMessageIds(
      sourceSnapshot(oversized),
      "target"
    )).toEqual(["target"]);

    const tainted = [
      userMessage("u1", null, "older user"),
      assistantMessage("a1", "u1", "older assistant"),
      userMessage("u2", "a1", "nearest user"),
      assistantMessage("a2", "u2", "tainted assistant", true),
      userMessage("target", "a2", "current target")
    ];
    expect(boundedMemoryFactContextMessageIds(
      sourceSnapshot(tainted),
      "target"
    )).toEqual(["target"]);
  });

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
      entities: [],
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
      entities: [],
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
