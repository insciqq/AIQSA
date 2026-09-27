import { describe, expect, it } from "vitest";
import { storableUtf16Text, takeUtf16SafePrefix } from "./utf16";

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

describe("storable UTF-16 text", () => {
  it("drops NUL and replaces only unpaired surrogates", () => {
    expect(storableUtf16Text("a\u0000b😀c")).toBe("ab😀c");
    expect(storableUtf16Text("x\uD83Dy\uDE00z")).toBe("x�y�z");
    expect(storableUtf16Text("\uDE00\uD83D")).toBe("��");
    expect(storableUtf16Text("plain")).toBe("plain");
  });
});
