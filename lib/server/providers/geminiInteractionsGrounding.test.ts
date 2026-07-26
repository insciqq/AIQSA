import { describe, expect, it } from "vitest";
import { validateGeminiSearchSuggestionsHtml } from "./geminiInteractionsGrounding";

export const validGeminiSuggestionsHtml = [
  "<style>.container { display: flex; position: relative; } .chip:hover { color: #123456; }</style>",
  '<div class="container"><a class="chip" href="https://www.google.com/search?q=aiqsa" target="_blank">Search on Google</a>',
  '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">',
  '<circle cx="10" cy="10" r="8" fill="#4285f4"></circle>',
  '<path d="M1 1 L2 2 Z" fill="currentColor"></path></svg></div>'
].join("");

describe("Gemini Search Suggestions HTML validator", () => {
  it("forwards a bounded observed Google widget unchanged", () => {
    expect(validateGeminiSearchSuggestionsHtml(validGeminiSuggestionsHtml))
      .toBe(validGeminiSuggestionsHtml);
  });

  it.each([
    '<script>alert(1)</script><a href="https://google.com">Search</a>',
    '<!-- hidden --><a href="https://google.com">Search</a>',
    '<a href="javascript:alert(1)">Search</a>',
    '<a href="https://evil.example/search">Search</a>',
    '<a href="https://google.com" onclick="alert(1)">Search</a>',
    '<style>@import "https://evil.example/x.css";</style><a href="https://google.com">Search</a>',
    '<style>.x{background:url(https://evil.example/x)}</style><a href="https://google.com">Search</a>',
    '<style>.x{position:fixed}</style><a href="https://google.com">Search</a>',
    '<style>:host{display:none}</style><a href="https://google.com">Search</a>',
    "<div>No Google link</div>"
  ])("rejects untrusted or structurally unsupported markup", (html) => {
    expect(() => validateGeminiSearchSuggestionsHtml(html))
      .toThrow("gemini_interactions_grounding_html_invalid");
  });
});
