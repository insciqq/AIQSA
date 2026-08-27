/* eslint-disable */
// THROWAWAY verification harness - deleted before completion. Compares this
// repo's pure-JS Qwen2 BPE counter against reference counts produced by the
// official HuggingFace tokenizers 0.23.1 runtime with the exact pinned
// tokenizer.json (Qwen/Qwen3-Embedding-8B @ 1d8ad4ca).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { qwen2BpeTokenCounter } from "./qwen2BpeTokenizer";

const SCRATCH =
  "/tmp/claude-1000/-home-dtulnov-main-personal-claude-code-AIQSA-SECOND-WORKSPACE/3de0f5a6-50d5-4243-9ba8-514c857a3879/scratchpad/";

describe("qwen2 bpe cross-check", () => {
  it("matches official reference counts on the fixture set", () => {
    const fixtures = JSON.parse(
      readFileSync(`${SCRATCH}reference-counts.json`, "utf8")
    ) as Array<{ count: number; label: string | null; text: string }>;
    const counter = qwen2BpeTokenCounter();
    const mismatches = fixtures
      .map((fixture) => ({
        ...fixture,
        actual: counter.countTokens(fixture.text)
      }))
      .filter((fixture) => fixture.actual !== fixture.count);
    expect(mismatches).toEqual([]);
  });

  it("matches official reference counts on 605 random multilingual samples", () => {
    const samples = JSON.parse(
      readFileSync(`${SCRATCH}cross-corpus.json`, "utf8")
    ) as Array<{ count: number; text: string }>;
    const counter = qwen2BpeTokenCounter();
    const started = Date.now();
    let mismatched = 0;
    for (const sample of samples) {
      if (counter.countTokens(sample.text) !== sample.count) {
        mismatched += 1;
        // eslint-disable-next-line no-console
        console.log("MISMATCH", JSON.stringify(sample.text.slice(0, 80)),
          "expected", sample.count, "actual", counter.countTokens(sample.text));
        if (mismatched > 5) break;
      }
    }
    // eslint-disable-next-line no-console
    console.log("cross-check duration ms:", Date.now() - started);
    expect(mismatched).toBe(0);
  });
});
