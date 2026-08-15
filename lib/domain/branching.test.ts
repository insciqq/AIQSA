import { describe, expect, it } from "vitest";
import { getVisibleMessagePath, type BranchMessage } from "./branching";

const messages: BranchMessage[] = [
  { id: "u1", parentMessageId: null, role: "user" },
  { id: "a1", parentMessageId: "u1", role: "assistant" },
  { id: "u2", parentMessageId: "a1", role: "user" },
  { id: "a2", parentMessageId: "u2", role: "assistant" },
  { id: "u2b", parentMessageId: "a1", role: "user" },
  { id: "a2b", parentMessageId: "u2b", role: "assistant" }
];

describe("branch helpers", () => {
  it("returns the visible ancestor path for the active leaf", () => {
    expect(getVisibleMessagePath(messages, "a2b").map((message) => message.id)).toEqual([
      "u1",
      "a1",
      "u2b",
      "a2b"
    ]);
  });
});
