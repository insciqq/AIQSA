import { Prisma } from "@prisma/client";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { createPrismaKnowledgeRetrievalStore } from "../../lib/server/knowledge/prismaRetrievalRepository";
import type { KnowledgePassageBm25Search } from "../../lib/server/knowledge/searchRetrieval";
import type { KnowledgeRerankExecutor, KnowledgeRerankStageResult } from "../../lib/server/knowledge/rerankExecution";
import type { RerankAdapter } from "../../lib/server/providers/rerank";
import { formatKnowledgeRerankCandidate } from "../../lib/server/knowledge/rerankCandidateFormatter";
import type { KnowledgeRerankPoolCandidate } from "../../lib/server/knowledge/rerankExecution";
import { brightAnswerHash, createBrightAnswerStore, type BrightAnswerStore } from "./brightAnswerHarness";

type Client = Parameters<typeof createPrismaKnowledgeRetrievalStore>[0];
type SearchInput = Parameters<ReturnType<typeof createPrismaKnowledgeRetrievalStore>["hybridSearch"]>[0];
type SearchResult = Awaited<ReturnType<ReturnType<typeof createPrismaKnowledgeRetrievalStore>["hybridSearch"]>>;
type StoredInput = Omit<SearchInput, "rerank"> & { rerankEnabled: boolean };
type Store = Pick<BrightAnswerStore, "read" | "write">;
type Method = "sql" | "settings" | "artifacts" | "parents" | "lexical" | "rerank";
type Call = { method: Method; requestHash: string; responseHash: string; durationMs: number; scopeHash?: string };
type Invoke = (method: Method, request: unknown, execute?: () => Promise<unknown>) => Promise<unknown>;
type StoredStage = Omit<KnowledgeRerankStageResult, "scores"> & { scores: [string, number][] };

export const KNOWLEDGE_RETRIEVAL_REPLAY_VERSION = 1;
const MAX_OBJECT_BYTES = 24 * 1024 * 1024;
const MAX_CASE_BYTES = 128 * 1024 * 1024;
const MAX_CALLS = 32;
const hashPattern = /^[a-f0-9]{64}$/u;
const methods = new Set<Method>(["sql", "settings", "artifacts", "parents", "lexical", "rerank"]);

function invalid(): never { throw new Error("knowledge_benchmark_replay_invalid"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function wire(value: unknown): { value: unknown; bytes: number } {
  const text = JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === "number" && !Number.isFinite(entry) ||
      typeof entry === "function" || typeof entry === "bigint" ||
      entry instanceof Map || entry instanceof Set) invalid();
    return entry;
  });
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_OBJECT_BYTES) invalid();
  return { value: JSON.parse(text) as unknown, bytes: Buffer.byteLength(text) };
}
function hash(value: unknown): string { return brightAnswerHash(wire(value).value); }

export async function prepareKnowledgeRetrievalReplayStore(input: Readonly<{
  repositoryRoot: string; outputDirectory: string; enabled: boolean; resume: boolean;
  manifest: Readonly<Record<string, unknown>>;
}>) {
  const output = resolve(input.outputDirectory, "replay");
  if (input.enabled) return createBrightAnswerStore({ repositoryRoot: input.repositoryRoot,
    output, resume: input.resume,
    manifest: { ...input.manifest, version: KNOWLEDGE_RETRIEVAL_REPLAY_VERSION } });
  const existing = await lstat(output).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw new Error("knowledge_benchmark_replay_mode_invalid");
  });
  if (existing) throw new Error("knowledge_benchmark_replay_mode_invalid");
  return null;
}

function caseName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0 || index > 999_999) invalid();
  return `case-${String(index).padStart(6, "0")}.json`;
}
function sqlRequest(args: readonly unknown[]): unknown {
  const first = args[0];
  const query = Array.isArray(first)
    ? Prisma.sql(first as unknown as TemplateStringsArray, ...args.slice(1))
    : first as Prisma.Sql;
  if (!query || !Array.isArray(query.strings) || !Array.isArray(query.values)) invalid();
  return { strings: query.strings, values: query.values };
}

/** Closed facade: replay cannot obtain a live client or silently execute a
 * new, unrecorded repository operation. The real store still owns SQL,
 * canonical authority checks, candidate selection and parent expansion. */
function dependencies(invoke: Invoke, live?: Client): Client {
  const raw = (client?: object) => new Proxy({}, {
    get(_target, key) {
      if (key !== "$queryRaw" && key !== "$executeRaw") invalid();
      return (...args: unknown[]) => invoke(key === "$queryRaw" ? "sql" : "settings", sqlRequest(args),
        client ? () => Reflect.apply(Reflect.get(client, key) as (...args: unknown[]) => Promise<unknown>, client, args) : undefined);
    }
  });
  return new Proxy({} as Client, {
    get(_target, key) {
      if (key === "$transaction") {
        return async (action: (tx: unknown) => Promise<unknown>, options: Parameters<Client["$transaction"]>[1]) => {
          if (typeof action !== "function") invalid();
          return live ? live.$transaction(tx => action(raw(tx)), options) : action(raw());
        };
      }
      if (key === "$queryRaw") return Reflect.get(raw(live), key);
      if (key === "knowledgeSourceIndexArtifact" || key === "knowledgeArtifactPassageIndex") {
        const method = key === "knowledgeSourceIndexArtifact" ? "artifacts" : "parents";
        return new Proxy({}, {
          get(_delegate, operation) {
            if (operation !== "findMany") invalid();
            return (request: unknown) => invoke(method, request, live
              ? () => Reflect.apply(live[key].findMany, live[key], [request]) as Promise<unknown>
              : undefined);
          }
        });
      }
      invalid();
    }
  });
}

function lexical(invoke: Invoke, live?: KnowledgePassageBm25Search): KnowledgePassageBm25Search {
  return async input => await invoke("lexical", {
    indexArtifactIds: input.indexArtifactIds, ownerUserId: input.ownerUserId,
    queryVariants: input.queryVariants
  }, live ? () => live(input) : undefined) as Awaited<ReturnType<KnowledgePassageBm25Search>>;
}

function executor(invoke: Invoke, live?: KnowledgeRerankExecutor): KnowledgeRerankExecutor {
  return async input => {
    const stored = await invoke("rerank", { candidates: input.candidates }, live ? async () => {
      const result = await live(input);
      return { ...result, scores: [...result.scores] };
    } : undefined) as StoredStage;
    if (!record(stored) || !Array.isArray(stored.scores) ||
      stored.scores.some(entry => !Array.isArray(entry) || entry.length !== 2 ||
        typeof entry[0] !== "string" || typeof entry[1] !== "number" || !Number.isFinite(entry[1])) ||
      new Set(stored.scores.map(entry => entry[0])).size !== stored.scores.length) invalid();
    return { ...stored, scores: new Map(stored.scores) };
  };
}

/** Opt-in benchmark capture only. Inputs contain no evaluator fields; there
 * is no product observer, provider transport logger, or browser endpoint. */
export function createKnowledgeRetrievalRecorder() {
  const calls: Call[] = [];
  const objects = new Map<string, unknown>();
  let bytes = 0, failed = false, finished = false;
  let native: { requestHash: string; responseHash: string | null } | null = null;
  let rerankRequestHash: string | null = null;
  function save(value: unknown): string {
    const encoded = wire(value), id = brightAnswerHash(encoded.value);
    if (!objects.has(id)) {
      bytes += encoded.bytes;
      if (bytes > MAX_CASE_BYTES) invalid();
      objects.set(id, encoded.value);
    }
    return id;
  }
  const invoke: Invoke = async (method, request, execute) => {
    if (failed || finished || !execute || calls.length >= MAX_CALLS) invalid();
    const requestHash = hash(request);
    if (method === "rerank") rerankRequestHash = save(request);
    const call: Call = { method, requestHash, responseHash: "", durationMs: 0 };
    calls.push(call);
    const started = performance.now();
    try {
      const value = await execute();
      call.durationMs = performance.now() - started;
      // The hybrid SQL envelope echoes the whole accepted scope. Separate it
      // before hashing, otherwise every changing candidate set would copy the
      // same large Source/index list into a new object.
      if (method === "sql" && Array.isArray(value) && value.length === 1 &&
        record(value[0]) && Array.isArray(value[0].scopes) && Array.isArray(value[0].candidates)) {
        const { scopes, ...row } = value[0];
        call.scopeHash = save(scopes);
        call.responseHash = save([row]);
      } else call.responseHash = save(value);
      return value;
    } catch (error) { failed = true; throw error; }
  };
  return {
    client: (client: Client) => dependencies(invoke, client),
    lexical: (search: KnowledgePassageBm25Search) => lexical(invoke, search),
    executor: (stage: KnowledgeRerankExecutor) => executor(invoke, stage),
    adapter: (adapter: RerankAdapter): RerankAdapter => ({
      async rerank(request) {
        if (native || failed || finished) invalid();
        native = { requestHash: save({ documents: request.documents,
          instruction: request.instruction, query: request.query }), responseHash: null };
        const response = await adapter.rerank(request);
        // A provider that ignores cancellation may settle after the stage
        // timed out. It cannot amend that settled fallback's private capture.
        if (!finished && !failed && !request.signal?.aborted) native.responseHash = save(response);
        return response;
      }
    }),
    async finish(input: Readonly<{
      store: Store; queryIndex: number; searchInput: SearchInput; result: SearchResult;
    }>) {
      if (failed || finished || calls.some(call => !hashPattern.test(call.responseHash))) invalid();
      const stage = calls.find(call => call.method === "rerank");
      const capturedStage = stage ? objects.get(stage.responseHash) as StoredStage : null;
      if (calls.filter(call => call.method === "rerank").length > 1 ||
        capturedStage && capturedStage.evidence.inputCandidateCount > 1 &&
          (!native || capturedStage.status !== "degraded" && native.responseHash === null)) invalid();
      finished = true;
      // Explicit projection prevents future evaluator/runtime function fields
      // from entering either the replay input or a provider request.
      const request: StoredInput = {
        anchorQuery: input.searchInput.anchorQuery,
        bindingOrdinals: input.searchInput.bindingOrdinals,
        candidateLimit: input.searchInput.candidateLimit,
        excludedOccurrenceKeys: input.searchInput.excludedOccurrenceKeys,
        operation: input.searchInput.operation,
        query: input.searchInput.query,
        rerankEnabled: Boolean(input.searchInput.rerank),
        resultLimit: input.searchInput.resultLimit,
        runId: input.searchInput.runId,
        sourceIds: input.searchInput.sourceIds,
        userId: input.searchInput.userId,
        vectors: input.searchInput.vectors
      };
      const artifact = { version: KNOWLEDGE_RETRIEVAL_REPLAY_VERSION,
        requestHash: save(request), resultHash: save(input.result), calls, native, rerankRequestHash };
      if (await input.store.read(caseName(input.queryIndex)) !== null) invalid();
      for (const [id, value] of objects) {
        const name = `object-${id}.json`, prior = await input.store.read(name);
        if (prior === null) await input.store.write(name, value);
        else if (hash(prior) !== id) invalid();
      }
      // A case becomes replayable only after all of its immutable objects.
      await input.store.write(caseName(input.queryIndex), artifact);
    }
  };
}

export async function replayKnowledgeRetrieval(input: Readonly<{
  store: Store; queryIndex: number;
}>) {
  const artifact = await input.store.read(caseName(input.queryIndex));
  if (!record(artifact) || artifact.version !== KNOWLEDGE_RETRIEVAL_REPLAY_VERSION ||
    !Array.isArray(artifact.calls) || artifact.calls.length > MAX_CALLS ||
    artifact.calls.some(call => !record(call) || !methods.has(call.method as Method) ||
      !hashPattern.test(String(call.requestHash)) || !hashPattern.test(String(call.responseHash)) ||
      call.scopeHash !== undefined && (call.method !== "sql" || !hashPattern.test(String(call.scopeHash))) ||
      typeof call.durationMs !== "number" || !Number.isFinite(call.durationMs) || call.durationMs < 0)) invalid();
  const objects = new Map<string, unknown>();
  let bytes = 0;
  const read = async (id: unknown) => {
    if (typeof id !== "string" || !hashPattern.test(id)) invalid();
    if (!objects.has(id)) {
      const value = await input.store.read(`object-${id}.json`);
      if (value === null || hash(value) !== id) invalid();
      bytes += wire(value).bytes;
      if (bytes > MAX_CASE_BYTES) invalid();
      objects.set(id, value);
    }
    return structuredClone(objects.get(id));
  };
  const request = await read(artifact.requestHash) as StoredInput;
  const expected = await read(artifact.resultHash) as SearchResult;
  const calls = artifact.calls as Call[];
  // Validate even diagnostic-only native objects, so a corrupt captured
  // payload cannot be mistaken for exact historical evidence.
  const native = artifact.native;
  const rerankRequest = artifact.rerankRequestHash === null ? null :
    await read(artifact.rerankRequestHash) as { candidates: KnowledgeRerankPoolCandidate[] };
  if (rerankRequest !== null && (!record(rerankRequest) || !Array.isArray(rerankRequest.candidates))) invalid();
  const stages = calls.filter(call => call.method === "rerank");
  if (stages.length > 1 || Boolean(stages.length) !== Boolean(rerankRequest) ||
    stages.length && stages[0]!.requestHash !== artifact.rerankRequestHash) invalid();
  const capturedStage = stages.length ? await read(stages[0]!.responseHash) as StoredStage : null;
  if (capturedStage && capturedStage.evidence.inputCandidateCount > 1 && native === null) invalid();
  if (native !== null) {
    if (!record(native) || !rerankRequest || !capturedStage) invalid();
    const nativeRequest = await read(native.requestHash);
    if (hash(nativeRequest) !== hash({ query: request.query,
      documents: rerankRequest.candidates.map(candidate => ({ handle: candidate.chunkId,
        text: formatKnowledgeRerankCandidate(candidate) })) })) {
      throw new Error("knowledge_benchmark_replay_native_input_mismatch");
    }
    if (native.responseHash !== null) await read(native.responseHash);
    else if (capturedStage.status !== "degraded") invalid();
  }
  let cursor = 0;
  const invoke: Invoke = async (method, value) => {
    const call = calls[cursor++];
    if (!call || call.method !== method || call.requestHash !== hash(value)) {
      throw new Error("knowledge_benchmark_replay_input_mismatch");
    }
    const response = await read(call.responseHash);
    if (call.scopeHash === undefined) return response;
    if (!Array.isArray(response) || response.length !== 1 || !record(response[0]) ||
      "scopes" in response[0] || !Array.isArray(response[0].candidates)) invalid();
    return [{ ...response[0], scopes: await read(call.scopeHash) }];
  };
  const store = createPrismaKnowledgeRetrievalStore(dependencies(invoke), lexical(invoke));
  const { rerankEnabled, ...searchInput } = request;
  const result = await store.hybridSearch({ ...searchInput,
    ...(rerankEnabled ? { rerank: { executor: executor(invoke) } } : {}) });
  if (cursor !== calls.length) throw new Error("knowledge_benchmark_replay_unconsumed_calls");
  return { calls: calls.length, result, expected,
    exact: hash(result) === artifact.resultHash,
    stageDurations: calls.map(call => ({ method: call.method, durationMs: call.durationMs })) };
}
