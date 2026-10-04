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
  memoryAutomaticCandidateContainsSecret,
  memoryFactContextSourceMessages,
  memoryFactPassedOverReplyIds
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

/** A reply that ended in error or was cancelled, as the context loader sees it. */
function failedReply(
  id: string,
  parentMessageId: string,
  status: "cancelled" | "error" | "streaming" = "error"
): MemoryHistorySourceMessageInput {
  const reply = assistantMessage(id, parentMessageId, "Partial unsettled reply.");
  return {
    ...reply,
    provenance: { ...reply.provenance, complete: false, influencedByMessageIds: [] },
    status
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

  it("retains a long direct target without expanding the prior-context allowance", () => {
    const longText = "This is background material. ".repeat(600) +
      "My usual response language is French.";
    const messages = [
      userMessage("prior", null, "x".repeat(4_500)),
      assistantMessage("answer", "prior", "y".repeat(3_600)),
      userMessage("target", "answer", longText)
    ];
    const snapshot = sourceSnapshot(messages);
    expect(boundedMemoryFactContextMessageIds(snapshot, "target")).toEqual(["target"]);
    expect(snapshot.factEvidenceProjection.messages.find(({ id }) =>
      id === "target")?.safeText).toBe(longText);
  });

  it("keeps a target longer than one input with its bounded prior context", () => {
    const longText = "Background paragraph for a long report. ".repeat(2_000) +
      "My usual response language is French.";
    expect(longText.length).toBeGreaterThan(24_000);
    const messages = [
      userMessage("u1", null, "older user"),
      assistantMessage("a1", "u1", "older assistant"),
      userMessage("u2", "a1", "x".repeat(3_000)),
      assistantMessage("a2", "u2", "y".repeat(3_000)),
      userMessage("target", "a2", longText)
    ];
    const snapshot = sourceSnapshot(messages);
    // The target is read in pages; the prior-context allowance is unchanged.
    expect(boundedMemoryFactContextMessageIds(snapshot, "target"))
      .toEqual(["u1", "a1", "u2", "a2", "target"]);
    expect(boundedMemoryFactContextMessageIds(sourceSnapshot([
      userMessage("u2", null, "x".repeat(4_500)),
      assistantMessage("a2", "u2", "y".repeat(3_600)),
      userMessage("target", "a2", longText)
    ]), "target")).toEqual(["target"]);
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

  it("presents a scheduled task's prompt as a system turn, so context stops before it and its answers", () => {
    const row = (id: string, parentMessageId: string | null, role: string, text: string) => ({
      chatId: "chat-1", content: { blocks: [{ text, type: "text" }] }, createdAt: observedAt, id, parentMessageId, role,
      status: "complete", updatedAt: observedAt
    });
    const rows = [
      row("u1", null, "user", "older owner turn"),
      row("a1", "u1", "assistant", "older answer"),
      row("prompt", "a1", "user", "I live in Lisbon. Summarize the news."),
      row("regenerated", "prompt", "assistant", "Here is today's brief."),
      row("target", "regenerated", "user", "That is right, thanks.")
    ];
    // The prompt's answer comes from a regeneration, whose run has no scheduled origin.
    const runs = [
      { assistantId: null, assistantMessageId: "a1", id: "run-a1", status: "complete", userMessageId: "u1" },
      { assistantId: null, assistantMessageId: "regenerated", id: "run-regenerated", status: "complete", userMessageId: "prompt" }
    ];
    const snapshotFor = (scheduledPromptIds: ReadonlySet<string>) => sourceSnapshot(memoryFactContextSourceMessages(
      rows, rows.map(({ id }) => id), runs, new Set(), scheduledPromptIds));

    expect(boundedMemoryFactContextMessageIds(snapshotFor(new Set()), "target"))
      .toEqual(["u1", "a1", "prompt", "regenerated", "target"]);
    const scheduled = snapshotFor(new Set(["prompt"]));
    expect(boundedMemoryFactContextMessageIds(scheduled, "target")).toEqual(["target"]);
    // Neither the prompt nor its answer is testimony or recall material.
    expect(scheduled.provenanceGraph.flatMap(({ eligibleForFactEvidence, eligibleForRecall, messageId }) =>
      eligibleForFactEvidence || eligibleForRecall ? [messageId] : [])).toEqual(["u1", "a1", "target"]);
  });

  it.each(["error", "cancelled"] as const)(
    "passes over a %s reply to keep the earlier turns",
    (status) => {
      const messages = [
        userMessage("u1", null, "Which laptop suits travel?"),
        assistantMessage("a1", "u1", "Both laptops suit travel."),
        userMessage("u2", "a1", "Compare their batteries."),
        failedReply("failed", "u2", status),
        userMessage("target", "failed", "I bought the lighter one.")
      ];
      const snapshot = sourceSnapshot(messages);
      const passedOver = memoryFactPassedOverReplyIds(messages);
      expect(passedOver).toEqual(new Set(["failed"]));
      expect(boundedMemoryFactContextMessageIds(snapshot, "target", passedOver))
        .toEqual(["u1", "a1", "u2", "target"]);
      expect(boundedMemoryFactContextMessageIds(snapshot, "target")).toEqual(["target"]);

      // An older failed reply is passed over too, within the same two-group bound.
      const older = [
        userMessage("u0", null, "Oldest question."),
        assistantMessage("a0", "u0", "Oldest answer."),
        userMessage("u1", "a0", "Which laptop suits travel?"),
        failedReply("failed-older", "u1", status),
        userMessage("u2", "failed-older", "Compare their batteries."),
        assistantMessage("a2", "u2", "The lighter one lasts longer."),
        userMessage("target", "a2", "I bought the lighter one.")
      ];
      expect(boundedMemoryFactContextMessageIds(
        sourceSnapshot(older),
        "target",
        memoryFactPassedOverReplyIds(older)
      )).toEqual(["u1", "u2", "a2", "target"]);
    }
  );

  it("passes over only failed or cancelled assistant replies", () => {
    expect(memoryFactPassedOverReplyIds([
      { id: "cancelled", role: "assistant", status: "cancelled" },
      { id: "streaming", role: "assistant", status: "streaming" },
      { id: "queued", role: "assistant", status: "queued" },
      { id: "complete", role: "assistant", status: "complete" },
      { id: "user-error", role: "user", status: "error" },
      { id: "tool-error", role: "tool", status: "error" }
    ])).toEqual(new Set(["cancelled"]));
  });

  it("keeps every other boundary before or beyond a passed-over reply", () => {
    const streaming = [
      userMessage("u1", null, "older user"),
      assistantMessage("a1", "u1", "older assistant"),
      userMessage("u2", "a1", "nearest user"),
      failedReply("unsettled", "u2", "streaming"),
      userMessage("target", "unsettled", "current target")
    ];
    expect(boundedMemoryFactContextMessageIds(
      sourceSnapshot(streaming),
      "target",
      memoryFactPassedOverReplyIds(streaming)
    )).toEqual(["target"]);

    const taintedBeyond = [
      userMessage("u1", null, "older user"),
      assistantMessage("a1", "u1", "tainted assistant", true),
      failedReply("failed", "a1", "cancelled"),
      userMessage("target", "failed", "current target")
    ];
    expect(boundedMemoryFactContextMessageIds(
      sourceSnapshot(taintedBeyond),
      "target",
      memoryFactPassedOverReplyIds(taintedBeyond)
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
