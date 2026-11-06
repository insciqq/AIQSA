import { describe, expect, it } from "vitest";
import { extractPage } from "../webFetch/extract";
import type { FetchedPage } from "../webFetch/pageKinds";
import { isBotCheckPage } from "./botCheckPage";
import { BOT_CHECK_PAGES, CAPTCHA_ARTICLES, FORM_WITH_CAPTCHA, htmlPage } from "./botCheckPage.testFixtures";

const extracted = (html: string) => {
  const body = new TextEncoder().encode(html);
  const page = extractPage({ body, contentType: "text/html; charset=utf-8", finalUrl: "https://page.example/" });
  if (!page) throw new Error("Expected a parsed page.");
  return { body, page };
};

describe("bot check pages", () => {
  it.each(BOT_CHECK_PAGES)("detects a short challenge: $name", ({ html }) => {
    const { body, page } = extracted(html);
    expect(isBotCheckPage(page, body)).toBe(true);
  });

  it.each(CAPTCHA_ARTICLES)("reads $name despite markers in its title, body and widget", ({ html }) => {
    const { body, page } = extracted(html);
    expect(page.text.length).toBeGreaterThan(4_000);
    expect(isBotCheckPage(page, body)).toBe(false);
  });

  it("reads a short real page whose form carries a CAPTCHA widget", () => {
    const { body, page } = extracted(FORM_WITH_CAPTCHA);
    expect(page.text.replace(/\s+/gu, " ").length).toBeGreaterThan(300);
    expect(isBotCheckPage(page, body)).toBe(false);
  });

  it("requires a marker even when the page is short or empty", () => {
    for (const content of ["<p>The current price is 42.</p>", ""]) {
      const { body, page } = extracted(htmlPage("Current offer", content));
      expect(isBotCheckPage(page, body)).toBe(false);
    }
  });

  it("uses visible text length, not script size or whitespace padding", () => {
    const { body, page } = extracted(htmlPage("Checking your browser", `<script>${"x".repeat(10_000)}</script><p>${" \n".repeat(2_000)}Please wait.</p>`));
    expect(isBotCheckPage(page, body)).toBe(true);
  });

  it("does not mistake a truncated excerpt for a short page", () => {
    const { body, page } = extracted(BOT_CHECK_PAGES[0].html);
    expect(isBotCheckPage({ ...page, truncated: true }, body)).toBe(false);
  });

  it("recognizes a plain text challenge without interpreting documents or structured data as a check", () => {
    const page: FetchedPage = { kind: "text", text: "VERIFY YOU ARE HUMAN", title: null, truncated: false };
    const body = new TextEncoder().encode(page.text);
    expect(isBotCheckPage(page, body)).toBe(true);
    for (const kind of ["pdf", "json", "markdown"] as const) expect(isBotCheckPage({ ...page, kind }, body)).toBe(false);
  });
});
