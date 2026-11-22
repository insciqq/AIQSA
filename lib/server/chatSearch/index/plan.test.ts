import { describe, expect, it } from "vitest";
import type { ChatSearchPassageDraft } from "./passages";
import { planChatSearchPassages, type StoredChatSearchPassage } from "./plan";

const at = new Date(Date.UTC(2026, 10, 1, 12));
const draft = (userMessageId: string, ordinal: number, contentHash: string, assistantMessageId = `${userMessageId}-a`): ChatSearchPassageDraft =>
  ({ assistantMessageId, contentHash, ordinal, text: `text ${contentHash}`, turnAt: at, userMessageId });
const stored = (id: string, passage: ChatSearchPassageDraft): StoredChatSearchPassage =>
  ({ assistantMessageId: passage.assistantMessageId, contentHash: passage.contentHash, id, ordinal: passage.ordinal,
    turnAt: passage.turnAt, userMessageId: passage.userMessageId });

describe("past-chat passage plan", () => {
  it("keeps unchanged passages, inserts new turns and touches nothing else", () => {
    const plan = planChatSearchPassages([stored("p1", draft("q1", 0, "h1"))], [draft("q1", 0, "h1"), draft("q2", 0, "h2")]);
    expect(plan).toEqual({ deletes: [], inserts: [draft("q2", 0, "h2")], unchanged: 1, updates: [] });
  });

  it("replaces a changed text and clears its vector, and keeps the vector of a regenerated answer with the same words", () => {
    const plan = planChatSearchPassages(
      [stored("p1", draft("q1", 0, "h1")), stored("p2", draft("q2", 0, "h2"))],
      [draft("q1", 0, "h1-new"), draft("q2", 0, "h2", "q2-regenerated")]
    );
    expect(plan.updates).toEqual([
      { ...draft("q1", 0, "h1-new"), id: "p1", textChanged: true },
      { ...draft("q2", 0, "h2", "q2-regenerated"), id: "p2", textChanged: false }
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.deletes).toEqual([]);
  });

  it("deletes the passages of turns the active branch lost and the windows a turn no longer has", () => {
    const plan = planChatSearchPassages(
      [stored("p1", draft("q1", 0, "h1")), stored("p2", draft("q1", 1, "h1b")), stored("p3", draft("q-old", 0, "h3"))],
      [draft("q1", 0, "h1")]
    );
    expect(plan.deletes).toEqual(["p2", "p3"]);
    expect(plan.unchanged).toBe(1);
  });
});
