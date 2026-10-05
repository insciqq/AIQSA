import { describe, expect, it } from "vitest";
import type { ChatBranchGraphWire } from "@/lib/contracts/chats";
import {
  activeBranchPathV2,
  branchLeafRevealingMessageV2,
  branchPagerForMessageV2,
  branchVersionsV2
} from "./branchModel";

const graph: ChatBranchGraphWire = {
  activeLeafMessageId: "edited-answer",
  nodes: [
    {
      id: "root-question",
      parentMessageId: null,
      preview: "Root question",
      role: "user",
      status: "complete"
    },
    {
      id: "original-answer",
      parentMessageId: "root-question",
      preview: "Original answer",
      role: "assistant",
      status: "complete"
    },
    {
      id: "regenerated-answer",
      parentMessageId: "root-question",
      preview: "Regenerated answer",
      role: "assistant",
      status: "complete"
    },
    {
      id: "original-follow-up",
      parentMessageId: "regenerated-answer",
      preview: "Original follow-up",
      role: "user",
      status: "complete"
    },
    {
      id: "original-follow-up-answer",
      parentMessageId: "original-follow-up",
      preview: "Original follow-up answer",
      role: "assistant",
      status: "complete"
    },
    {
      id: "edited-follow-up",
      parentMessageId: "regenerated-answer",
      preview: "Edited follow-up",
      role: "user",
      status: "complete"
    },
    {
      id: "edited-answer",
      parentMessageId: "edited-follow-up",
      preview: "Edited answer",
      role: "assistant",
      status: "complete"
    }
  ],
  snapshotUpdatedAt: "2026-08-13T10:00:00.000Z"
};

describe("branch v2 presentation model", () => {
  it("derives only the active immutable ancestor path", () => {
    expect(activeBranchPathV2(graph).map((node) => node.id)).toEqual([
      "root-question",
      "regenerated-answer",
      "edited-follow-up",
      "edited-answer"
    ]);
  });

  it("labels leaf versions by their first divergence without exposing ids as copy", () => {
    const versions = branchVersionsV2(graph);

    expect(versions.map((version) => ({
      active: version.active,
      kind: version.kind,
      ordinal: version.ordinal,
      preview: version.preview
    }))).toEqual([
      {
        active: false,
        kind: "original",
        ordinal: 1,
        preview: "Root question"
      },
      {
        active: false,
        kind: "regenerated_answer",
        ordinal: 2,
        preview: "Original follow-up"
      },
      {
        active: true,
        kind: "edited_question",
        ordinal: 3,
        preview: "Edited follow-up"
      }
    ]);
    expect(versions.map((version) => version.preview).join(" ")).not.toMatch(/-answer|-question/);
  });

  it("returns exact previous and next leaf targets for answer and question siblings", () => {
    expect(branchPagerForMessageV2(graph, "regenerated-answer")).toEqual({
      current: 2,
      nextLeafId: null,
      previousLeafId: "original-answer",
      total: 2
    });
    expect(branchPagerForMessageV2(graph, "edited-follow-up")).toEqual({
      current: 2,
      nextLeafId: null,
      previousLeafId: "original-follow-up-answer",
      total: 2
    });
    expect(branchPagerForMessageV2(graph, "edited-answer")).toBeNull();
    expect(branchPagerForMessageV2(graph, "missing")).toBeNull();
  });

  it("finds the newest leaf below a message off the active path, and none on it", () => {
    for (const onPath of ["root-question", "regenerated-answer", "edited-answer"]) {
      expect(branchLeafRevealingMessageV2(graph, onPath)).toBeNull();
    }
    expect(branchLeafRevealingMessageV2(graph, "missing")).toBeNull();
    // A leaf reveals itself; an inner message, the newest leaf of its subtree.
    expect(branchLeafRevealingMessageV2(graph, "original-answer")).toBe("original-answer");
    expect(branchLeafRevealingMessageV2(graph, "original-follow-up")).toBe("original-follow-up-answer");

    // Newest by creation, not by following the newest child at each fork.
    const node = (id: string, parentMessageId: string | null, role: "assistant" | "user" = "user") =>
      ({ id, parentMessageId, preview: id, role, status: "complete" as const });
    const forked: ChatBranchGraphWire = {
      activeLeafMessageId: "active-leaf",
      nodes: [
        node("root", null),
        node("active-leaf", "root", "assistant"),
        node("match", "root", "assistant"),
        node("older-child", "match"),
        node("newer-child", "match"),
        node("late-grandchild", "older-child", "assistant")
      ],
      snapshotUpdatedAt: "2026-08-13T10:00:00.000Z"
    };
    expect(branchLeafRevealingMessageV2(forked, "match")).toBe("late-grandchild");
  });

  it("fails closed for a missing or cyclic active leaf", () => {
    expect(activeBranchPathV2({ ...graph, activeLeafMessageId: "missing" })).toEqual([]);
    const cyclic: ChatBranchGraphWire = {
      activeLeafMessageId: "cycle-a",
      nodes: [
        {
          id: "cycle-a",
          parentMessageId: "cycle-b",
          preview: "A",
          role: "assistant",
          status: "complete"
        },
        {
          id: "cycle-b",
          parentMessageId: "cycle-a",
          preview: "B",
          role: "user",
          status: "complete"
        }
      ],
      snapshotUpdatedAt: graph.snapshotUpdatedAt
    };
    expect(activeBranchPathV2(cyclic).map((node) => node.id)).toEqual(["cycle-b", "cycle-a"]);
  });
});
