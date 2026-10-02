import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { syntheticAnswer } from "./syntheticAnswer";

/**
 * Parse+render budget of the chat Markdown renderer: the synchronous
 * `renderToStaticMarkup` of a streaming `MarkdownMessage`. Each pass renders the
 * whole message as it stands after one simulated 50 ms streaming batch; KaTeX and
 * Shiki run asynchronously after mount and are excluded by construction.
 */
const BATCHES = 40;
const WARMUP_PASSES = 10;

const budgets = [
  { characters: 20_000, medianMs: 8 },
  { characters: 200_000, medianMs: 60 }
];

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function timeRender(content: string): number {
  const started = performance.now();
  renderToStaticMarkup(<MarkdownMessage content={content} streaming />);
  return performance.now() - started;
}

describe("Markdown parse+render budget", () => {
  it.each(budgets)("renders a $characters-character answer within $medianMs ms per streaming batch", ({ characters, medianMs }) => {
    const answer = syntheticAnswer(characters);
    const batches = Array.from({ length: BATCHES }, (_, index) =>
      answer.slice(0, Math.ceil((answer.length * (index + 1)) / BATCHES)));
    for (let pass = 0; pass < WARMUP_PASSES; pass++) timeRender(batches[pass % BATCHES]);

    const streamingMedian = median(batches.map(timeRender));
    const completeMedian = median(batches.map(() => timeRender(answer)));
    console.log(JSON.stringify({
      batches: BATCHES,
      budgetMs: medianMs,
      characters: answer.length,
      completeAnswerMedianMs: Number(completeMedian.toFixed(2)),
      streamingBatchMedianMs: Number(streamingMedian.toFixed(2))
    }));

    expect(streamingMedian).toBeLessThanOrEqual(medianMs);
  });
});
