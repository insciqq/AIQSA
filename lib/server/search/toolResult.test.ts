import { describe, expect, it } from "vitest";
import { LEGACY_SEARCH_TOOL_RESULT_VERSION, SEARCH_FAIR_SHARE_FIRST_SOURCES, searchToolResultFairShare } from "./toolResult";
import { failedSearchEngine, proseFindings, searchEngine, searchResult, threeEngineResult } from "./toolResult.testFixtures";
import type { ToolExecutionResult } from "../tools/types";

const BUDGET = 16_000;

function textOf(result: ToolExecutionResult): string {
  const [content] = result.content;
  if (content?.type !== "text") throw new Error("search result without text");
  return content.text;
}

/** The verbatim parts of a fair share: its text without the notes it adds. */
function keptParts(shared: string): string[] {
  return shared.split(/\n?\[(?:Search source|Sources for) "[^"]+": [^\]]*\]/u).flatMap((part) => part.split("\n\n"))
    .map((part) => part.trim()).filter(Boolean);
}

describe("a merged search result's fair share", () => {
  it("shows every engine's findings and the source lines they cite within the budget", () => {
    const result = threeEngineResult();
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(60_000);
    const shared = searchToolResultFairShare(result, text, BUDGET)!;
    expect(shared.shown).toBeLessThanOrEqual(BUDGET);
    // Notes are the only additions, and they are short.
    expect(shared.text.length).toBeLessThan(BUDGET + 1_000);
    for (const name of ["OpenAI", "Perplexity", "DeepSeek"]) expect(shared.text).toContain(`Search source "${name}":\n`);
    // The two small engines fit whole; the large one takes what they leave.
    const openAi = text.slice(0, text.indexOf("\n\nSearch source \"Perplexity\""));
    const perplexity = text.slice(text.indexOf("Search source \"Perplexity\""), text.indexOf("\n\nSearch source \"DeepSeek\""));
    expect(shared.text.startsWith(`${openAi}\n\n${perplexity}\n\n`)).toBe(true);
    const deepSeek = shared.text.slice(shared.text.indexOf("Search source \"DeepSeek\""));
    // Whole DeepSeek entries: the shown findings end right before the next entry of the saved text.
    const note = /\[Search source "DeepSeek": findings cut here, (\d+) of (\d+) characters shown; the rest starts at offset (\d+) of the saved result\.\]/u
      .exec(deepSeek)!;
    expect(note).not.toBeNull();
    expect(text.slice(Number(note[3]))).toMatch(/^\n\n\[\d+\] DeepSeek source \d+ — /u);
    const shownEntries = [...deepSeek.slice(0, note.index).matchAll(/^\[(\d+)\] DeepSeek source \d+ — /gmu)].map((match) => Number(match[1]));
    expect(shownEntries.length).toBeGreaterThan(5);
    expect(shownEntries.length).toBeLessThan(50);
    // Each cited source line is there, beside the first few, and the cut list names where the whole list starts.
    for (const number of shownEntries) expect(deepSeek).toContain(`\n[${number}] DeepSeek source ${number} — https://deepseek.example/page-${number}`);
    expect(deepSeek).not.toContain(`[${shownEntries.length + 1}] DeepSeek source ${shownEntries.length + 1} — https://`);
    const list = /\[Sources for "DeepSeek": (\d+) of 50 shown, the first \d+ and those the shown findings cite; the whole list starts at offset (\d+) of the saved result\.\]/u
      .exec(deepSeek)!;
    expect(Number(list[1])).toBe(Math.max(shownEntries.length, SEARCH_FAIR_SHARE_FIRST_SOURCES));
    expect(text.slice(Number(list[2]))).toMatch(/^Sources for "DeepSeek":\n\[1\] /u);
    // Every kept part is the saved text verbatim.
    for (const part of keptParts(shared.text)) expect(text).toContain(part);
  });

  it("splits the budget evenly among blocks that all exceed their share, cutting prose at a paragraph", () => {
    const result = searchResult(["A", "B", "C"].map((name) => searchEngine({ count: 12, displayName: name,
      findings: proseFindings(name, 30_000, 12), host: `${name.toLowerCase()}.example`, optionId: name })));
    const text = textOf(result);
    const shared = searchToolResultFairShare(result, text, BUDGET)!;
    expect(shared.shown).toBeLessThanOrEqual(BUDGET);
    const shares = ["A", "B", "C"].map((name) => {
      const start = shared.text.indexOf(`Search source "${name}":\n`);
      const next = shared.text.indexOf("\n\nSearch source \"", start + 1);
      return shared.text.slice(start, next < 0 ? undefined : next);
    });
    for (const share of shares) {
      expect(share.length).toBeGreaterThan(BUDGET / 3 - 1_000);
      expect(share.length).toBeLessThan(BUDGET / 3 + 600);
      expect(share).toMatch(/\.\n\[Search source "[ABC]": findings cut here/u);
    }
    for (const part of keptParts(shared.text)) expect(text).toContain(part);
  });

  it("keeps short findings whole and cuts a long source list to the first few and the cited ones", () => {
    const result = searchResult(["A", "B"].map((name) => searchEngine({ count: 400, displayName: name,
      findings: `${name} found it in [7] and [250].`, host: `${name.toLowerCase()}.example`, optionId: name })));
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(24_000);
    const shared = searchToolResultFairShare(result, text, BUDGET)!;
    expect(shared.shown).toBeLessThanOrEqual(BUDGET);
    for (const name of ["A", "B"]) {
      expect(shared.text).toContain(`Search source "${name}":\n${name} found it in [7] and [250].\n\nSources for "${name}":\n[1] `);
      for (const number of [1, 2, 3, 7, 250]) expect(shared.text).toContain(`[${number}] ${name} source ${number} — `);
      expect(shared.text).not.toContain(`[4] ${name} source 4 — `);
      expect(shared.text).toContain(`[Sources for "${name}": 5 of 400 shown`);
    }
  });

  it("keeps a failed engine's warning and leaves engines without findings out of the split", () => {
    const result = searchResult([
      searchEngine({ count: 4, displayName: "A", findings: proseFindings("A", 20_000, 4), host: "a.example", optionId: "a" }),
      failedSearchEngine("B", "b"),
      searchEngine({ count: 4, displayName: "C", findings: proseFindings("C", 20_000, 4), host: "c.example", optionId: "c" })
    ]);
    const text = textOf(result);
    const shared = searchToolResultFairShare(result, text, BUDGET)!;
    expect(shared.text.endsWith("Search warnings: \"B\": provider_rate_limited")).toBe(true);
    expect(shared.shown).toBeLessThanOrEqual(BUDGET);
  });

  it("gives the same output for the same input", () => {
    const first = threeEngineResult();
    const second = threeEngineResult();
    expect(searchToolResultFairShare(first, textOf(first), BUDGET)).toEqual(searchToolResultFairShare(second, textOf(second), BUDGET));
  });

  it("declines a single engine, a legacy result, a text that is not the result's own, and a result that is no search", () => {
    const single = searchResult([searchEngine({ count: 4, displayName: "A", findings: proseFindings("A", 40_000, 4), host: "a.example",
      optionId: "a" })]);
    expect(searchToolResultFairShare(single, textOf(single), BUDGET)).toBeNull();
    const merged = threeEngineResult();
    expect(searchToolResultFairShare({ ...merged, rawPreview: { ...merged.rawPreview, searchResultVersion: LEGACY_SEARCH_TOOL_RESULT_VERSION } },
      textOf(merged), BUDGET)).toBeNull();
    expect(searchToolResultFairShare(merged, `${textOf(merged)}\n\nappended`, BUDGET)).toBeNull();
    expect(searchToolResultFairShare({ callId: "c", content: merged.content, name: "lookup", status: "complete" }, textOf(merged), BUDGET))
      .toBeNull();
  });
});
