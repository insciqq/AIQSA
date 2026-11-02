import { describe, expect, it, vi } from "vitest";
import { RESEARCHER_CONTEXT_CLEARING } from "../../contracts/research";
import { planToolResultClearing } from "../engine/compaction";
import type { TranscriptItem } from "../engine/transcript";
import { createResearchSources } from "./sources";

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
