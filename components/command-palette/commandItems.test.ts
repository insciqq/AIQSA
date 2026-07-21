import { describe, expect, it } from "vitest";
import { filterCommandItems, moveCommandSelection, type CommandItem } from "./commandItems";

const items: CommandItem[] = [
  {
    id: "model:openai:gpt-5.5",
    kind: "model",
    keywords: ["openai", "responses", "stream"],
    label: "GPT-5.5",
    subtitle: "OpenAI · Reasoning / stream"
  },
  {
    id: "prompt:default",
    kind: "prompt",
    keywords: ["helpful"],
    label: "Helpful Assistant",
    subtitle: "Default prompt"
  }
];

describe("command item helpers", () => {
  it("filters commands by kind, label, subtitle, and keywords", () => {
    expect(filterCommandItems(items, "openai stream").map((item) => item.id)).toEqual(["model:openai:gpt-5.5"]);
    expect(filterCommandItems(items, "responses").map((item) => item.id)).toEqual(["model:openai:gpt-5.5"]);
    expect(filterCommandItems(items, "prompt helpful").map((item) => item.id)).toEqual(["prompt:default"]);
  });

  it("maps provider category searches to concrete models while retaining item order", () => {
    expect(filterCommandItems(items, "models").map((item) => item.id)).toEqual(["model:openai:gpt-5.5"]);
    expect(filterCommandItems(items, "providers").map((item) => item.id)).toEqual(["model:openai:gpt-5.5"]);
    expect(filterCommandItems(items, "presets").map((item) => item.id)).toEqual(["prompt:default"]);
  });

  it("wraps selection movement and supports first/last jumps", () => {
    expect(moveCommandSelection(0, 3, "up")).toBe(2);
    expect(moveCommandSelection(2, 3, "down")).toBe(0);
    expect(moveCommandSelection(1, 3, "down")).toBe(2);
    expect(moveCommandSelection(2, 3, "first")).toBe(0);
    expect(moveCommandSelection(0, 3, "last")).toBe(2);
    expect(moveCommandSelection(4, 0, "down")).toBe(0);
    expect(moveCommandSelection(4, 0, "last")).toBe(0);
  });
});
