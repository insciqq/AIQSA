import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseKnowledgeRetrievalCli, prepareRetrievalCheckpoint, readCachedEmbedding } from "./retrieve";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
});

const args = [
  "--confirm-paid", "BRIGHT_RETRIEVAL", "--suite", "bright-stackoverflow-50m",
  "--config", "A"
];

describe("retrieval canary recovery", () => {
  it("distinguishes a missing embedding cache from corrupt paid work", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-embedding-cache-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "cache.json");
    await expect(readCachedEmbedding(path)).resolves.toBeNull();
    const valid = {
      dimension: 1_024, inputTokens: 12, totalTokens: 12,
      vector: Array.from({ length: 1_024 }, () => 0.125)
    };
    await writeFile(path, JSON.stringify(valid));
    await expect(readCachedEmbedding(path)).resolves.toEqual(valid);
    for (const corrupt of [
      "{", "null", JSON.stringify({ ...valid, dimension: 1_536 }),
      JSON.stringify({ ...valid, inputTokens: -1 }),
      JSON.stringify({ ...valid, vector: [null, ...valid.vector.slice(1)] }),
      JSON.stringify({ ...valid, extra: true })
    ]) {
      await writeFile(path, corrupt);
      await expect(readCachedEmbedding(path)).rejects.toThrow(
        "knowledge_benchmark_embedding_cache_invalid"
      );
    }
  });

  it("keeps an explicit five-query cap on resume and requires an output identity", () => {
    expect(parseKnowledgeRetrievalCli([
      ...args, "--query-limit", "5", "--output", "results/smoke", "--resume"
    ])).toMatchObject({ queryLimit: 5, resume: true, concurrency: 1 });
    expect(() => parseKnowledgeRetrievalCli([
      ...args, "--query-limit", "5", "--resume"
    ])).toThrow("knowledge_benchmark_resume_selection_invalid");
    expect(() => parseKnowledgeRetrievalCli([
      ...args, "--query-limit", "5", "--query-id", "one"
    ])).toThrow("knowledge_benchmark_query_selection_ambiguous");
  });

  it("pins the selected queries before any outcome and refuses selection drift", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "aiqsa-retrieval-checkpoint-"));
    temporaryDirectories.push(outputDirectory);
    const options = {
      manifestFingerprint: "a".repeat(64),
      outputDirectory,
      queries: [{ officialId: "one", text: "Synthetic query", relevant: { source: 1 } }],
      resume: false,
      runId: "synthetic-canary",
      schedule: { concurrency: 1, queryStartIntervalMs: 0, rateLimitCooldownMs: 0 }
    };
    const original = await prepareRetrievalCheckpoint(options);
    const resumed = await prepareRetrievalCheckpoint({ ...options, resume: true });
    expect(resumed.runId).toBe(original.runId);
    expect(resumed.resumedOutcomes.size).toBe(0);
    const header = await readFile(join(outputDirectory, "retrieval-checkpoint.json"), "utf8");
    expect(header).not.toContain("Synthetic query");
    await expect(prepareRetrievalCheckpoint({
      ...options,
      queries: [{ ...options.queries[0]!, officialId: "two" }],
      resume: true
    })).rejects.toThrow("knowledge_benchmark_retrieval_checkpoint_mismatch");
    await expect(prepareRetrievalCheckpoint({
      ...options,
      queries: [{ ...options.queries[0]!, text: "Changed synthetic query" }],
      resume: true
    })).rejects.toThrow("knowledge_benchmark_retrieval_checkpoint_mismatch");
    await expect(prepareRetrievalCheckpoint(options))
      .rejects.toThrow("knowledge_benchmark_retrieval_checkpoint_output_not_empty");
  });
});
