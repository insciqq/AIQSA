import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GEMINI_SEARCH_SUGGESTIONS_LIMITS } from "@/lib/domain/geminiSearchSuggestions";
import { GeminiSearchSuggestionsV2 } from "./GeminiSearchSuggestionsV2";

const safeSuggestion = [
  '<div class="provider-card">',
  '<a class="provider-link" href="https://www.google.com/search?q=aiqsa" target="_blank" rel="noopener noreferrer">Search on Google</a>',
  '<svg class="provider-icon" width="9999" height="9999" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">',
  '<circle cx="10" cy="10" r="8" fill="#4285f4"></circle>',
  '<path d="M1 1 L2 2 Z" fill="currentColor"></path>',
  "</svg>",
  "</div>"
].join("");

function suggestionHost(): HTMLDivElement {
  return screen.getByTestId("gemini-search-suggestions-host");
}

describe("Gemini answer Search suggestions", () => {
  it("renders a named, bounded projection with one code-owned stylesheet", async () => {
    render(<GeminiSearchSuggestionsV2 html={safeSuggestion} />);

    expect(screen.getByRole("complementary", { name: "Google Search suggestions" }))
      .toBeInTheDocument();
    const host = suggestionHost();
    await waitFor(() => expect(host.shadowRoot?.querySelector("a")?.textContent)
      .toBe("Search on Google"));

    const shadow = host.shadowRoot!;
    const styles = shadow.querySelectorAll('style[data-aiqsa-suggestions-style="true"]');
    const wrappers = shadow.querySelectorAll('[data-aiqsa-suggestions-content="true"]');
    expect(styles).toHaveLength(1);
    expect(wrappers).toHaveLength(1);
    expect(shadow.children).toHaveLength(2);
    expect(styles[0]).toHaveTextContent("contain: layout paint style");
    expect(styles[0]).toHaveTextContent("min-block-size: 44px");
    expect(styles[0]).toHaveTextContent("outline-offset: -2px");
    expect(styles[0]).not.toHaveTextContent("provider-card");
    expect(shadow.querySelector("a")?.getAttribute("href"))
      .toBe("https://www.google.com/search?q=aiqsa");
    expect(shadow.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(shadow.querySelector("svg")).toHaveAttribute("focusable", "false");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    {
      html: String.raw`<style>.cover{pos\69 tion:fixed;inset:0;z-index:2147483647}</style><a href="https://google.com/search?q=unsafe">Unsafe</a>`,
      label: "direct provider styles"
    },
    {
      html: '<a href="https://attacker.example">Unsafe</a><script>alert(1)</script>',
      label: "active content and non-Google links"
    },
    {
      html: '<a class="chip:hover" href="https://google.com/search?q=unsafe">Unsafe</a>',
      label: "attribute values outside shared policy"
    },
    {
      html: '<div>Missing a bounded navigation target</div>',
      label: "projections without a Google link"
    },
    {
      html: '<a href="https://google.com/search?q=control">Unsafe\u000btext</a>',
      label: "unsafe controls"
    },
    {
      html: `${"<div>".repeat(GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxDepth + 1)}<a href="https://google.com/search?q=deep">Deep</a>${"</div>".repeat(GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxDepth + 1)}`,
      label: "excessive depth"
    },
    {
      html: `${"<div></div>".repeat(GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxNodes)}<a href="https://google.com/search?q=many">Many</a>`,
      label: "excessive node count"
    },
    {
      html: `${'<svg class="a" fill="none" height="1" viewBox="0 0 1 1" width="1" xmlns="http://www.w3.org/2000/svg"></svg>'.repeat(171)}<a href="https://google.com/search?q=attributes">Attributes</a>`,
      label: "excessive attribute count"
    },
    {
      html: `<a href="https://google.com/search?q=large">${"x".repeat(GEMINI_SEARCH_SUGGESTIONS_LIMITS.maxHtmlBytes)}</a>`,
      label: "excessive byte size"
    }
  ])("fails closed for $label", async ({ html }) => {
    render(<GeminiSearchSuggestionsV2 html={html} />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Search suggestions could not be displayed safely."
    );
    expect(suggestionHost()).toHaveAttribute("hidden");
    expect(suggestionHost().shadowRoot).toBeNull();
  });

  it("atomically clears and restores the projection across valid and invalid updates", async () => {
    const { rerender } = render(<GeminiSearchSuggestionsV2 html={safeSuggestion} />);
    const host = suggestionHost();
    await waitFor(() => expect(host.shadowRoot?.querySelector("a")).not.toBeNull());
    const shadow = host.shadowRoot!;

    rerender(
      <GeminiSearchSuggestionsV2
        html={'<style>.cover{position:fixed;inset:0}</style><a href="https://google.com/search?q=unsafe">Unsafe</a>'}
      />
    );
    expect(await screen.findByRole("alert")).toBeVisible();
    expect(host).toHaveAttribute("hidden");
    expect(shadow.childNodes).toHaveLength(0);
    expect(shadow.querySelector("a")).toBeNull();

    rerender(
      <GeminiSearchSuggestionsV2
        html={'<a href="https://google.com/search?q=recovered">Recovered search</a>'}
      />
    );
    await waitFor(() => expect(shadow.querySelector("a")?.textContent)
      .toBe("Recovered search"));
    expect(host).not.toHaveAttribute("hidden");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(shadow.querySelectorAll('style[data-aiqsa-suggestions-style="true"]')).toHaveLength(1);
    expect(shadow.querySelectorAll('[data-aiqsa-suggestions-content="true"]')).toHaveLength(1);
    expect(shadow.children).toHaveLength(2);
  });

  it("removes projected nodes when the component unmounts", async () => {
    const { unmount } = render(<GeminiSearchSuggestionsV2 html={safeSuggestion} />);
    const host = suggestionHost();
    await waitFor(() => expect(host.shadowRoot?.querySelector("a")).not.toBeNull());
    const shadow = host.shadowRoot!;

    unmount();

    expect(shadow.childNodes).toHaveLength(0);
  });
});
