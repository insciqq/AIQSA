import { describe, expect, it } from "vitest";
import { visibleMessagePath } from "./threadPath";
import type { ThreadMessage } from "./types";

function message(input: Partial<ThreadMessage> & Pick<ThreadMessage, "id" | "parentMessageId" | "role">): ThreadMessage {
  return {
    content: input.content ?? input.id,
    status: "complete",
    ...input
  };
}

describe("branch tree presentation", () => {
  it("renders a bounded active-path tail whose first parent is intentionally off-page", () => {
    const messages = [
      message({ id: "m51", parentMessageId: "m50", role: "user" }),
      message({ id: "m52", parentMessageId: "m51", role: "assistant" })
    ];

    expect(visibleMessagePath(messages, "m52").map((candidate) => candidate.id)).toEqual([
      "m51",
      "m52"
    ]);
  });
});
