import { describe, expect, it } from "vitest";
import { omitSubagentCallbackTurns } from "./subagentCallbackTurns";

describe("sub-agent wake-up turns outside the chat", () => {
  it("leaves wake-up turns out and hangs their children under the nearest kept ancestor", () => {
    const graph = omitSubagentCallbackTurns([
      { id: "q", parentId: null, role: "user", systemTurnKind: null },
      { id: "a1", parentId: "q", role: "assistant", systemTurnKind: null },
      { id: "w1", parentId: "a1", role: "user", systemTurnKind: "subagent_callback" },
      { id: "a2", parentId: "w1", role: "assistant", systemTurnKind: null },
      { id: "c", parentId: "a2", role: "user", systemTurnKind: "mcp_approval_continuation" }
    ]);
    expect([...graph.removed]).toEqual(["w1"]);
    expect(graph.parents).toEqual(new Map([["a2", "a1"]]));
    expect(graph.resolve("w1")).toBe("a1");
    expect(graph.resolve("c")).toBe("c");
  });

  it("leaves Sign in again requests out the same way, the first message of a chat included", () => {
    const graph = omitSubagentCallbackTurns([
      { id: "s1", parentId: null, role: "user", systemTurnKind: "browser_sign_in_request" },
      { id: "a1", parentId: "s1", role: "assistant", systemTurnKind: null },
      { id: "s2", parentId: "a1", role: "user", systemTurnKind: "browser_sign_in_request" },
      { id: "a2", parentId: "s2", role: "assistant", systemTurnKind: null }
    ]);
    expect([...graph.removed]).toEqual(["s1", "s2"]);
    expect(graph.parents).toEqual(new Map([["a1", null], ["a2", "a1"]]));
    expect(graph.resolve("s2")).toBe("a1");
    expect(graph.resolve("s1")).toBeNull();
  });
});
