import { describe, expect, it, vi } from "vitest";
import { RESEARCHER_CONTEXT_CLEARING } from "../../contracts/research";
import { planToolResultClearing } from "../engine/compaction";
import type { TranscriptItem } from "../engine/transcript";
import { createResearchAgentSources, createResearchSources } from "./sources";

const handle = (index: number) => `tor1_${index.toString(16).padStart(32, "0")}`;

describe("what the sources read of a researcher whose old pages were cleared", () => {
  it("reads each page once, whole from its saved copy, and never the stub that stands for it", async () => {
    const items: TranscriptItem[] = [{ id: "brief", kind: "user", text: "Compare mattresses." }];
    for (let index = 1; index <= 8; index += 1) {
      items.push({ arguments: JSON.stringify({ url: `https://shop.example/${index}` }), callId: `c${index}`, id: `call-${index}`, kind: "tool_call", name: "fetch_url" },
        { callId: `c${index}`, handle: handle(index), id: `result-${index}`, kind: "tool_result", name: "fetch_url", outcome: "complete", output: `page ${index} ${"p".repeat(40_000)}` });
    }
    let next = 0;
    const cleared = planToolResultClearing({ estimate: (value) => String(value).length, items, nextId: () => `stub-${++next}`, policy: RESEARCHER_CONTEXT_CLEARING,
      target: { model: "m", provider: "p" }, tokens: 330_000 })!;
    expect(cleared.items.length).toBeGreaterThan(0);
    const read = vi.fn(async ({ handle: wanted }: { handle: string }) => ({ arguments: {}, text: `whole ${wanted}`, toolName: "fetch_url" }));
    const opened = await createResearchSources({ chatId: "c", items: () => [], run: { branchRunIds: [], researchRunId: "r", runId: "r" }, savedResults: { read },
      threads: { backgroundRunIds: async () => [], threadEffectItems: async () => [{ items: [...items, ...cleared.items], threadId: "t" }] }, userId: "u" })
      .opened(new AbortController().signal);
    expect(opened.map((source) => source.url)).toEqual(Array.from({ length: 8 }, (_, index) => `https://shop.example/${index + 1}`));
    expect(opened.map((source) => source.text)).toEqual(Array.from({ length: 8 }, (_, index) => `whole ${handle(index + 1)}`));
    expect(read).toHaveBeenCalledTimes(8);
  });
});

describe("what one write reads of its own agent's pages", () => {
  it("finds a page read through a search's link with OpenAI's attribution for a record that cites the source's own link, and the other way round", async () => {
    // fetch_url requests the authorized link without utm_* and keeps the asked one as the page's name (`fetchUrl.ts`).
    const source = "https://www.shop.example/product/sleep-medium-2850683628/?at=1hWp";
    const asked = `${source}&utm_source=openai`;
    const call = { arguments: { url: asked }, id: "call", observationId: null, providerCallId: "provider-call", toolName: "fetch_url",
      result: { callId: "provider-call", content: [{ type: "json", value: { finalUrl: "https://www.shop.example/product/sleep-medium-2850683628/", text: "Sleep Medium, 120 kg.", truncated: false, url: asked } }],
        name: "fetch_url", status: "complete" } };
    const sources = createResearchAgentSources({ calls: { calls: async () => [call], fetchCalls: async () => [call], recentCalls: async () => [] }, chatId: "c",
      savedResults: { read: async () => null }, userId: "u" });
    const agent = { runIds: ["r"], threadId: "thread-lab" };
    for (const cited of [source, asked]) {
      const found = await sources.cited(agent, new Set([cited]), new AbortController().signal);
      expect(found.sources.map((page) => [page.url, page.text])).toEqual([[cited, "Sleep Medium, 120 kg."]]);
    }
    expect((await sources.cited(agent, new Set(["https://www.shop.example/product/sleep-medium-2850683628/?at=other"]), new AbortController().signal)).sources).toEqual([]);
  });
});
