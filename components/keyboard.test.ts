import { describe, expect, it } from "vitest";
import { isImeCompositionEvent } from "./keyboard";

describe("isImeCompositionEvent", () => {
  it.each([
    ["native composition", { isComposing: true, key: "Enter" }],
    ["React native composition", { key: "Escape", nativeEvent: { isComposing: true } }],
    ["Process fallback", { key: "Process" }],
    ["legacy 229 fallback", { key: "Enter", keyCode: 229 }]
  ])("recognizes %s", (_label, event) => {
    expect(isImeCompositionEvent(event)).toBe(true);
  });

  it.each([
    { key: "Enter" },
    { key: "Enter", keyCode: 13 },
    { key: "Escape", nativeEvent: { isComposing: false } }
  ])("leaves ordinary keyboard input unchanged", (event) => {
    expect(isImeCompositionEvent(event)).toBe(false);
  });
});
