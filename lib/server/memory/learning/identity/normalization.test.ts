import { describe, expect, it } from "vitest";
import {
  memoryPropositionCanonicalKey,
  normalizeMemoryIdentityComponent,
  normalizeMemoryProposition
} from "./normalization";

describe("Memory Unicode identity normalization", () => {
  it("never returns the surviving ASCII fragment of a Unicode label", () => {
    const ascii = normalizeMemoryIdentityComponent("fixture", "caf");
    const accented = normalizeMemoryIdentityComponent("fixture", "cafè");
    expect(ascii).toBe("a-caf");
    expect(accented).toMatch(/^h-[a-f0-9]{48}$/u);
    expect(accented).not.toBe(ascii);
  });

  it("hashes complete punctuation-bearing ASCII instead of lossy slugs", () => {
    const cpp = normalizeMemoryIdentityComponent("fixture", "C++");
    const csharp = normalizeMemoryIdentityComponent("fixture", "C#");
    expect(cpp).toMatch(/^h-[a-f0-9]{48}$/u);
    expect(csharp).toMatch(/^h-[a-f0-9]{48}$/u);
    expect(cpp).not.toBe(csharp);
  });

  it("collapses only Unicode-normalization and case equivalents", () => {
    expect(normalizeMemoryIdentityComponent("fixture", "CAFÉ"))
      .toBe(normalizeMemoryIdentityComponent("fixture", "cafe\u0301"));
    expect(normalizeMemoryIdentityComponent("fixture", "I"))
      .not.toBe(normalizeMemoryIdentityComponent("fixture", "İ"));
    expect(normalizeMemoryIdentityComponent("fixture", "I"))
      .not.toBe(normalizeMemoryIdentityComponent("fixture", "ı"));
  });

  it.each([
    ["Đorđe", "Ђорђе"],
    ["cafe", "саfe"],
    ["مدرسة", "מדרשה"],
    ["भारत", "ভারত"],
    ["記憶", "记忆"],
    ["project-東京", "project-tokyo"]
  ])("keeps scripts and mixed-script labels distinct: %s / %s", (left, right) => {
    expect(normalizeMemoryIdentityComponent("fixture", left))
      .not.toBe(normalizeMemoryIdentityComponent("fixture", right));
  });

  it("versions propositions and removes the active ё substitution", () => {
    expect(normalizeMemoryProposition("Ёлка"))
      .not.toBe(normalizeMemoryProposition("Елка"));
    expect(memoryPropositionCanonicalKey("Ёлка"))
      .not.toBe(memoryPropositionCanonicalKey("Елка"));
    expect(memoryPropositionCanonicalKey("Ёлка", "LEGACY_V1"))
      .toBe(memoryPropositionCanonicalKey("Елка", "LEGACY_V1"));
    expect(memoryPropositionCanonicalKey("Ёлка"))
      .toMatch(/^prop:v2:[a-f0-9]{64}$/u);
  });
});
