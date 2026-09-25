import type { ToolObservation } from "@prisma/client";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { logEvent } from "../observability";
import { getStoredObjectStream, type StorageAdapter } from "../uploads/storage";
import { admitToolObservation, type ObservationAdmission } from "./admission";
import { ObservationReadError, readObservationBytes, type ObservationByteFragment } from "./byteReader";
import { measureObservationJson, observationJsonStream, OBSERVATION_ENCODING } from "./codec";
import { decodeToolObservationDescriptor, decodeToolObservationReadInput, toolObservationCursor, ObservationStoreError,
  TOOL_OBSERVATION_LIMITS, type ToolObservationDescriptor, type ToolObservationSource, type ToolObservationSourceBinding } from "./contract";
import type { ObservationActor, ObservationProducer, createToolObservationRepository } from "./repository";
import { readObservationOriginal, readSearchOriginal } from "./searchOriginal";
import { decodeSearchObservationReceipt, searchObservationReceipt } from "./searchReceipt";
import type { ToolExecutionResult } from "../tools/types";

export type ToolObservationRepository = ReturnType<typeof createToolObservationRepository>;
export type ToolObservationProjection = Readonly<{
  observation: ToolObservationDescriptor;
  fragmentKind: "serialized_json_text";
  preview: string;
  incomplete: boolean;
  reader: "read_tool_result";
}>;

function descriptor(row: ToolObservation): ToolObservationDescriptor {
  const value = decodeToolObservationDescriptor({ version: row.formatVersion, handle: `tor1_${row.id}`,
    source: row.sourceKind, encoding: OBSERVATION_ENCODING, byteSize: row.byteSize, checksum: row.checksum,
    sourceTruncated: row.sourceTruncated, maskable: row.maskable });
  if (!value) throw new ObservationStoreError("tool_observation_unavailable");
  return value;
}

const unavailable = () => new ObservationStoreError("tool_observation_unavailable");
function requireStreaming(storage: StorageAdapter): void {
  if (!storage.getObjectStream || !storage.putObjectStream) {
    throw new ObservationStoreError("tool_observation_storage_unavailable");
  }
}
function boundedSignal(parent?: AbortSignal) {
  const timeout = AbortSignal.timeout(TOOL_OBSERVATION_LIMITS.storageTimeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** A streamed fragment/preview holds only bounded reader buffers, whatever
 * the object size. A Search restore and a source load hold it all. */
const STREAMED_READ_BYTES = 128 * 1024;

const OBSERVED_CODES = Object.freeze({ busy: "tool_observation_busy", limit: "tool_observation_limit_exceeded",
  waited: "tool_observation_waiting", store_failed: "tool_observation_store_failed" });

/** Content-free store/limit/queue counters. Skills are source-owned and never
 * reach object storage or the branch budget. */
function observe(source: string, event: keyof typeof OBSERVED_CODES): void {
  if (source !== "mcp" && source !== "workspace" && source !== "search" && source !== "knowledge") return;
  const code = OBSERVED_CODES[event];
  if (event === "store_failed") {
    logEvent("tool_execution", { tool_kind: source, stage: "result", outcome: "failed", code, reason: "unknown", action: "degrade" });
    return;
  }
  logEvent("tool_execution", { tool_kind: source, stage: "admission", code,
    outcome: event === "waited" ? "degraded" : "failed",
    reason: event === "limit" ? "policy" : "safety_limit",
    action: event === "waited" ? "wait" : event === "busy" ? "retry" : "fail" });
}

type ReaderResponse = Readonly<{
  observation: ToolObservationDescriptor;
  fragmentKind: "serialized_json_text";
  fragment: string;
  offset: number;
  endOffset: number;
  incomplete: boolean;
  matchOffset: number | null;
  cursor: string | null;
}>;

/** Keep the exact bytes, but never refuse a valid selector only because dense
 * text (for example pictographs) exceeds the reader's estimated-token bound:
 * return a shorter prefix at a code point boundary with a continuation. */
function readerResponse(reference: ToolObservationDescriptor, fragment: ObservationByteFragment, query?: string): ReaderResponse {
  const build = (text: string, endOffset: number, nextOffset: number | null, complete: boolean): ReaderResponse => ({
    observation: reference, fragmentKind: "serialized_json_text", fragment: text, offset: fragment.offset, endOffset,
    incomplete: !complete, matchOffset: fragment.matchOffset,
    cursor: nextOffset === null ? null : toolObservationCursor(reference, nextOffset, query) });
  const fits = (response: ReaderResponse) => Buffer.byteLength(JSON.stringify(response)) <= TOOL_OBSERVATION_LIMITS.readerBytes &&
    estimateApproxTokens(response) <= TOOL_OBSERVATION_LIMITS.readerEstimatedTokens;
  const full = build(fragment.fragment, fragment.endOffset, fragment.nextOffset, fragment.completeDocument);
  if (fits(full)) return full;
  const points = Array.from(fragment.fragment);
  let low = 1, high = points.length - 1;
  let best: ReaderResponse | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const text = points.slice(0, middle).join("");
    const endOffset = fragment.offset + Buffer.byteLength(text, "utf8");
    // A literal search continues after its match; a range read at the cut.
    const candidate = build(text, endOffset, query === undefined ? endOffset : fragment.nextOffset, false);
    if (fits(candidate)) { best = candidate; low = middle + 1; } else high = middle - 1;
  }
  if (!best) throw unavailable();
  return best;
}

export function createToolObservationService(input: Readonly<{
  repository: ToolObservationRepository;
  storage: StorageAdapter;
  /** Defaults to the one process-wide storage-phase budget. */
  admission?: ObservationAdmission;
}>) {
  const { repository, storage } = input;
  const admit = input.admission ?? admitToolObservation;
  const bodyFor = async (row: ToolObservation, reference: ToolObservationDescriptor, signal: AbortSignal,
    actor?: ObservationActor): Promise<ReadableStream<Uint8Array>> => {
    if (row.storageMode === "SOURCE" && actor) {
      const loaded = await repository.readSource(actor, row.id);
      return observationJsonStream(loaded.original, reference.byteSize);
    }
    if (row.storageMode === "INLINE" && row.inlineText !== null) {
      const bytes = Buffer.from(row.inlineText, "utf8");
      return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    }
    if (row.storageMode === "OBJECT" && row.storageKey) {
      requireStreaming(storage);
      return (await getStoredObjectStream(storage, row.storageKey,
        { requireStreaming: true, maxBytes: reference.byteSize, signal })).body;
    }
    throw unavailable();
  };
  /** Inline rows are already bounded database values. Other rows stream an
   * object or materialize a source, so they share the storage-phase budget. */
  const readPhase = <T>(row: ToolObservation, reference: ToolObservationDescriptor, work: () => Promise<T>,
    options: Readonly<{ signal?: AbortSignal; whenBusy: "reject" | "wait"; wholeOriginal?: boolean }>): Promise<T> =>
    row.storageMode === "INLINE" ? work() : admit(row.storageMode === "OBJECT" && !options.wholeOriginal
      ? STREAMED_READ_BYTES : reference.byteSize, work,
      { ...(options.signal ? { signal: options.signal } : {}), whenBusy: options.whenBusy, onWait: () => observe(row.sourceKind, "waited") });
  return {
    /** Reservation and streaming preflight precede the callback, including a
     * business call whose successful result later cannot be saved. The
     * business call itself holds no admission capacity: only the storage
     * phase of an externalized original does. A repeated reservation never
     * calls a generic source's callback: recovery must use its receipt. */
    async withReservation<T>(options: Readonly<{
      producer: ObservationProducer;
      source: ToolObservationSource;
      sourceBinding?: ToolObservationSourceBinding;
      maximumBytes: number;
      sourceOwned?: boolean;
      signal?: AbortSignal;
    }>, work: (receipt: Readonly<{
      store(value: Readonly<{ original: unknown; outcome: "complete" | "error";
        sourceTruncated: boolean; maskable: boolean }>): Promise<ToolObservationProjection>;
      /** Null when this owner's result cannot be published; the owner's
       * admitted result then stands without a reader descriptor. */
      storeSource(value: Readonly<{ outcome: "complete" | "error"; sourceTruncated: boolean; maskable: boolean }>): Promise<ToolObservationProjection | null>;
      recordSearch(result: ToolExecutionResult): Promise<void>;
    }>) => Promise<T>): Promise<T> {
      const { producer, signal } = options;
      if (options.sourceOwned && options.source !== "skill" && options.source !== "knowledge") throw unavailable();
      if (!options.sourceOwned && options.maximumBytes > TOOL_OBSERVATION_LIMITS.inlineBytes) requireStreaming(storage);
      // Transient backpressure before any reservation or business dispatch.
      // It is not a budget: the same call may be retried once storage drains.
      if (!options.sourceOwned && admit.busy()) {
        observe(options.source, "busy");
        throw new ObservationStoreError("tool_observation_busy");
      }
      signal?.throwIfAborted();
      const reservation = await repository.reserve(producer, options.source, options.maximumBytes, options.sourceBinding)
        .catch((error: unknown) => {
          if (error instanceof ObservationStoreError && error.code === "tool_observation_limit_exceeded") observe(options.source, "limit");
          throw error;
        });
      // Only a source owner's own claim may execute its producer again (for
      // example a Skill load after a crash); without a fresh reservation it
      // publishes nothing and never touches the earlier attempt's row.
      if (!reservation.claimed && !options.sourceOwned) throw new ObservationStoreError("tool_observation_conflict");
      const publishable = reservation.claimed;
      let stored = false;
      let attempted = false;
      let token: string | undefined;
      const store = async (value: Readonly<{ original: unknown; outcome: "complete" | "error";
        sourceTruncated: boolean; maskable: boolean }>): Promise<ToolObservationProjection> => {
        if (attempted || !publishable) throw new ObservationStoreError("tool_observation_conflict");
        attempted = true;
        // Preserve known execution independently of storage or Stop.
        await repository.recordOutcome(producer, value.outcome);
        signal?.throwIfAborted();
        const identity = measureObservationJson(value.original, options.maximumBytes,
          Math.min(options.maximumBytes, TOOL_OBSERVATION_LIMITS.inlineBytes));
        const storageMode = options.sourceOwned ? "SOURCE" : identity.inline !== null ? "INLINE" : "OBJECT";
        const publish = async (): Promise<ToolObservationProjection> => {
          const reference = descriptor({ ...reservation.observation, ...identity,
            sourceTruncated: value.sourceTruncated, maskable: value.maskable });
          const preview = await readObservationBytes({ body: observationJsonStream(value.original, options.maximumBytes),
            identity, selector: { offset: 0, maxBytes: TOOL_OBSERVATION_LIMITS.previewBytes }, signal });
          const projection: ToolObservationProjection = { observation: reference, fragmentKind: "serialized_json_text",
            preview: preview.fragment, incomplete: !preview.completeDocument, reader: "read_tool_result" };
          // This is the only copy retained in a checkpoint, never the full
          // externalized original. Source-owned instructions remain pinned.
          if (Buffer.byteLength(JSON.stringify(projection)) > TOOL_OBSERVATION_LIMITS.projectionBytes) throw unavailable();
          if (storageMode === "OBJECT") requireStreaming(storage);
          const row = await repository.beginWrite(producer, { byteSize: identity.byteSize, checksum: identity.checksum,
            inlineText: storageMode === "INLINE" ? identity.inline : null, projection,
            sourceTruncated: value.sourceTruncated, maskable: value.maskable, storageMode });
          if (storageMode === "OBJECT") {
            if (!row.storageKey || !row.leaseToken) throw unavailable();
            token = row.leaseToken;
            const storageSignal = boundedSignal(signal);
            await storage.putObjectStream!({ storageKey: row.storageKey, contentType: "application/json",
              byteSize: identity.byteSize, checksum: identity.checksum,
              body: observationJsonStream(value.original, options.maximumBytes), signal: storageSignal });
            const written = await getStoredObjectStream(storage, row.storageKey,
              { requireStreaming: true, maxBytes: identity.byteSize, signal: storageSignal });
            await readObservationBytes({ body: written.body, identity, selector: { offset: 0, maxBytes: 4 }, signal: storageSignal });
            storageSignal.throwIfAborted();
            await repository.finishWrite(producer, token);
          }
          stored = true;
          return projection;
        };
        // The executed result waits for capacity rather than being discarded.
        // Admission precedes beginWrite, so waiting never consumes its lease.
        return storageMode === "OBJECT"
          ? admit(identity.byteSize, publish, { ...(signal ? { signal } : {}), whenBusy: "wait",
            onWait: () => observe(options.source, "waited") })
          : publish();
      };
      try {
        const result = await work({ store, async recordSearch(result) {
          if (options.source !== "search" || !publishable) throw unavailable();
          await repository.recordSearchReceipt(producer, searchObservationReceipt(result));
          await repository.recordOutcome(producer, result.status);
        }, async storeSource(value) {
          if (!options.sourceOwned) throw unavailable();
          if (!publishable) return null;
          try {
            await repository.recordOutcome(producer, value.outcome);
            return await store({ ...value, original: await repository.loadProducerSource(producer) });
          } catch {
            if (signal?.aborted) throw signal.reason;
            await repository.unavailable(producer, "tool_observation_unavailable").catch(() => undefined);
            return null;
          }
        } });
        if (!stored && !options.sourceOwned) throw unavailable();
        return result;
      } catch (error) {
        // A storage/settlement failure is not permission to dispatch again.
        // The owner also retains its existing external dispatch receipt.
        // If the database itself is unavailable, leave the pre-existing
        // reservation/deletion lease for recovery rather than leaking a raw
        // database error or pretending cleanup completed.
        if (publishable) {
          await repository.recordOutcome(producer, "unknown").catch(() => undefined);
          await repository.unavailable(producer, "tool_observation_unavailable", token).catch(() => undefined);
        }
        if (signal?.aborted) throw signal.reason;
        // The source keeps its precise transport/validation failure. Once
        // store() starts, never claim a storage preflight prevented dispatch.
        if (!attempted) throw error;
        observe(options.source, "store_failed");
        throw error instanceof ObservationStoreError &&
          (error.code === "tool_observation_conflict" || error.code === "tool_observation_unavailable") ? error : unavailable();
      }
    },

    async read(actor: ObservationActor, value: unknown, signal?: AbortSignal) {
      const request = decodeToolObservationReadInput(value);
      let source = "";
      try {
        const current = await repository.read(actor, request.handle.slice(5));
        source = current.sourceKind;
        const reference = descriptor(current);
        if (request.expectedChecksum && request.expectedChecksum !== reference.checksum) throw unavailable();
        // A saturated storage queue is a transient refusal of this read only.
        const fragment = await readPhase(current, reference, async () => {
          const readSignal = boundedSignal(signal);
          const body = await bodyFor(current, reference, readSignal, actor);
          const read = await readObservationBytes({ body, identity: reference, selector: request.selector, signal: readSignal });
          readSignal.throwIfAborted();
          return read;
        }, { ...(signal ? { signal } : {}), whenBusy: "reject" });
        // Access or source revocation during object I/O suppresses the bytes.
        const after = descriptor(await repository.read(actor, current.id));
        if (after.checksum !== reference.checksum || after.byteSize !== reference.byteSize) throw unavailable();
        return readerResponse(reference, fragment, request.selector.query);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error instanceof ObservationStoreError && error.code === "tool_observation_busy") observe(source, "busy");
        throw error instanceof ObservationStoreError || error instanceof ObservationReadError ? error : unavailable();
      }
    },

    /** Recover the immutable receipt after READY but before call settlement.
     * Neither a missing reservation nor an unfinished upload is replayable.
     * An MCP/Workspace original of at most `wholeOriginalBytes` is also read
     * whole, so the caller can repeat its live projection rule. */
    async restore(producer: ObservationProducer, signal?: AbortSignal,
      options: Readonly<{ wholeOriginalBytes?: number }> = {}) {
      signal?.throwIfAborted();
      const row = await repository.readProducer(producer);
      if (row.state !== "READY") throw unavailable();
      const reference = descriptor(row);
      const preview = await readPhase(row, reference, async () => {
        const readSignal = boundedSignal(signal);
        const body = await bodyFor(row, reference, readSignal, producer);
        return readObservationBytes({ body, identity: reference,
          selector: { offset: 0, maxBytes: TOOL_OBSERVATION_LIMITS.previewBytes }, signal: readSignal });
      }, { ...(signal ? { signal } : {}), whenBusy: "wait" });
      // Search's model projection is rebuilt from its complete retained
      // canonical text. A Search without a receipt dispatched no provider.
      const search = row.sourceKind === "search" ? { providerCall: row.executionReceipt !== null,
        original: await readPhase(row, reference, async () => {
          const readSignal = boundedSignal(signal);
          return readSearchOriginal({ body: await bodyFor(row, reference, readSignal, producer), identity: reference, signal: readSignal });
        }, { ...(signal ? { signal } : {}), whenBusy: "wait", wholeOriginal: true }) } : undefined;
      const original = (row.sourceKind === "mcp" || row.sourceKind === "workspace") &&
        options.wholeOriginalBytes !== undefined && reference.byteSize <= options.wholeOriginalBytes
        ? { value: await readPhase(row, reference, async () => {
            const readSignal = boundedSignal(signal);
            return readObservationOriginal({ body: await bodyFor(row, reference, readSignal, producer), identity: reference, signal: readSignal });
          }, { ...(signal ? { signal } : {}), whenBusy: "wait", wholeOriginal: true }) } : undefined;
      const after = await repository.readProducer(producer);
      if (after.state !== "READY" || after.checksum !== reference.checksum) throw unavailable();
      // Its thread sources let a bounded Search restore keep every numbered source.
      const receipt = search && row.executionReceipt !== null ? decodeSearchObservationReceipt(row.executionReceipt) : null;
      return { status: row.executionOutcome === "error" ? "error" as const : "complete" as const,
        projection: { observation: reference, fragmentKind: "serialized_json_text" as const, preview: preview.fragment,
          incomplete: !preview.completeDocument, reader: "read_tool_result" as const },
        ...(search ? { search: { ...search, ...(receipt ? { receipt: receipt.executions } : {}) } } : {}),
        ...(original ? { original: original.value } : {}) };
    },

    /** Usage and thread sources come only from the immutable receipt, never
     * from the model-facing original: Stop, storage loss or revocation of
     * model recall cannot turn a reported charge into an unbilled one. */
    async searchAccounting(producer: ObservationProducer) {
      const row = await repository.readSearchAccounting(producer);
      if (!row || row.executionReceipt === null) return [];
      const receipt = decodeSearchObservationReceipt(row.executionReceipt);
      if (!receipt) throw unavailable();
      return receipt.executions;
    }
  };
}
