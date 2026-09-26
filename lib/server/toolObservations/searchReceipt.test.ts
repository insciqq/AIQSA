// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SEARCH_TOOL_RESULT_VERSION, searchExecutionsFromToolResult, searchToolResultContent,
  type SearchExecutionEvidence } from "../search/toolResult";
import type { ToolExecutionResult } from "../tools/types";
import { decodeSearchObservationReceipt, SEARCH_OBSERVATION_RECEIPT_BYTES, searchObservationReceipt } from "./searchReceipt";

/** PostgreSQL's jsonb text output, which its 64 KiB receipt check measures:
 * the same escaped values with a space after every ':' and ','. */
const jsonbText = (value: unknown): string => Array.isArray(value) ? `[${value.map(jsonbText).join(", ")}]`
  : value !== null && typeof value === "object"
    ? `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .map(([key, item]) => `${JSON.stringify(key)}: ${jsonbText(item)}`).join(", ")}}`
    : JSON.stringify(value);

type Shape = Readonly<{ sources?: number; snippet: number; title: number; url: number; letter?: string }>;
function searchResult(shape: Shape): ToolExecutionResult {
  const letter = shape.letter ?? "s";
  const executions: SearchExecutionEvidence[] = [1, 2, 3].map(engine => ({ displayName: `Engine ${engine}`,
    invocationId: `invocation-${engine}`, modelId: "model", optionId: `option-${engine}`, provider: "provider",
    revisionId: `revision-${engine}`, findings: `Synthetic findings ${engine}`, status: "complete",
    sources: Array.from({ length: shape.sources ?? 20 }, (_, index) => {
      const prefix = `https://example.com/${engine}/${index}/`;
      const title = `Result ${engine}-${index} `;
      return { rank: index + 1, title: title + "t".repeat(shape.title - title.length),
        url: prefix + "p".repeat(shape.url - prefix.length), snippet: letter.repeat(shape.snippet) };
    }),
    usage: { inputTokens: 100 * engine, outputTokens: engine, totalTokens: 100 * engine + engine,
      estimatedCostMicros: 12.5 * engine } }));
  return { callId: "synthetic-call", name: "search", status: "complete", content: searchToolResultContent(executions),
    rawPreview: { providerCall: true, searchResultVersion: SEARCH_TOOL_RESULT_VERSION, searchExecutions: executions } };
}

const snippetLengths = (receipt: ReturnType<typeof searchObservationReceipt>) =>
  [...new Set(receipt.executions.flatMap(execution => execution.sources.map(source => Array.from(source.snippet ?? "").length)))];

describe("bounded Search receipt", () => {
  it("keeps every thread source and snippet of an ordinary three-engine result exactly as Off persists them", () => {
    const result = searchResult({ snippet: 300, title: 120, url: 400 });
    const receipt = searchObservationReceipt(result);
    // Off persists each execution's own normalized sources as SearchRun rows.
    const off = searchExecutionsFromToolResult(result);
    expect(receipt.executions.map(execution => execution.sources)).toEqual(off.map(execution => execution.sources));
    expect(receipt.executions.map(execution => execution.sources.length)).toEqual([20, 20, 20]);
    expect(receipt.executions.map(execution => execution.usage)).toEqual(off.map(execution => execution.usage));
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(SEARCH_OBSERVATION_RECEIPT_BYTES);
    expect(Buffer.byteLength(jsonbText(receipt))).toBeLessThanOrEqual(65536);
  });

  it.each([
    { label: "long snippets are shortened to 300", shape: { snippet: 1000, title: 120, url: 400 }, snippets: [300], sources: 20 },
    { label: "two-byte snippets are shortened to 150", shape: { snippet: 300, title: 120, url: 400, letter: "ж" }, snippets: [150], sources: 20 },
    { label: "snippets are dropped before any source", shape: { snippet: 2000, title: 450, url: 480 }, snippets: [0], sources: 20 },
    { label: "trailing sources go last", shape: { snippet: 2000, title: 500, url: 1500 }, snippets: [0], sources: 9 }
  ])("degrades in order when the bound is hit: $label", ({ shape, snippets, sources }) => {
    const result = searchResult(shape);
    const receipt = searchObservationReceipt(result);
    expect(snippetLengths(receipt)).toEqual(snippets);
    expect(receipt.executions.map(execution => execution.sources.length)).toEqual([sources, sources, sources]);
    // Usage is never traded for sources, and each kept source keeps its identity.
    expect(receipt.executions.map(execution => execution.usage.totalTokens)).toEqual([101, 202, 303]);
    const off = searchExecutionsFromToolResult(result);
    expect(receipt.executions.map(execution => execution.sources.map(({ rank, title, url }) => ({ rank, title, url }))))
      .toEqual(off.map(execution => execution.sources.slice(0, sources).map(({ rank, title, url }) => ({ rank, title, url }))));
    const shortened = receipt.executions[0]!.sources[0]!.snippet;
    if (snippets[0]! > 0) expect(shortened?.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(SEARCH_OBSERVATION_RECEIPT_BYTES);
    expect(Buffer.byteLength(jsonbText(receipt))).toBeLessThanOrEqual(65536);
    expect(decodeSearchObservationReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
  });

  it("never splits a code point when it shortens a snippet", () => {
    const receipt = searchObservationReceipt(searchResult({ sources: 12, snippet: 400, title: 120, url: 400, letter: "😀" }));
    const snippet = receipt.executions[0]!.sources[0]!.snippet!;
    expect(snippet).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u);
    expect(Array.from(snippet)).toHaveLength(150);
  });

  it("decodes receipts written under the earlier 32 KiB bound, including reordered keys", () => {
    // An earlier receipt dropped every snippet; PostgreSQL returns keys in its own order.
    const earlier = { version: 1, executions: [{ usage: { totalTokens: 11, outputTokens: 1, inputTokens: 10 }, status: "complete",
      sources: [{ url: "https://example.com/1", title: "Title 1", rank: 1 }, { url: "https://example.com/2", title: "Title 2", rank: 2 }],
      revisionId: "revision-1", provider: "provider", optionId: "option-1", modelId: null, invocationId: "invocation-1",
      displayName: "Engine 1" }] };
    expect(decodeSearchObservationReceipt(earlier)).toMatchObject({ version: 1, executions: [{ displayName: "Engine 1",
      invocationId: "invocation-1", modelId: null, optionId: "option-1", provider: "provider", revisionId: "revision-1",
      sources: [{ rank: 1, title: "Title 1", url: "https://example.com/1" }, { rank: 2, title: "Title 2", url: "https://example.com/2" }],
      status: "complete", usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } }] });
  });

  it("keeps jsonb separator overhead far below the check's headroom at the largest receipt shape", () => {
    // Three executions of 20 dated sources with every usage field present.
    const receipt = searchObservationReceipt(searchResult({ snippet: 10, title: 30, url: 40 }));
    const dated = { ...receipt, executions: receipt.executions.map(execution => ({ ...execution,
      sources: execution.sources.map(source => ({ ...source, date: "2026-09-26" })) })) };
    const overhead = Buffer.byteLength(jsonbText(dated)) - Buffer.byteLength(JSON.stringify(dated));
    expect(overhead).toBeLessThan(1024);
    expect(SEARCH_OBSERVATION_RECEIPT_BYTES + overhead).toBeLessThanOrEqual(65536);
  });
});
