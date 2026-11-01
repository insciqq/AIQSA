import { describe, expect, it } from "vitest";
import type { ResearchOpenedSource } from "./gates";
import { checkQuotes, normalizeQuotedText } from "./quoteCheck";
import { RESEARCH_SOURCE_LIMITS } from "./sources";

const page = (text: string, url: string | null = "https://lab.example/x1", extra: Partial<ResearchOpenedSource> = {}): ResearchOpenedSource =>
  ({ partial: false, text, toolName: "fetch_url", url, ...extra });
const finding = (quote: string, url = "https://lab.example/x1") => ({ quote, url });
const one = (quote: string, opened: readonly ResearchOpenedSource[] | null, url?: string) => checkQuotes([finding(quote, url)], opened)[0];

describe("the quote check", () => {
  it("finds a quote in text an agent opened, whichever page the run read it on", () => {
    expect(one("held up after 10 years", [page("The X1 held up after 10 years of use.")])).toEqual({ status: "found" });
    // A redirect or another address is the verifier's to judge: the quote is real.
    expect(one("held up after 10 years", [page("The X1 held up after 10 years.", "https://other.example/a")])).toEqual({ status: "found" });
    expect(one("held up after 10 years", [page("The X1 held up after 10 years.", null, { toolName: "mcp__workspace__sandbox_shell" })])).toEqual({ status: "found" });
  });

  it("catches an invented quote, and a source nobody opened", () => {
    expect(one("never wears out", [page("The X1 held up after 10 years.")])).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(one("never wears out", [])).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(one("...", [page("...")])).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("does not take a search snippet for an opened page", () => {
    const search = page("held up after 10 years", null, { toolName: "search_selected_engines" });
    expect(one("held up after 10 years", [search])).toEqual({ reason: "search_snippet_only", status: "unsupported" });
    expect(one("held up after 10 years", [search, page("The X1 held up after 10 years.")])).toEqual({ status: "found" });
  });

  it("reads saved results stringified once or twice", () => {
    const saved = JSON.stringify({ text: "She said: \"it held up\"\nafter 10\tyears — and more", url: "https://lab.example/x1" });
    expect(one("She said: \"it held up\" after 10 years - and more", [page(saved)])).toEqual({ status: "found" });
    expect(one("She said: \"it held up\" after 10 years - and more", [page(JSON.stringify({ output: saved }))])).toEqual({ status: "found" });
    expect(one("café au lait", [page("caf\\u00e9 au lait")])).toEqual({ status: "found" });
  });

  it("tolerates what copying changes and still misses different words", () => {
    const text = "«Матрас» выдержал 10 лет — без про­садки, **как обещано**, см. [отчёт](https://lab.example/r).";
    for (const quote of ["\"Матрас\" выдержал 10 лет - без просадки", "Матрас» выдержал", "как обещано, см. отчёт.", "выдержал 10 лет … как обещано", "“матрас” выдержал [...] без просадки"]) {
      expect(one(quote, [page(text)]), quote).toEqual({ status: "found" });
    }
    expect(one("выдержал 20 лет", [page(text)])).toMatchObject({ status: "unsupported" });
    // Out of order is no quote of this page.
    expect(one("как обещано ... выдержал", [page(text)])).toMatchObject({ status: "unsupported" });
  });

  it("says not checked, never unsupported, for a page read through the browser and not stored", () => {
    const steps = page("Running.\n[browser #3 · lab] open @ www.lab.example/x1\n[browser #4 · lab] click: button \"Next\" @ lab.example/x2\nSaved to a file.", null, { toolName: "mcp__workspace__sandbox_shell" });
    expect(one("held up after 10 years", [steps])).toEqual({ reason: "browser_page", status: "not_checked" });
    expect(one("held up after 10 years", [page(JSON.stringify({ stdout: "[browser #3] open @ lab.example/x1\n" }), null)])).toEqual({ reason: "browser_page", status: "not_checked" });
    // A browser on another site says nothing of this link.
    expect(one("held up after 10 years", [steps], "https://shop.example/x1")).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    // Page text that looks like a step is indented by the helper, so it is no step.
    expect(one("held up after 10 years", [page("  [browser #3] open @ lab.example/x1")])).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("says not checked when the source that could hold the quote is only an excerpt", () => {
    expect(one("held up after 10 years", [page("excerpt", "https://lab.example/x1", { partial: true })])).toEqual({ reason: "partial_source", status: "not_checked" });
    expect(one("held up after 10 years", [page("excerpt", null, { partial: true, toolName: "mcp__workspace__sandbox_shell" })])).toEqual({ reason: "partial_source", status: "not_checked" });
    // An excerpt of another page or of a search says nothing of this one.
    expect(one("held up after 10 years", [page("excerpt", "https://other.example/a", { partial: true })])).toMatchObject({ status: "unsupported" });
    expect(one("held up after 10 years", [page("excerpt", null, { partial: true, toolName: "search_engine_1" })])).toMatchObject({ status: "unsupported" });
    // What an excerpt does hold is still found.
    expect(one("excerpt", [page("the excerpt", "https://lab.example/x1", { partial: true })])).toEqual({ status: "found" });
  });

  it("says not checked when the run's text could not be read or is over what one check reads", () => {
    expect(one("held up", null)).toEqual({ reason: "sources_unreadable", status: "not_checked" });
    const many = Array.from({ length: RESEARCH_SOURCE_LIMITS.results }, () => page("x"));
    expect(one("held up", many)).toEqual({ reason: "sources_over_limit", status: "not_checked" });
  });

  it("normalizes both sides alike", () => {
    expect(normalizeQuotedText(" A — B\\n«C» ")).toBe("a - b \"c\"");
    expect(normalizeQuotedText("\\\\\"x\\\\\"")).toBe("\"x\"");
  });
});
