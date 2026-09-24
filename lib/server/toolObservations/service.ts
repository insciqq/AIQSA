import type { ToolObservation } from "@prisma/client";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { getStoredObjectStream, type StorageAdapter } from "../uploads/storage";
import { admitToolObservation } from "./admission";
import { ObservationReadError, readObservationBytes } from "./byteReader";
import { measureObservationJson, observationJsonStream, OBSERVATION_ENCODING } from "./codec";
import { decodeToolObservationDescriptor, decodeToolObservationReadInput, toolObservationCursor, ObservationStoreError,
  TOOL_OBSERVATION_LIMITS, type ToolObservationDescriptor, type ToolObservationSource, type ToolObservationSourceBinding } from "./contract";
import type { ObservationActor, ObservationProducer, createToolObservationRepository } from "./repository";
import { readSearchAccounting } from "./searchAccounting";
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

export function createToolObservationService(input: Readonly<{
  repository: ToolObservationRepository;
  storage: StorageAdapter;
}>) {
  const { repository, storage } = input;
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
  return {
    /** Reservation and streaming preflight precede the callback, including a
     * business call whose successful result later cannot be saved. A repeated
     * reservation never calls the callback: recovery must use its receipt. */
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
      storeSource(value: Readonly<{ outcome: "complete" | "error"; sourceTruncated: boolean; maskable: boolean }>): Promise<ToolObservationProjection>;
      recordSearch(result: ToolExecutionResult): Promise<void>;
    }>) => Promise<T>): Promise<T> {
      const { producer, signal } = options;
      if (options.sourceOwned && options.source !== "skill" && options.source !== "knowledge") throw unavailable();
      if (!options.sourceOwned && options.maximumBytes > TOOL_OBSERVATION_LIMITS.inlineBytes) requireStreaming(storage);
      return admitToolObservation(async () => {
        const reservation = await repository.reserve(producer, options.source, options.maximumBytes, options.sourceBinding);
        if (!reservation.claimed) throw new ObservationStoreError("tool_observation_conflict");
        let stored = false;
        let attempted = false;
        let token: string | undefined;
        try {
          const store = async (value: Readonly<{ original: unknown; outcome: "complete" | "error";
            sourceTruncated: boolean; maskable: boolean }>): Promise<ToolObservationProjection> => {
            if (attempted) throw new ObservationStoreError("tool_observation_conflict");
            attempted = true;
            // Preserve known execution independently of storage or Stop.
            await repository.recordOutcome(producer, value.outcome);
            signal?.throwIfAborted();
            const identity = measureObservationJson(value.original, options.maximumBytes,
              Math.min(options.maximumBytes, TOOL_OBSERVATION_LIMITS.inlineBytes));
            const reference = descriptor({ ...reservation.observation, ...identity,
              sourceTruncated: value.sourceTruncated, maskable: value.maskable });
            const preview = await readObservationBytes({ body: observationJsonStream(value.original, options.maximumBytes),
              identity, selector: { offset: 0, maxBytes: TOOL_OBSERVATION_LIMITS.previewBytes }, signal });
            const projection: ToolObservationProjection = { observation: reference, fragmentKind: "serialized_json_text",
              preview: preview.fragment, incomplete: !preview.completeDocument, reader: "read_tool_result" };
            // This is the only copy retained in a checkpoint, never the full
            // externalized original. Source-owned instructions remain pinned.
            if (Buffer.byteLength(JSON.stringify(projection)) > TOOL_OBSERVATION_LIMITS.projectionBytes) throw unavailable();
            const storageMode = options.sourceOwned ? "SOURCE" : identity.inline !== null ? "INLINE" : "OBJECT";
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
          const result = await work({ store, async recordSearch(result) {
            if (options.source !== "search") throw unavailable();
            await repository.recordSearchReceipt(producer, searchObservationReceipt(result));
            await repository.recordOutcome(producer, result.status);
          }, async storeSource(value) {
            if (!options.sourceOwned) throw unavailable();
            await repository.recordOutcome(producer, value.outcome);
            return store({ ...value, original: await repository.loadProducerSource(producer) });
          } });
          if (!stored) throw unavailable();
          return result;
        } catch (error) {
          // A storage/settlement failure is not permission to dispatch again.
          // The owner also retains its existing external dispatch receipt.
          // If the database itself is unavailable, leave the pre-existing
          // reservation/deletion lease for recovery rather than leaking a raw
          // database error or pretending cleanup completed.
          await repository.recordOutcome(producer, "unknown").catch(() => undefined);
          await repository.unavailable(producer, "tool_observation_unavailable", token).catch(() => undefined);
          if (signal?.aborted) throw signal.reason;
          // The source keeps its precise transport/validation failure. Once
          // store() starts, never claim a storage preflight prevented dispatch.
          if (!attempted) throw error;
          throw error instanceof ObservationStoreError &&
            (error.code === "tool_observation_conflict" || error.code === "tool_observation_unavailable") ? error : unavailable();
        }
      }, signal);
    },

    async read(actor: ObservationActor, value: unknown, signal?: AbortSignal) {
      const request = decodeToolObservationReadInput(value);
      return admitToolObservation(async () => {
        const current = await repository.read(actor, request.handle.slice(5));
        const reference = descriptor(current);
        if (request.expectedChecksum && request.expectedChecksum !== reference.checksum) throw unavailable();
        const readSignal = boundedSignal(signal);
        const body = await bodyFor(current, reference, readSignal, actor);
        const fragment = await readObservationBytes({ body, identity: reference, selector: request.selector, signal: readSignal });
        readSignal.throwIfAborted();
        // Access or source revocation during object I/O suppresses the bytes.
        const after = descriptor(await repository.read(actor, current.id));
        if (after.checksum !== reference.checksum || after.byteSize !== reference.byteSize) throw unavailable();
        const response = { observation: reference, fragmentKind: "serialized_json_text" as const,
          fragment: fragment.fragment, offset: fragment.offset, endOffset: fragment.endOffset,
          incomplete: !fragment.completeDocument, matchOffset: fragment.matchOffset,
          cursor: fragment.nextOffset === null ? null : toolObservationCursor(reference, fragment.nextOffset, request.selector.query) };
        if (Buffer.byteLength(JSON.stringify(response)) > TOOL_OBSERVATION_LIMITS.readerBytes ||
          estimateApproxTokens(response) > TOOL_OBSERVATION_LIMITS.readerEstimatedTokens) throw unavailable();
        return response;
      }, signal).catch(error => {
        if (signal?.aborted) throw signal.reason;
        throw error instanceof ObservationStoreError || error instanceof ObservationReadError ? error : unavailable();
      });
    },

    /** Recover the immutable receipt after READY but before call settlement.
     * Neither a missing reservation nor an unfinished upload is replayable. */
    async restore(producer: ObservationProducer, signal?: AbortSignal) {
      return admitToolObservation(async () => {
        const row = await repository.readProducer(producer);
        if (row.state !== "READY") throw unavailable();
        const reference = descriptor(row);
        const readSignal = boundedSignal(signal);
        const body = await bodyFor(row, reference, readSignal, producer);
        const preview = await readObservationBytes({ body, identity: reference,
          selector: { offset: 0, maxBytes: TOOL_OBSERVATION_LIMITS.previewBytes }, signal: readSignal });
        const after = await repository.readProducer(producer);
        if (after.state !== "READY" || after.checksum !== reference.checksum) throw unavailable();
        return { status: row.executionOutcome === "error" ? "error" as const : "complete" as const,
          projection: { observation: reference, fragmentKind: "serialized_json_text" as const, preview: preview.fragment,
            incomplete: !preview.completeDocument, reader: "read_tool_result" as const } };
      }, signal);
    },

    async searchAccounting(producer: ObservationProducer) {
      return admitToolObservation(async () => {
        const row = await repository.readSearchAccounting(producer);
        if (!row) return [];
        const receipt = decodeSearchObservationReceipt(row.executionReceipt);
        if (!receipt && row.executionReceipt === null) return [];
        if (row.state !== "READY") return receipt?.executions ?? [];
        try {
          const identity = descriptor(row);
          const signal = boundedSignal();
          const body = await bodyFor(row, identity, signal);
          return await readSearchAccounting({ body, identity, signal });
        } catch {
          // Storage loss cannot turn known usage into an unbilled operation.
          // The model-facing read still fails closed on the same missing bytes.
          if (!receipt) throw unavailable();
          return receipt.executions;
        }
      });
    }
  };
}
