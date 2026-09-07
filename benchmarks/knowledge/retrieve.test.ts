import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimKnowledgeRetrievalQuery, parseKnowledgeRetrievalCli, prepareRetrievalCheckpoint, readCachedEmbedding,
  runKnowledgeRetrievalBatch } from "./retrieve";
import { KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION } from "./retrievalCheckpoint";

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
  it("requires bounded serial execution for private replay capture", () => {
    expect(parseKnowledgeRetrievalCli([...args, "--capture-replay", "--batch-size", "5"]))
      .toMatchObject({ captureReplay: true, batchSize: 5, concurrency: 1 });
    expect(parseKnowledgeRetrievalCli(args).captureReplay).toBe(false);
    for (const extra of [[], ["--batch-size", "5", "--concurrency", "2"],
      ["--batch-size", "5", "--preflight-only"]]) {
      expect(() => parseKnowledgeRetrievalCli([...args, "--capture-replay", ...extra]))
        .toThrow("knowledge_benchmark_replay_schedule_invalid");
    }
  });

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

  it("caps new work without reducing the frozen query selection", async () => {
    const options = parseKnowledgeRetrievalCli([...args, "--batch-size", "2", "--output", "results/full", "--resume"]);
    expect(options).toMatchObject({ batchSize: 2, queryLimit: undefined, queryIds: [], resume: true });
    for (const value of ["0", "6", "1.5", "", "NaN"]) {
      expect(() => parseKnowledgeRetrievalCli([...args, "--batch-size", value])).toThrow("batch_size_invalid");
    }
    const queries = ["first", "second", "third", "fourth", "fifth", "sixth"];
    const settled = new Map([[1, "second"], [5, "sixth"]]);
    const executed: number[] = [];
    const execute = vi.fn(async (query: string, index: number) => {
      executed.push(index); settled.set(index, query); return query;
    });
    const first = await runKnowledgeRetrievalBatch({ queries, resumedOutcomes: new Map(settled),
      batchSize: options.batchSize, concurrency: 1, execute });
    expect(executed).toEqual([0, 2]);
    expect(first).toEqual({ complete: false, outcomes: ["first", "second", "third", "sixth"] });
    const second = await runKnowledgeRetrievalBatch({ queries, resumedOutcomes: new Map(settled),
      batchSize: 2, concurrency: 1, execute });
    expect(executed).toEqual([0, 2, 3, 4]);
    expect(second).toEqual({ complete: true, outcomes: queries });
    expect(await runKnowledgeRetrievalBatch({ queries, resumedOutcomes: settled,
      batchSize: 2, concurrency: 1, execute })).toEqual(second);
    expect(execute).toHaveBeenCalledTimes(4);
    await expect(runKnowledgeRetrievalBatch({ queries, resumedOutcomes: new Map([[6, "invalid"]]),
      batchSize: 2, concurrency: 1, execute })).rejects.toThrow("retrieval_batch_invalid");
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it("refuses to repeat ambiguous admitted work but reuses a settled outcome", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "aiqsa-retrieval-admission-"));
    temporaryDirectories.push(outputDirectory);
    const query = { officialId: "one", text: "Synthetic query", relevant: { source: 1 } };
    const options = { manifestFingerprint: "a".repeat(64), outputDirectory, queries: [query],
      resume: false, runId: "synthetic-admission",
      schedule: { concurrency: 1, queryStartIntervalMs: 0, rateLimitCooldownMs: 0 } };
    const checkpoint = await prepareRetrievalCheckpoint(options);
    const claim = { outcomeDirectory: checkpoint.outcomeDirectory, queryIndex: 0,
      manifestFingerprint: options.manifestFingerprint };
    await claimKnowledgeRetrievalQuery(claim);
    await expect(claimKnowledgeRetrievalQuery(claim)).rejects.toThrow("query_claim_failed");
    await expect(prepareRetrievalCheckpoint({ ...options, resume: true })).rejects.toThrow("query_ambiguous");
    await writeFile(join(checkpoint.outcomeDirectory, "000000.json"), JSON.stringify({
      manifestFingerprint: options.manifestFingerprint, schemaVersion: KNOWLEDGE_RETRIEVAL_CHECKPOINT_SCHEMA_VERSION,
      outcome: { queryId: query.officialId, relevant: query.relevant, rankedDocumentIds: ["source"],
        candidatesBeforeRerank: 1, candidatesAfterRerank: 1,
        embeddingUsage: { costMicros: null, requests: 1, tokens: 5 },
        rerankApplied: false, rerankFallback: false, rerankMs: null, retrievalMs: 3,
        rerankerUsage: { costMicros: null, requests: 0, tokens: 0 },
        rerankerDiagnostic: { fallbackReason: null, omittedCandidateCount: 0, omittedRejectedCandidateCount: 0,
          status: "disabled", timedOut: false } }
    }));
    const resumed = await prepareRetrievalCheckpoint({ ...options, resume: true });
    const execute = vi.fn();
    expect((await runKnowledgeRetrievalBatch({ queries: [query], resumedOutcomes: resumed.resumedOutcomes,
      batchSize: 1, concurrency: 1, execute })).complete).toBe(true);
    expect(execute).not.toHaveBeenCalled();
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
