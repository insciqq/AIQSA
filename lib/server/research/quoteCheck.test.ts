import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "../engine/transcript";
import { TOOL_RESULT_LIMITS, toolOutputExcerpt } from "../engine/toolResults";
import type { ResearchOpenedSource } from "./gates";
import { checkQuotes, normalizeQuotedText } from "./quoteCheck";
import { createResearchSources, researchEvidenceKind, RESEARCH_SOURCE_LIMITS } from "./sources";

const LINK = "https://lab.example/x1";
const page = (text: string, url: string | null = LINK, extra: Partial<ResearchOpenedSource> = {}): ResearchOpenedSource =>
  ({ partial: false, text, toolName: "fetch_url", url, ...extra });
const finding = (quote: string, url = LINK) => ({ quote, url });
const one = (quote: string, opened: readonly ResearchOpenedSource[] | null, url?: string) => checkQuotes([finding(quote, url)], opened)[0];

const OTHER_PAGE = "https://other.example/a";
const NEVER_OPENED = "https://never.example/x";
const SHELL = "mcp__workspace__sandbox_shell";

describe("the quote check", () => {
  it("finds a quote in a page an agent read, whichever page the run read it on", () => {
    expect(one("held up after 10 years", [page("The X1 held up after 10 years of use.")])).toEqual({ status: "found" });
    // A redirect or another address is the verifier's to judge: the quote is real.
    expect(one("held up after 10 years", [page("The X1 held up after 10 years.", OTHER_PAGE)])).toEqual({ status: "found" });
    expect(one("held up after 10 years", [page("The X1 held up after 10 years.", null, { browser: true, toolName: SHELL })])).toEqual({ status: "found" });
    expect(one("held up after 10 years", [page("[browser #1] open @ lab.example/x1\nThe X1 held up after 10 years.", null, { toolName: SHELL })])).toEqual({ status: "found" });
  });

  it("catches an invented quote on a page nobody opened", () => {
    expect(one("never wears out", [page("The X1 held up after 10 years.", OTHER_PAGE)], NEVER_OPENED)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(one("never wears out", [], NEVER_OPENED)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    expect(one("...", [page("...", OTHER_PAGE)], NEVER_OPENED)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("calls a quote missing from a page that really was fetched not verbatim, which is no invention", () => {
    expect(one("held up after a decade", [page("The X1 held up after 10 years.")])).toEqual({ status: "not_verbatim" });
    // The fragment in a link does not name another page, and the address need not match in form.
    expect(one("held up after a decade", [page("The X1 held up after 10 years.", "HTTPS://LAB.EXAMPLE:443/x1")], `${LINK}#results`)).toEqual({ status: "not_verbatim" });
  });

  it("does not take a search snippet for an opened page", () => {
    const search = page("held up after 10 years", null, { toolName: "search_selected_engines" });
    expect(one("held up after 10 years", [search], NEVER_OPENED)).toEqual({ reason: "search_snippet_only", status: "unsupported" });
    expect(one("held up after 10 years", [search, page("The X1 held up after 10 years.")])).toEqual({ status: "found" });
  });

  it.each([SHELL, "mcp__notes__read"])("does not take %s output for a page: a quote there is not checked, never found", (toolName) => {
    expect(one("held up after 10 years", [page("echo held up after 10 years", null, { toolName })], NEVER_OPENED)).toEqual({ reason: "other_tool_output", status: "not_checked" });
    // Not there either: nothing explains it.
    expect(one("never wears out", [page("echo held up", null, { toolName })], NEVER_OPENED)).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("ignores what an agent wrote itself", () => {
    expect(one("held up after 10 years", [page("a report quoting: held up after 10 years", null, { toolName: "call_subagent" })], NEVER_OPENED))
      .toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("reads saved results stringified once or twice", () => {
    const saved = JSON.stringify({ text: "She said: \"it held up\"\nafter 10\tyears — and more", url: LINK });
    expect(one("She said: \"it held up\" after 10 years - and more", [page(saved)])).toEqual({ status: "found" });
    expect(one("She said: \"it held up\" after 10 years - and more", [page(JSON.stringify({ output: saved }))])).toEqual({ status: "found" });
    expect(one("caf\u00e9 au lait", [page("caf\\u00e9 au lait")])).toEqual({ status: "found" });
  });

  it("tolerates what copying changes and still misses different words", () => {
    const text = "«Матрас» выдержал 10\u00a0лет — без про\u00adсадки, **как обещано**, см. [отчёт](https://lab.example/r). Ре\uFB01нанс.";
    for (const quote of ["\"Матрас\" выдержал 10 лет - без просадки", "Матрас\" выдержал", "как обещано, см. отчёт.", "выдержал 10 лет … как обещано", "“Матрас” выдержал [...] без просадки", "Реfiнанс"]) {
      expect(one(quote, [page(text, OTHER_PAGE)], NEVER_OPENED), quote).toEqual({ status: "found" });
    }
    expect(one("выдержал 20 лет", [page(text, OTHER_PAGE)], NEVER_OPENED)).toMatchObject({ status: "unsupported" });
    // Out of order is no quote of this page.
    expect(one("как обещано ... выдержал", [page(text, OTHER_PAGE)], NEVER_OPENED)).toMatchObject({ status: "unsupported" });
  });

  it("keeps case and symbols, since they carry meaning", () => {
    const opened = [page("Its laser draws 1 mW at 5' and covers 10 m².")];
    expect(one("1 mW", opened)).toEqual({ status: "found" });
    for (const quote of ["1 MW", "at 5\"", "10 m2", "ITS LASER"]) expect(one(quote, opened), quote).toEqual({ status: "not_verbatim" });
    expect(one("1 MW", [page("Its laser draws 1 mW.", OTHER_PAGE)], NEVER_OPENED)).toMatchObject({ status: "unsupported" });
  });

  it("says not checked, never unsupported, for a page read through the browser and not stored", () => {
    const steps = page("Running.\n[browser #3 · lab] open @ www.lab.example/x1\n[browser #4 · lab] click: button \"Next\" @ lab.example/x2\nSaved to a file.", null, { toolName: SHELL });
    expect(one("held up after 10 years", [steps])).toEqual({ reason: "browser_page", status: "not_checked" });
    expect(one("held up after 10 years", [page(JSON.stringify({ stdout: "[browser #3] open @ lab.example/x1\n" }), null, { toolName: SHELL })])).toEqual({ reason: "browser_page", status: "not_checked" });
    // A browser on another site says nothing of this link.
    expect(one("held up after 10 years", [steps], "https://shop.example/x1")).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
    // Page text that looks like a step is indented by the helper, so it is no step.
    expect(one("held up after 10 years", [page("  [browser #3] open @ lab.example/x1", OTHER_PAGE)])).toEqual({ reason: "not_in_opened_text", status: "unsupported" });
  });

  it("says not checked when the source that could hold the quote is only an excerpt", () => {
    expect(one("held up after 10 years", [page("excerpt", LINK, { partial: true })])).toEqual({ reason: "partial_source", status: "not_checked" });
    expect(one("held up after 10 years", [page("excerpt", null, { partial: true, toolName: SHELL })])).toEqual({ reason: "partial_source", status: "not_checked" });
    // An excerpt of another page or of a search says nothing of this one.
    expect(one("held up after 10 years", [page("excerpt", OTHER_PAGE, { partial: true })])).toMatchObject({ status: "unsupported" });
    expect(one("held up after 10 years", [page("excerpt", null, { partial: true, toolName: "search_engine_1" })])).toMatchObject({ status: "unsupported" });
    // What an excerpt does hold is still found.
    expect(one("excerpt", [page("the excerpt", LINK, { partial: true })])).toEqual({ status: "found" });
  });

  it("says not checked when the run's text could not be read or is over what one check reads", () => {
    expect(one("held up", null)).toEqual({ reason: "sources_unreadable", status: "not_checked" });
    const many = Array.from({ length: RESEARCH_SOURCE_LIMITS.results }, () => page("x", OTHER_PAGE));
    expect(one("held up", many, NEVER_OPENED)).toEqual({ reason: "sources_over_limit", status: "not_checked" });
  });

  it("normalizes both sides alike", () => {
    expect(normalizeQuotedText(" A\u00a0\u2014\u00a0B\\n«C» ")).toBe("A - B \"C\"");
    expect(normalizeQuotedText("\\\\\"x\\\\\"")).toBe("\"x\"");
    expect(normalizeQuotedText("‘a’ m²")).toBe("'a' m²");
  });
});

describe("what the sources read of a run", () => {
  const threads = (items: TranscriptItem[]) => ({ backgroundRunIds: async () => [], threadEffectItems: async () => [{ items, threadId: "t" }] });
  const read = async (items: TranscriptItem[], savedResults: Parameters<typeof createResearchSources>[0]["savedResults"] = { read: async () => null }) =>
    createResearchSources({ chatId: "c", items: () => [], runId: "r", savedResults, threads: threads(items), userId: "u" }).opened(new AbortController().signal);

  it("marks a long result whose saved copy failed as partial, so a real quote on it is not called invented", async () => {
    const whole = `start ${"x".repeat(TOOL_RESULT_LIMITS.inlineChars)} held up after 10 years ${"y".repeat(TOOL_RESULT_LIMITS.inlineChars)} end`;
    const excerpt = toolOutputExcerpt(whole, { unsavedReason: "saved_results_budget_reached" });
    expect(excerpt.handle).toBeNull();
    const opened = await read([
      { arguments: JSON.stringify({ url: LINK }), callId: "a", id: "a1", kind: "tool_call", name: "fetch_url" },
      { callId: "a", id: "a2", kind: "tool_result", name: "fetch_url", outcome: "complete", output: excerpt.output },
      { arguments: JSON.stringify({ url: OTHER_PAGE }), callId: "b", id: "b1", kind: "tool_call", name: "fetch_url" },
      { callId: "b", id: "b2", kind: "tool_result", name: "fetch_url", outcome: "complete", output: "short and whole" }
    ]);
    expect(opened.map((source) => source.partial)).toEqual([true, false]);
    expect(checkQuotes([finding("held up after 10 years")], opened)).toEqual([{ reason: "partial_source", status: "not_checked" }]);
  });

  it("marks what a browser command printed, step line or not, and nothing else", async () => {
    const opened = await read([
      { arguments: JSON.stringify({ command: "aiqsa-browser text" }), callId: "a", id: "a1", kind: "tool_call", name: SHELL },
      { callId: "a", id: "a2", kind: "tool_result", name: SHELL, outcome: "complete", output: "held up after 10 years" },
      { arguments: JSON.stringify({ command: "echo held up" }), callId: "b", id: "b1", kind: "tool_call", name: SHELL },
      { callId: "b", id: "b2", kind: "tool_result", name: SHELL, outcome: "complete", output: "held up" }
    ]);
    expect(opened.map((source) => researchEvidenceKind(source))).toEqual(["page", "other"]);
  });
});
