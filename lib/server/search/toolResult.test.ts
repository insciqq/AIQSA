import { describe, expect, it } from "vitest";
import { CITED_SEARCH_TOOL_RESULT_VERSION, rehydratePersistedSearchToolExecutionResult, SEARCH_ENTRY_EXCERPT_CHARACTERS,
  SEARCH_FAIR_SHARE_FIRST_SOURCES, SEARCH_RESULT_LIST_FINDINGS, searchExecutionsFromToolResult, searchToolResultEntrySpans,
  searchToolResultFairShare, searchToolResultText, type SearchExecutionEvidence } from "./toolResult";
import { deepSeekEngine, failedSearchEngine, proseFindings, searchEngine, searchResult, threeEngineResult } from "./toolResult.testFixtures";
import type { ToolExecutionResult } from "../tools/types";
import { parsePersistedToolExecutionResult, snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { toolLoopPersistenceLimits } from "../runs/toolLoopPersistence";

const BUDGET = 16_000;
const usage = { inputTokens: 3, outputTokens: 4, reasoningTokens: 0, totalTokens: 7 };

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

/** Every entry heading `[n] <name> source n — ` in `text` with the line after it, which must be its own URL. */
function entriesOf(text: string, name: string, host: string): number[] {
  const numbers: number[] = [];
  for (const match of text.matchAll(new RegExp(`^\\[(\\d+)\\] ${name} source (\\d+) — [^\\n]*\\n([^\\n]*)`, "gmu"))) {
    expect(match[1]).toBe(match[2]);
    expect(match[3]).toBe(`https://${host}/page-${match[1]}`);
    numbers.push(Number(match[1]));
  }
  return numbers;
}

describe("a search result's entries", () => {
  it("render each source as its number, title, site, date, URL and bounded excerpt", () => {
    const engine: SearchExecutionEvidence = { displayName: "Engine", findings: "Prices rose [1].", invocationId: "c1:e", modelId: "m",
      optionId: "e", provider: "openrouter", revisionId: "r", status: "complete", usage, sources: [
        { citation: 1, date: "2026-11-20T08:00:00+08:00", rank: 1, snippet: "Line one\n\nline   two.", title: "Report\nof prices",
          url: "https://www.example.com/report" },
        { rank: 2, snippet: `${"word ".repeat(600)}end`, title: "Long page", url: "https://news.example.org/long" },
        { rank: 3, title: "example.net", url: "https://example.net/" },
        { date: "November 2026", rank: 4, title: "Dated", url: "https://dated.example/a" }
      ] };
    const text = searchToolResultText([engine]);
    const entries = text.split("\n\n");
    expect(entries.slice(0, 3)).toEqual([
      'Search source "Engine":\nPrices rose [1].',
      'Sources for "Engine":\n[1] Report of prices — example.com, 2026-11-20\nhttps://www.example.com/report\nLine one line two.',
      expect.stringMatching(/^\[2\] Long page — news\.example\.org\nhttps:\/\/news\.example\.org\/long\nword word .*…$/u)
    ]);
    expect(entries[2]!.split("\n")[2]!.length).toBeLessThanOrEqual(SEARCH_ENTRY_EXCERPT_CHARACTERS);
    // A title that is the site names it once; a date that is no ISO time stays as given.
    expect(entries.slice(3)).toEqual(["[3] example.net\nhttps://example.net/", "[4] Dated — dated.example, November 2026\nhttps://dated.example/a"]);
  });

  it("show a result list as its entries alone, and the server's words for an empty one", () => {
    const list = deepSeekEngine(2, 47, "DeepSeek Search API");
    expect(searchToolResultText([list])).toBe('Search source "DeepSeek Search API":\n' +
      "[1] DeepSeek Search API source 1 — deepseek.example\nhttps://deepseek.example/page-1\nEntry 1 says model M-1 costs 1001 EUR. detail 1\n\n" +
      "[2] DeepSeek Search API source 2 — deepseek.example\nhttps://deepseek.example/page-2\nEntry 2 says model M-2 costs 1002 EUR. detail 2");
    expect(searchToolResultText([list])).not.toContain(SEARCH_RESULT_LIST_FINDINGS);
    const failed = failedSearchEngine("Other", "other");
    expect(searchToolResultText([list, failed]).endsWith('\n\nSearch warnings: "Other": provider_rate_limited')).toBe(true);
    expect(searchToolResultText([failed])).toBe('Search warnings: "Other": provider_rate_limited');
  });

  it("name where each entry sits, so a cut can keep a URL with its result", () => {
    const result = searchResult([deepSeekEngine(5, 200)]);
    const text = textOf(result);
    const spans = searchToolResultEntrySpans(result, text)!;
    expect(spans).toHaveLength(5);
    for (const [index, [start, end]] of spans.entries()) {
      expect(text.slice(start, end)).toMatch(new RegExp(`^\\[${index + 1}\\] DeepSeek source ${index + 1} — [^\\n]+\\nhttps://deepseek\\.example/page-${index + 1}\\n`, "u"));
    }
    expect(searchToolResultEntrySpans(result, `${text} `)).toBeNull();
  });
});

describe("an answer that searched before results became entries", () => {
  // As the executor stored a DeepSeek Search API result between 2026-11-03 and 2026-11-26: version 3, the summaries as findings.
  const saved = {
    callId: "call-1", name: "search_engine_1", status: "complete" as const,
    content: [{ type: "json" as const, value: { aiqsaType: "search_result", version: CITED_SEARCH_TOOL_RESULT_VERSION } }],
    rawPreview: { searchResultVersion: CITED_SEARCH_TOOL_RESULT_VERSION, searchExecutions: [{
      costUsd: 0.00075, displayName: "DeepSeek Search API",
      findings: "[1] Example headline — Example News · 2026-10-01\nThe longer summary the model reads.",
      invocationId: "call-1:deepseek-api", modelId: "deepseek-search-api", optionId: "deepseek-api", provider: "deepseek",
      revisionId: "revision-1", sourceAttribution: "available", status: "complete",
      sources: [{ citation: 1, date: "2026-10-01", rank: 1, snippet: "Short snippet.", title: "Example headline", url: "https://example.com/story" }],
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, webSearchCount: 1 }
    }] }
  };

  it("still decodes and renders exactly as it was saved", () => {
    const decoded = parsePersistedToolExecutionResult({ id: "call-1", name: "search_engine_1" }, saved)!;
    expect(decoded.content).toEqual([{ type: "text", text: [
      'Search source "DeepSeek Search API":\n[1] Example headline — Example News · 2026-10-01\nThe longer summary the model reads.',
      'Sources for "DeepSeek Search API":\n[1] Example headline — https://example.com/story'
    ].join("\n\n") }]);
    expect(searchExecutionsFromToolResult(decoded)).toEqual([expect.objectContaining({ costUsd: 0.00075,
      sources: saved.rawPreview.searchExecutions[0]!.sources })]);
    expect(rehydratePersistedSearchToolExecutionResult(saved)?.content).toEqual(decoded.content);
    expect(snapshotToolExecutionResult(decoded, toolLoopPersistenceLimits.resultBytes)).toEqual(saved);
    // A cut never reworks an old result: it falls back to the ordinary head and tail.
    expect(searchToolResultFairShare(decoded, textOf(decoded), BUDGET)).toBeNull();
    expect(searchToolResultEntrySpans(decoded, textOf(decoded))).toBeNull();
  });
});

describe("a search result's fair share", () => {
  it("shows every engine's findings and whole entries within the budget", () => {
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
    // Whole entries in rank order, each with its URL, then where the first one left out starts in the saved text.
    const shown = entriesOf(deepSeek, "DeepSeek", "deepseek.example");
    expect(shown).toEqual(Array.from({ length: shown.length }, (_, index) => index + 1));
    expect(shown.length).toBeGreaterThan(4);
    const note = /\[Search source "DeepSeek": (\d+) of 50 results shown \(1-(\d+)\); the first one left out, result (\d+), starts at offset (\d+) of the saved result\.\]$/u
      .exec(deepSeek)!;
    expect(note).not.toBeNull();
    expect([Number(note[1]), Number(note[2]), Number(note[3])]).toEqual([shown.length, shown.length, shown.length + 1]);
    expect(text.slice(Number(note[4]))).toMatch(new RegExp(`^\\[${shown.length + 1}\\] DeepSeek source ${shown.length + 1} — `, "u"));
    // Every kept part is the saved text verbatim.
    for (const part of keptParts(shared.text)) expect(text).toContain(part);
  });

  it("keeps every shown result's URL inside its entry when one engine's fifty results run long", () => {
    const result = searchResult([deepSeekEngine(50, SEARCH_ENTRY_EXCERPT_CHARACTERS + 400)]);
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(50 * SEARCH_ENTRY_EXCERPT_CHARACTERS);
    const shared = searchToolResultFairShare(result, text, BUDGET)!;
    expect(shared.shown).toBeLessThanOrEqual(BUDGET);
    const shown = entriesOf(shared.text, "DeepSeek", "deepseek.example");
    expect(shown).toEqual(Array.from({ length: shown.length }, (_, index) => index + 1));
    // About ten bounded entries fit what the model reads of a long result.
    expect(shown.length).toBeGreaterThanOrEqual(9);
    // No entry is cut: every one shown ends with its whole bounded excerpt.
    const spans = searchToolResultEntrySpans(result, text)!;
    for (const number of shown) expect(shared.text).toContain(text.slice(...spans[number - 1]!));
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

  it("keeps short findings whole and gives a long source list its first entries and the cited ones", () => {
    const result = searchResult(["A", "B"].map((name) => searchEngine({ count: 400, displayName: name,
      findings: `${name} found it in [7] and [250].`, host: `${name.toLowerCase()}.example`, optionId: name })));
    const text = textOf(result);
    expect(text.length).toBeGreaterThan(24_000);
    const shared = searchToolResultFairShare(result, text, BUDGET)!;
    expect(shared.shown).toBeLessThanOrEqual(BUDGET);
    for (const name of ["A", "B"]) {
      const block = shared.text.slice(shared.text.indexOf(`Search source "${name}":\n`));
      expect(block.startsWith(`Search source "${name}":\n${name} found it in [7] and [250].\n\nSources for "${name}":\n[1] `)).toBe(true);
      const own = block.slice(0, block.indexOf("]\n\nSearch source") + 1 || undefined);
      const shown = entriesOf(own, name, `${name.toLowerCase()}.example`);
      const last = shown.at(-2)!;
      expect(shown).toEqual([...Array.from({ length: last }, (_, index) => index + 1), 250]);
      expect(last).toBeGreaterThan(SEARCH_FAIR_SHARE_FIRST_SOURCES);
      expect(own).toContain(`[Sources for "${name}": ${last + 1} of 400 results shown (1-${last}, 250); the first one left out, result ${last + 1}, ` +
        "starts at offset");
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

  it("declines a result of an earlier version, a text that is not the result's own, and a result that is no search", () => {
    const merged = threeEngineResult();
    expect(searchToolResultFairShare({ ...merged, rawPreview: { ...merged.rawPreview, searchResultVersion: CITED_SEARCH_TOOL_RESULT_VERSION } },
      textOf(merged), BUDGET)).toBeNull();
    expect(searchToolResultFairShare(merged, `${textOf(merged)}\n\nappended`, BUDGET)).toBeNull();
    expect(searchToolResultFairShare({ callId: "c", content: merged.content, name: "lookup", status: "complete" }, textOf(merged), BUDGET))
      .toBeNull();
    const failed = searchResult([failedSearchEngine("A", "a")]);
    expect(searchToolResultFairShare(failed, textOf(failed), BUDGET)).toBeNull();
  });
});

describe("an answer that searched DeepSeek's retired hosted Search", () => {
  // As the executor stored it before 2026-10-24: findings without source links, beside an engine with sources.
  const retired: SearchExecutionEvidence = { displayName: "DeepSeek Search", findings: "Hosted DeepSeek findings.",
    invocationId: "c1:deepseek-native-web-search", modelId: "deepseek-v4-flash", optionId: "deepseek-native-web-search",
    protocol: "deepseek_responses_web_search", provider: "deepseek", revisionId: "revision-deepseek",
    sourceAttribution: "provider_unavailable", sources: [], status: "complete",
    usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 0, totalTokens: 7 }, warning: "provider_sources_unavailable" };
  const other = searchEngine({ count: 2, displayName: "OpenAI", findings: "OpenAI findings [1].", host: "openai.example",
    optionId: "openai", provider: "openai" });

  it("still rehydrates from its stored row with every engine and source", () => {
    const stored = searchResult([other, retired]);
    const snapshot = snapshotToolExecutionResult(stored, toolLoopPersistenceLimits.resultBytes);
    if (!snapshot) throw new Error("expected a stored search result");
    const parsed = parsePersistedToolExecutionResult({ id: stored.callId, name: stored.name }, snapshot);
    if (!parsed) throw new Error("expected the stored search result to parse");
    expect(parsed.content).toEqual(stored.content);
    expect(textOf(parsed)).toContain("Hosted DeepSeek findings.");
    expect(searchExecutionsFromToolResult(parsed)).toEqual([
      expect.objectContaining({ optionId: "openai", sources: other.sources }),
      expect.objectContaining({ optionId: "deepseek-native-web-search", sourceAttribution: "provider_unavailable", sources: [] })
    ]);
  });
});
