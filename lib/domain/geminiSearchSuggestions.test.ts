import { describe, expect, it } from "vitest";
import {
  geminiSearchSuggestionAttributes,
  isGoogleSearchSuggestionHref,
  isValidGeminiSearchSuggestionAttribute
} from "./geminiSearchSuggestions";

describe("Gemini Search Suggestions shared projection policy", () => {
  it("keeps provider style outside the projected tag language", () => {
    expect(geminiSearchSuggestionAttributes("style")).toBeUndefined();
    expect(geminiSearchSuggestionAttributes("a")).toEqual([
      "class",
      "href",
      "rel",
      "target"
    ]);
  });

  it.each([
    "https://google.com/search?q=aiqsa",
    "https://www.google.com/search?q=aiqsa"
  ])("accepts bounded Google HTTPS links: %s", (href) => {
    expect(isGoogleSearchSuggestionHref(href)).toBe(true);
  });

  it.each([
    "http://google.com/search",
    "https://google.com:444/search",
    "https://user@google.com/search",
    "https://google.com.evil.example/search",
    "https://evil.example/search",
    " https://google.com/search"
  ])("rejects navigation outside the exact Google HTTPS boundary: %s", (href) => {
    expect(isGoogleSearchSuggestionHref(href)).toBe(false);
  });

  it("shares exact class, SVG, and anchor value restrictions", () => {
    expect(isValidGeminiSearchSuggestionAttribute("a", "target", "_blank")).toBe(true);
    expect(isValidGeminiSearchSuggestionAttribute("a", "target", "_self")).toBe(false);
    expect(isValidGeminiSearchSuggestionAttribute("a", "rel", "noopener noreferrer")).toBe(true);
    expect(isValidGeminiSearchSuggestionAttribute("a", "rel", "opener")).toBe(false);
    expect(isValidGeminiSearchSuggestionAttribute("div", "class", "chip safe_name")).toBe(true);
    expect(isValidGeminiSearchSuggestionAttribute("div", "class", "chip:hover")).toBe(false);
    expect(isValidGeminiSearchSuggestionAttribute("svg", "viewbox", "0 0 20 20")).toBe(true);
    expect(isValidGeminiSearchSuggestionAttribute("svg", "viewbox", "0 0 20")).toBe(false);
    expect(isValidGeminiSearchSuggestionAttribute("path", "d", "M1 1 L2 2 Z")).toBe(true);
    expect(isValidGeminiSearchSuggestionAttribute("path", "d", "url(evil)")).toBe(false);
  });
});
