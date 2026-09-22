import { describe, expect, it } from "vitest";
import { decodeRunFollowupInput, decodeRunFollowupState } from "./runFollowups";

const entry = { id: "followup", ordinal: 1, text: "A clarification", author: "Author", createdAt: "2026-09-22T00:00:00.000Z",
  delivery: "delivered", precedingText: "Earlier partial answer" } as const;
describe("follow-up contracts", () => {
  it("accepts bounded text alone and rejects control/configuration inputs", () => {
    const value = { chatId: "chat", assistantMessageId: "answer", nonce: "nonce", text: "  Clarification  " };
    expect(decodeRunFollowupInput(value)?.text).toBe("Clarification");
    for (const patch of [{ text: " " }, { text: "x".repeat(16_001) }, { text: "x\0y" }, { nonce: "a/b" },
      { modelId: "different" }, { attachments: [] }]) expect(decodeRunFollowupInput({ ...value, ...patch })).toBeNull();
  });
  it("projects only ordered browser fields", () => {
    expect(decodeRunFollowupState({ available: true, providerPayload: "private", entries: [{ ...entry, nonce: "private", authorUserId: "private" }] }))
      .toEqual({ available: true, entries: [entry] });
    expect(decodeRunFollowupState({ available: true, entries: [entry, entry] })).toBeNull();
    expect(decodeRunFollowupState({ available: true, entries: [{ ...entry, ordinal: 33 }] })).toBeNull();
  });
});
