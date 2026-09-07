import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPrismaKnowledgeRetrievalStore } from "../../lib/server/knowledge/prismaRetrievalRepository";
import { createKnowledgePassageBm25Search } from "../../lib/server/knowledge/searchRetrieval";
import { createKnowledgeRerankStage, KNOWLEDGE_RERANK_ADAPTER_VERSION } from "../../lib/server/knowledge/rerankExecution";
import { RerankAdapterError, type RerankAdapter } from "../../lib/server/providers/rerank";
import { KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION } from "../../lib/server/knowledge/rerankCandidateFormatter";
import { brightAnswerHash } from "./brightAnswerHarness";
import { createKnowledgeRetrievalRecorder, prepareKnowledgeRetrievalReplayStore, replayKnowledgeRetrieval } from "./retrievalReplay";
import { parseKnowledgeReplayCli } from "./replayRetrieval";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

const pin = {
  adapterVersion: KNOWLEDGE_RERANK_ADAPTER_VERSION,
  candidateFormatterVersion: KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION,
  connectionSnapshotId: "connection", credentialSnapshotRef: "credential-reference",
  policyVersion: 1, provider: "openrouter", providerModelId: "model", upstreamModelId: "test-model"
};
const scopes = [{ acceptedIndexArtifactIds: ["index"], baseName: "Synthetic base", bindingOrdinal: 0,
  eligibleRows: 2, indexGenerationId: "generation", knowledgeBaseId: "base",
  projectionComplete: true, targetDimension: 1_024 }];
const rows = ["a", "b"].map((id, index) => ({
  baseName: "Synthetic base", bindingOrdinal: 0, chunkId: `chunk-${id}`, chunkIndex: 0,
  contributingBindingOrdinals: [0], contentHash: id.repeat(64), documentId: `source-${id}`,
  documentContext: null, documentVersionId: `version-${id}`, documentVersionNumber: 1,
  exactKind: null, fileName: "synthetic.txt", headingPath: ["Guide"], knowledgeBaseId: "base",
  lane: "passage_bm25", laneRank: index + 1, layoutKind: "body", page: 1, rawScore: 1,
  sectionId: `section-${id}`, sourceArtifactId: `artifact-${id}`, sourceName: "Synthetic source",
  text: `Temperature control ${id}.`, vectorDistance: null, vectorMode: null
}));
const request = {
  anchorQuery: "temperature control", candidateLimit: 64, excludedOccurrenceKeys: [],
  operation: "automatic_search" as const, query: "temperature control", resultLimit: 16,
  runId: "run", userId: "owner", vectors: [{ bindingOrdinal: 0, indexGenerationId: "generation",
    knowledgeBaseId: "base", targetDimension: 1_024 as const, vector: Array<number>(1_024).fill(0) }]
};

function memoryStore() {
  const values = new Map<string, unknown>();
  return { values,
    read: vi.fn(async (name: string) => structuredClone(values.get(name) ?? null)),
    write: vi.fn(async (name: string, value: unknown) => {
      if (values.has(name)) throw new Error("test_overwrite");
      values.set(name, structuredClone(value));
    }) };
}
function fixture(kind: "complete" | "partial" | "degraded" | "singleton" | "empty" = "complete") {
  const candidates = kind === "empty" ? [] : kind === "singleton" ? rows.slice(0, 1) : rows;
  const queryRaw = vi.fn().mockResolvedValueOnce(scopes)
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([{ candidates, scopeVerified: true, semanticRevalidatedCount: 0 }]);
  const executeRaw = vi.fn().mockResolvedValue(1);
  const artifacts = vi.fn().mockResolvedValue(rows.map(row => ({ id: row.sourceArtifactId,
    sourceVersionId: row.documentVersionId, hierarchicalIndexes: [{ id: `index-${row.chunkId}` }] })));
  const parents = vi.fn().mockResolvedValue(rows.flatMap(row => [0, 1].map(ordinal => ({
    ...row, id: ordinal === 0 ? row.chunkId : `context-${row.chunkId}`,
    indexArtifactId: `index-${row.chunkId}`, ordinal, contextPrefix: "",
    text: ordinal === 0 ? row.text : "Read the temperature sensor before adjusting the control."
  }))));
  const transaction = vi.fn(async (action: (tx: unknown) => Promise<unknown>) =>
    action({ $queryRaw: queryRaw, $executeRaw: executeRaw }));
  const client = { $transaction: transaction,
    knowledgeSourceIndexArtifact: { findMany: artifacts }, knowledgeArtifactPassageIndex: { findMany: parents }
  } as unknown as Parameters<typeof createPrismaKnowledgeRetrievalStore>[0];
  const search = vi.fn().mockResolvedValue({ variants: [[]], durationMs: 2, opaqueId: null });
  const lexical = createKnowledgePassageBm25Search({ searchKnowledgePassages: search, checkKnowledgeIndex: vi.fn(async () => undefined) } as never);
  const rerank = vi.fn<RerankAdapter["rerank"]>(async input => {
    if (kind === "degraded") throw new RerankAdapterError("rerank_request_timed_out");
    return { model: pin.upstreamModelId, provider: "openrouter", requestId: null,
      scores: input.documents.slice(0, kind === "partial" ? 1 : undefined).map((doc, index) => ({
        handle: doc.handle, index, relevanceScore: index === 1 ? 0.9 : 0.3
      })), usage: { inputTokens: 4, totalTokens: 4, searchUnits: 1 } };
  });
  const stage = (adapter: RerankAdapter = { rerank }) => createKnowledgeRerankStage({
    adapter, pin, query: request.query, now: () => 0
  });
  return { client, lexical, rerank, stage, queryRaw, transaction, executeRaw, artifacts, parents, search };
}

async function capture(kind: Parameters<typeof fixture>[0] = "complete", stored = memoryStore(), index = 0) {
  const live = fixture(kind), recorder = createKnowledgeRetrievalRecorder();
  const store = createPrismaKnowledgeRetrievalStore(recorder.client(live.client), recorder.lexical(live.lexical));
  const searchInput = { ...request, rerank: { executor: recorder.executor(live.stage(recorder.adapter({ rerank: live.rerank }))) } };
  const result = await store.hybridSearch(searchInput);
  await recorder.finish({ store: stored, queryIndex: index, searchInput, result });
  return { live, stored, result };
}

describe("private retrieval replay", () => {
  it.each(["complete", "partial", "degraded", "singleton", "empty"] as const)(
    "repeats the actual repository output offline for %s reranking", async kind => {
      const { live, stored, result } = await capture(kind);
      const plain = fixture(kind);
      const expected = await createPrismaKnowledgeRetrievalStore(plain.client, plain.lexical)
        .hybridSearch({ ...request, rerank: { executor: plain.stage() } });
      expect(result).toEqual(expected);
      const calls = [live.queryRaw, live.transaction, live.executeRaw, live.artifacts,
        live.parents, live.search, live.rerank].map(mock => mock.mock.calls.length);
      const replay = await replayKnowledgeRetrieval({ store: stored, queryIndex: 0 });
      expect(replay.exact).toBe(true);
      expect(replay.result).toEqual(result);
      expect([live.queryRaw, live.transaction, live.executeRaw, live.artifacts,
        live.parents, live.search, live.rerank].map(mock => mock.mock.calls.length)).toEqual(calls);
      expect(live.rerank).toHaveBeenCalledTimes(kind === "singleton" || kind === "empty" ? 0 : 1);
      if (kind === "complete") {
        expect(live.parents).toHaveBeenCalledOnce();
        expect(result.passages.map(row => row.chunkId)).toEqual(["chunk-b", "chunk-a"]);
      }
    }
  );

  it("shares identical scope objects across queries and refuses case replacement", async () => {
    const { stored } = await capture();
    await capture("complete", stored, 1);
    const name = `object-${brightAnswerHash(scopes)}.json`;
    expect(stored.write.mock.calls.filter(call => call[0] === name)).toHaveLength(1);
    expect([...stored.values.values()].filter(value => JSON.stringify(value).includes("acceptedIndexArtifactIds")))
      .toHaveLength(1);
    await expect(capture("complete", stored, 0)).rejects.toThrow("knowledge_benchmark_replay_invalid");
  });

  it("rejects missing objects and corruption before accepting an exact replay", async () => {
    for (const mutation of ["missing", "changed"] as const) {
      const { stored } = await capture();
      const name = `object-${brightAnswerHash(scopes)}.json`;
      if (mutation === "missing") stored.values.delete(name);
      else stored.values.set(name, [{ ...scopes[0], projectionComplete: false }]);
      await expect(replayKnowledgeRetrieval({ store: stored, queryIndex: 0 })).rejects.toThrow("knowledge_benchmark_replay_invalid");
    }
  });

  it("rejects a changed dependency input and unconsumed recorded calls", async () => {
    for (const mutation of ["input", "extra"] as const) {
      const { stored } = await capture();
      const artifact = stored.values.get("case-000000.json") as { calls: { requestHash: string }[] };
      if (mutation === "input") artifact.calls[0]!.requestHash = "0".repeat(64);
      else artifact.calls.push(structuredClone(artifact.calls[0]!));
      await expect(replayKnowledgeRetrieval({ store: stored, queryIndex: 0 })).rejects.toThrow(
        mutation === "input" ? "replay_input_mismatch" : "replay_unconsumed_calls");
    }
  });

  it("cannot complete a capture after a database failure or an unrecorded operation", async () => {
    const live = fixture(), recorder = createKnowledgeRetrievalRecorder(), stored = memoryStore();
    const failure = new Error("synthetic database failure");
    live.queryRaw.mockReset().mockRejectedValue(failure);
    const store = createPrismaKnowledgeRetrievalStore(recorder.client(live.client), recorder.lexical(live.lexical));
    await expect(store.hybridSearch(request)).rejects.toBe(failure);
    await expect(recorder.finish({ store: stored, queryIndex: 0, searchInput: request, result: {} as never }))
      .rejects.toThrow("knowledge_benchmark_replay_invalid");
    expect(stored.write).not.toHaveBeenCalled();
    expect(() => recorder.client(live.client).modelRun).toThrow("knowledge_benchmark_replay_invalid");
    expect(live.rerank).not.toHaveBeenCalled();
  });

  it("keeps actual native inputs and rejects a changed formatted query", async () => {
    const { stored, live } = await capture();
    const artifact = stored.values.get("case-000000.json") as {
      native: { requestHash: string; responseHash: string };
    };
    const native = stored.values.get(`object-${artifact.native.requestHash}.json`) as { query: string };
    expect(native).toEqual({ query: request.query, documents: live.rerank.mock.calls[0]![0].documents });
    native.query = "A different query";
    artifact.native.requestHash = brightAnswerHash(native);
    stored.values.set(`object-${artifact.native.requestHash}.json`, native);
    await expect(replayKnowledgeRetrieval({ store: stored, queryIndex: 0 }))
      .rejects.toThrow("knowledge_benchmark_replay_native_input_mismatch");
  });

  it("bounds captured payloads before provider dispatch", async () => {
    const recorder = createKnowledgeRetrievalRecorder(), rerank = vi.fn();
    await expect(recorder.adapter({ rerank }).rerank({ query: "x".repeat(24 * 1024 * 1024 + 1), documents: [] }))
      .rejects.toThrow("knowledge_benchmark_replay_invalid");
    expect(rerank).not.toHaveBeenCalled();
  });

  it("does not amend a timed-out capture when an uncancellable provider settles during file writes", async () => {
    const live = fixture(), recorder = createKnowledgeRetrievalRecorder(), stored = memoryStore();
    let settle!: (value: Awaited<ReturnType<RerankAdapter["rerank"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<RerankAdapter["rerank"]>>>(resolve => { settle = resolve; });
    const adapter: RerankAdapter = { rerank: vi.fn(() => pending) };
    const stage = createKnowledgeRerankStage({ adapter: recorder.adapter(adapter), pin,
      query: request.query, now: () => 0, timeoutMs: 1 });
    const searchInput = { ...request, rerank: { executor: recorder.executor(stage) } };
    const result = await createPrismaKnowledgeRetrievalStore(recorder.client(live.client), recorder.lexical(live.lexical))
      .hybridSearch(searchInput);
    expect(result.rerankerBinding).toMatchObject({ status: "degraded", timedOut: true });
    const write = stored.write;
    await recorder.finish({ queryIndex: 0, searchInput, result, store: { read: stored.read,
      async write(name, value) {
        settle({ model: pin.upstreamModelId, provider: "openrouter", requestId: null,
          scores: [], usage: { inputTokens: 0, totalTokens: 0, searchUnits: 0 } });
        await pending;
        await Promise.resolve();
        await write(name, value);
      }
    } });
    expect(stored.values.get("case-000000.json")).toMatchObject({ native: { responseHash: null } });
    expect((await replayKnowledgeRetrieval({ store: stored, queryIndex: 0 })).exact).toBe(true);
  });

  it("persists private replay objects and pins capture mode across resume", async () => {
    const repositoryRoot = await mkdtemp(resolve(tmpdir(), "knowledge-replay-"));
    temporaryRoots.push(repositoryRoot);
    const options = { repositoryRoot, outputDirectory: resolve(repositoryRoot, "benchmarks/knowledge/results/capture"),
      enabled: false, resume: false, manifest: { codeFingerprint: "a".repeat(64) } };
    expect(await prepareKnowledgeRetrievalReplayStore(options)).toBeNull();
    await expect(prepareKnowledgeRetrievalReplayStore({ ...options, enabled: true, resume: true }))
      .rejects.toThrow("bright_answer_resume_missing");
    const files = await prepareKnowledgeRetrievalReplayStore({ ...options, enabled: true });
    const { stored, result } = await capture();
    try {
      for (const [name, value] of stored.values) await files!.write(name, value);
      expect((await stat(resolve(options.outputDirectory, "replay"))).mode & 0o777).toBe(0o700);
      expect((await stat(resolve(options.outputDirectory, "replay/case-000000.json"))).mode & 0o777).toBe(0o600);
    } finally { await files!.close(); }
    await expect(prepareKnowledgeRetrievalReplayStore({ ...options, resume: true }))
      .rejects.toThrow("knowledge_benchmark_replay_mode_invalid");
    await expect(prepareKnowledgeRetrievalReplayStore({ ...options, enabled: true, resume: true,
      manifest: { codeFingerprint: "b".repeat(64) } })).rejects.toThrow("bright_answer_manifest_mismatch");
    const resumed = await prepareKnowledgeRetrievalReplayStore({ ...options, enabled: true, resume: true });
    try {
      expect((await replayKnowledgeRetrieval({ store: resumed!, queryIndex: 0 })).result).toEqual(result);
    } finally { await resumed!.close(); }
  });

  it("requires an explicit recorded case and makes changed-code comparison opt in", () => {
    expect(parseKnowledgeReplayCli(["--output", "results/capture", "--query-index", "0"]))
      .toEqual({ output: "results/capture", queryIndex: 0, compareCurrent: false });
    expect(parseKnowledgeReplayCli(["--output", "results/capture", "--query-index", "2", "--compare-current"]).compareCurrent)
      .toBe(true);
    for (const args of [[], ["--output", "results/capture"],
      ["--output", "results/capture", "--query-index", "-1"],
      ["--output", "results/capture", "--query-index", "0", "--confirm-paid", "DISPOSABLE"]]) {
      expect(() => parseKnowledgeReplayCli(args)).toThrow("knowledge_benchmark_replay_arguments_invalid");
    }
  });
});
