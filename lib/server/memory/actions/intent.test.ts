import { describe, expect, it } from "vitest";
import {
  decodeMemoryActionPlan,
  planMemoryAction,
  planMemoryActionFromText
} from "./intent";

describe("model-driven Memory actions", () => {
  it("never derives action authority from natural-language text", () => {
    for (const source of [
      "Remember that I prefer concise answers.",
      "Запомни, что я предпочитаю ответы на русском",
      "Forget that my favorite editor is Vim.",
      "更新我的记忆",
      "Forget it",
      '"Remember that my token is abc"',
      "- Remember that this is sample text"
    ]) {
      expect(planMemoryActionFromText(source)).toEqual({ kind: "NONE" });
    }
    expect(planMemoryAction({ blocks: [{ text: "Запомни это", type: "text" }] }))
      .toEqual({ kind: "NONE" });
  });

  it("decodes only well-formed persisted v1 plans for legacy recovery", () => {
    expect(decodeMemoryActionPlan({
      kind: "FORGET",
      sourceEnd: 15,
      sourceStart: 7,
      targetQuery: "old fact",
      version: "memory-action-plan-v1"
    })).toMatchObject({ kind: "FORGET", targetQuery: "old fact" });
    expect(decodeMemoryActionPlan({
      kind: "SAVE",
      sourceEnd: 4,
      sourceStart: 4,
      statement: "fact",
      version: "memory-action-plan-v1"
    })).toBeNull();
    expect(decodeMemoryActionPlan({
      kind: "FORGET",
      sourceEnd: 15,
      sourceStart: 7,
      targetQuery: " old fact ",
      version: "memory-action-plan-v1"
    })).toBeNull();
  });
});
