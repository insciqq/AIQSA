import { describe, expect, it } from "vitest";
import { takeUtf16SafePrefix } from "./utf16";

describe("UTF-16 prefixes", () => {
  it("drops a high surrogate when the limit bisects an astral character", () => {
    expect(takeUtf16SafePrefix("ab😀cd", 3)).toBe("ab");
    expect(takeUtf16SafePrefix("ab😀cd", 4)).toBe("ab😀");
  });

  it("leaves text unchanged when it already fits", () => {
    const text = "ab😀";

    expect(takeUtf16SafePrefix(text, text.length)).toBe(text);
    expect(takeUtf16SafePrefix(text, text.length + 1)).toBe(text);
  });
});
