import { describe, expect, it } from "vitest";
import { deletedMessageRunScope } from "./prismaRepository";

describe("the runs a message deletion removes", () => {
  it("are the deleted answers' runs and their background sub-agents' own runs, a child's included, in that chat alone", () => {
    const answers = { chatId: "chat", OR: [{ assistantMessageId: { in: ["answer"] } }, { userMessageId: { in: ["answer"] } }] };
    expect(deletedMessageRunScope("chat", ["answer"])).toEqual({ chatId: "chat", OR: [
      answers,
      // Deleting only the answer keeps the user message its sub-agents' runs share, yet takes their runs with its own.
      { subagentTurn: { is: { mode: "background", parentRun: answers } } },
      { subagentTurn: { is: { mode: "background", parentRun: { subagentTurn: { is: { parentRun: answers } } } } } }
    ] });
  });
});
