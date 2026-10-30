import { describe, expect, it } from "vitest";
import { subagentWaitingKeyV2 } from "./subagentPresentation";

describe("subagentWaitingKeyV2", () => {
  it("keys the sub-agents that wait for the user, in a stable order, and is null when none waits", () => {
    expect(subagentWaitingKeyV2([{ id: "b", state: "waiting" }, { id: "c", state: "running" }, { id: "a", state: "waiting" }]))
      .toBe("a,b");
    expect(subagentWaitingKeyV2([{ id: "c", state: "running" }, { id: "d", state: "done" }])).toBeNull();
    expect(subagentWaitingKeyV2([])).toBeNull();
  });
});
