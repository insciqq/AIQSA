import { describe, expect, it } from "vitest";
import { branchTreeHasForks, branchTreeNodes, visibleMessagePath } from "./threadPath";
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

  it("counts a first-message edit as a real root fork with checkout leaves", () => {
    const messages: ThreadMessage[] = [
      message({ id: "q1", parentMessageId: null, role: "user", content: "Original question" }),
      message({ id: "a1", parentMessageId: "q1", role: "assistant", content: "Original answer" }),
      message({ id: "q1b", parentMessageId: null, role: "user", content: "Edited question" }),
      message({ id: "a1b", parentMessageId: "q1b", role: "assistant", content: "Edited answer" })
    ];

    expect(branchTreeHasForks(messages)).toBe(true);
    const nodes = branchTreeNodes(messages, "a1b");
    expect(nodes.map((node) => [node.message.id, node.activePath, node.forkChoice, node.checkoutLeafId])).toEqual([
      ["q1", false, true, "a1"],
      ["a1", false, false, "a1"],
      ["q1b", true, true, "a1b"],
      ["a1b", true, false, "a1b"]
    ]);
    expect(nodes.filter((node) => node.active).map((node) => node.message.id)).toEqual(["a1b"]);
  });

  it("resolves checkout through nested forks to the newest descendant leaf", () => {
    const messages: ThreadMessage[] = [
      message({ id: "q1", parentMessageId: null, role: "user" }),
      message({ id: "a1", parentMessageId: "q1", role: "assistant" }),
      message({ id: "q2", parentMessageId: "a1", role: "user" }),
      message({ id: "a2", parentMessageId: "q2", role: "assistant" }),
      message({ id: "a2b", parentMessageId: "q2", role: "assistant" }),
      message({ id: "q3", parentMessageId: "a2b", role: "user" }),
      message({ id: "q1b", parentMessageId: null, role: "user" })
    ];

    const nodes = branchTreeNodes(messages, "q1b");
    const byId = new Map(nodes.map((node) => [node.message.id, node]));
    expect(byId.get("q1")?.checkoutLeafId).toBe("q3");
    expect(byId.get("a2")?.checkoutLeafId).toBe("a2");
    expect(byId.get("q1b")?.checkoutLeafId).toBe("q1b");
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
