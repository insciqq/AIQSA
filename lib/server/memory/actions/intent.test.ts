import { describe, expect, it } from "vitest";
import { planMemoryActionFromText } from "./intent";

describe("direct current-user Memory intent", () => {
  it("recognizes bounded English and Russian management requests", () => {
    expect(planMemoryActionFromText("Remember that I prefer concise answers.")).toMatchObject({
      kind: "SAVE",
      statement: "I prefer concise answers."
    });
    expect(planMemoryActionFromText("Запомни, что я предпочитаю ответы на русском")).toMatchObject({
      kind: "SAVE",
      statement: "я предпочитаю ответы на русском"
    });
    expect(planMemoryActionFromText("What do you remember about me?")).toEqual({
      kind: "LIST",
      query: null,
      version: "memory-action-plan-v1"
    });
    expect(planMemoryActionFromText("Do you remember my editor preference?")).toMatchObject({
      kind: "LIST",
      query: "my editor preference"
    });
    expect(planMemoryActionFromText("Forget that my favorite editor is Vim.")).toMatchObject({
      kind: "FORGET",
      targetQuery: "my favorite editor is Vim."
    });
    expect(planMemoryActionFromText(
      "Update the memory that my editor is Vim to my editor is Neovim"
    )).toMatchObject({
      kind: "UPDATE",
      replacement: "my editor is Neovim",
      targetQuery: "my editor is Vim"
    });
  });

  it("does not treat quoted, bulleted, embedded, or ambiguous text as authority", () => {
    expect(planMemoryActionFromText('"Remember that my token is abc"')).toEqual({ kind: "NONE" });
    expect(planMemoryActionFromText("- Remember that this is sample text")).toEqual({ kind: "NONE" });
    expect(planMemoryActionFromText("Explain the phrase: remember that I like tea")).toEqual({
      kind: "NONE"
    });
    expect(planMemoryActionFromText("Forget it")).toEqual({ kind: "AMBIGUOUS" });
    expect(planMemoryActionFromText("Запомни это")).toEqual({ kind: "AMBIGUOUS" });
  });

  it("binds authority to the captured payload even when command words repeat", () => {
    for (const source of [
      "/forget forget",
      "Update the memory memory to replacement memory"
    ]) {
      const plan = planMemoryActionFromText(source);
      expect(plan.kind === "FORGET" || plan.kind === "UPDATE").toBe(true);
      if (plan.kind === "FORGET" || plan.kind === "UPDATE") {
        expect(source.slice(plan.sourceStart, plan.sourceEnd)).toBe(plan.targetQuery);
      }
    }
  });
});
