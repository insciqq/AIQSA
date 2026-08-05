import { describe, expect, it } from "vitest";
import { validateGeminiSearchSuggestionsHtml } from "./geminiInteractionsGrounding";

export const validGeminiSuggestionsProjection = [
  '<div class="container"><a class="chip" href="https://www.google.com/search?q=aiqsa" target="_blank">Search on Google</a>',
  '<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">',
  '<circle cx="10" cy="10" r="8" fill="#4285f4"></circle>',
  '<path d="M1 1 L2 2 Z" fill="currentColor"></path></svg></div>'
].join("");

export const validGeminiSuggestionsHtml = [
  '<style type="text/css">.container { display: flex; position: relative; }</style>',
  validGeminiSuggestionsProjection
].join("");

describe("Gemini Search Suggestions HTML validator", () => {
  it("returns a bounded, canonical, style-free projection and is idempotent", () => {
    const projection = validateGeminiSearchSuggestionsHtml(validGeminiSuggestionsHtml);

    expect(projection).toBe(validGeminiSuggestionsProjection);
    expect(projection).not.toContain("<style");
    expect(validateGeminiSearchSuggestionsHtml(projection)).toBe(projection);
  });

  it.each([
    "@import 'https://evil.example/x.css';",
    "@\\69 mport 'https://evil.example/x.css';",
    ".x{background:url(https://evil.example/x)}",
    ".x{background:u\\72 l(https://evil.example/x)}",
    ".x{position:fixed;inset:0;z-index:2147483647}",
    ".x{PoSiTiOn/**/:FiXeD}",
    ".x{pos\\69 tion:fixed}",
    ".x{pos\\000069 tion:fixed}",
    ".x{position:\\66 ixed}",
    ".x{position:\\73 ticky}",
    ":host{display:none}",
    ":\\68 ost{display:none}",
    ".x{width:100vw;height:100vh;animation:spin 1ms infinite}",
    ".x{--overlay:fixed;content:'provider-css-canary'}"
  ])("treats provider CSS as inert and strips it without interpretation", (css) => {
    const html = `<style>${css}</style><a href="https://google.com">Search</a>`;

    expect(validateGeminiSearchSuggestionsHtml(html))
      .toBe('<a href="https://google.com">Search</a>');
  });

  it("strips every style node only after validating the complete fragment", () => {
    const html = [
      "<style>.outer{display:none}</style>",
      '<div><style type="text/css">.inner{position:fixed}</style>',
      '<a href="https://google.com/search?q=x&amp;hl=en">Search</a></div>'
    ].join("");

    expect(validateGeminiSearchSuggestionsHtml(html)).toBe(
      '<div><a href="https://google.com/search?q=x&amp;hl=en">Search</a></div>'
    );
  });

  it.each([
    '<style media="screen">.x{color:red}</style><a href="https://google.com">Search</a>',
    '<style type="text/plain">.x{color:red}</style><a href="https://google.com">Search</a>',
    '<style>.x{color:red}</style><script>alert(1)</script><a href="https://google.com">Search</a>',
    '<style>.x{color:red}</style></style><script>alert(1)</script><a href="https://google.com">Search</a>',
    '<script>alert(1)</script><a href="https://google.com">Search</a>',
    '<!-- hidden --><a href="https://google.com">Search</a>',
    '<a href="javascript:alert(1)">Search</a>',
    '<a href="https://evil.example/search">Search</a>',
    '<a href="https://google.com" onclick="alert(1)">Search</a>',
    "<div>No Google link</div>"
  ])("rejects unsupported structure even when a style node is removable", (html) => {
    expect(() => validateGeminiSearchSuggestionsHtml(html))
      .toThrow("gemini_interactions_grounding_html_invalid");
  });
});
