import { describe, expect, it } from "vitest";
import { branchTreeHasForks, branchTreeNodes } from "./threadPath";
import type { ThreadMessage } from "./types";

function message(input: Partial<ThreadMessage> & Pick<ThreadMessage, "id" | "parentMessageId" | "role">): ThreadMessage {
  return {
    content: input.content ?? input.id,
    status: "complete",
    ...input
  };
}

describe("branch tree presentation", () => {
  it("keeps a linear chain flat", () => {
    const messages: ThreadMessage[] = [
      message({ id: "m1", parentMessageId: null, role: "user" }),
      message({ id: "m2", parentMessageId: "m1", role: "assistant" }),
      message({ id: "m3", parentMessageId: "m2", role: "user" }),
      message({ id: "m4", parentMessageId: "m3", role: "assistant" }),
      message({ id: "m5", parentMessageId: "m4", role: "user" }),
      message({ id: "m6", parentMessageId: "m5", role: "assistant" }),
      message({ id: "m7", parentMessageId: "m6", role: "user" })
    ];

    expect(branchTreeHasForks(messages)).toBe(false);
    expect(branchTreeNodes(messages, "m7").map((node) => node.depth)).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("adds depth only below actual fork points", () => {
    const messages: ThreadMessage[] = [
      message({ id: "q1", parentMessageId: null, role: "user" }),
      message({ id: "a1", parentMessageId: "q1", role: "assistant" }),
      message({ id: "q2", parentMessageId: "a1", role: "user" }),
      message({ id: "a2", parentMessageId: "q2", role: "assistant", content: "original" }),
      message({ id: "a2b", parentMessageId: "q2", role: "assistant", content: "regenerated" }),
      message({ id: "q3", parentMessageId: "a2b", role: "user" })
    ];

    expect(branchTreeHasForks(messages)).toBe(true);
    expect(branchTreeNodes(messages, "q3").map((node) => [node.message.id, node.depth, node.activePath])).toEqual([
      ["q1", 0, true],
      ["a1", 0, true],
      ["q2", 0, true],
      ["a2", 1, false],
      ["a2b", 1, true],
      ["q3", 1, true]
    ]);
  });

  it("turns common Markdown syntax into compact plaintext branch previews", () => {
    const messages: ThreadMessage[] = [
      message({ id: "heading", parentMessageId: null, role: "assistant", content: "## Short answer" }),
      message({
        id: "list",
        parentMessageId: "heading",
        role: "assistant",
        content: "1. **Get a [heat-loss calculation](https://example.com).**"
      })
    ];

    expect(branchTreeNodes(messages, "list").map((node) => node.preview)).toEqual([
      "Short answer",
      "Get a heat-loss calculation."
    ]);
    expect(messages[0].content).toBe("## Short answer");
    expect(messages[1].content).toContain("**Get a [heat-loss calculation]");
  });
});
