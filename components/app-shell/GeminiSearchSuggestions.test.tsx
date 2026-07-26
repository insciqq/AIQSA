import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GeminiSearchSuggestions } from "./GeminiSearchSuggestions";

describe("GeminiSearchSuggestions", () => {
  it("renders validated Google suggestion markup inside an isolated shadow root", async () => {
    render(<GeminiSearchSuggestions html={'<div class="suggestion"><a href="https://www.google.com/search?q=aiqsa">AIQSA</a></div>'} />);
    const host = screen.getByTestId("gemini-search-suggestions").querySelector("div");
    await waitFor(() => expect(host?.shadowRoot?.textContent).toContain("AIQSA"));
    expect(host?.shadowRoot?.querySelector("a")?.getAttribute("href"))
      .toBe("https://www.google.com/search?q=aiqsa");
  });

  it("rejects active content and non-Google links", async () => {
    render(<GeminiSearchSuggestions html={'<a href="https://attacker.example">Unsafe</a><script>alert(1)</script>'} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be displayed safely");
    const host = screen.getByTestId("gemini-search-suggestions").querySelector("div");
    expect(host?.shadowRoot).toBeNull();
  });

  it("accepts the complete server-approved anchor shape", async () => {
    render(<GeminiSearchSuggestions html={'<style type="text/css">.chip{display:block}</style><a class="chip" href="https://google.com/search?q=aiqsa" target="_blank" rel="noopener noreferrer">Search</a>'} />);
    const host = screen.getByTestId("gemini-search-suggestions").querySelector("div");
    await waitFor(() => expect(host?.shadowRoot?.querySelector("a")?.textContent).toBe("Search"));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
