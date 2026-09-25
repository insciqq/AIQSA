import { randomUUID } from "node:crypto";
import type { Prisma, ToolObservation } from "@prisma/client";
import { vi } from "vitest";
import { ObservationStoreError } from "@/lib/server/toolObservations/contract";
import { createToolObservationService, type ToolObservationRepository } from "@/lib/server/toolObservations/service";
import type { ObservationProducer } from "@/lib/server/toolObservations/repository";
import { createMemoryStorageAdapter } from "./storage";

/** Pipeline/storage fault double. Real authorization, locking and source-owner
 * semantics are verified separately with the disposable Prisma repository. */
export function memoryToolObservations(loadSource: (producer: ObservationProducer) => unknown = () => null) {
  const rows = new Map<string, ToolObservation>();
  const storage = createMemoryStorageAdapter();
  let allowed = true;
  const get = (context: ObservationProducer) => {
    const row = rows.get(context.toolCallId);
    if (!row || row.modelRunId !== context.runId) throw new ObservationStoreError("tool_observation_unavailable");
    return row;
  };
  const repository: ToolObservationRepository = {
    async reserve(context, sourceKind, reservedBytes, sourceBinding) {
      const existing = rows.get(context.toolCallId);
      // Mirrors the repository: only an unpublished Skill producer is re-claimed.
      if (existing) return { claimed: existing.sourceKind === "skill" && existing.state === "RESERVED", observation: existing };
      const row: ToolObservation = { id: randomUUID().replaceAll("-", ""), modelRunId: context.runId,
        toolCallId: context.toolCallId, formatVersion: 1, sourceKind, sourceBinding: sourceBinding as Prisma.JsonValue ?? null,
        executionReceipt: null, state: "RESERVED", executionOutcome: null, reservedBytes, byteSize: null, checksum: null,
        storageMode: null, inlineText: null, storageKey: null, projection: null, sourceTruncated: false, maskable: false,
        leaseToken: null, leaseExpiresAt: null, failureCode: null, createdAt: new Date(), updatedAt: new Date() };
      rows.set(context.toolCallId, row);
      return { claimed: true, observation: row };
    },
    async recordOutcome(context, outcome) { get(context).executionOutcome ??= outcome; },
    async recordSearchReceipt(context, receipt) { get(context).executionReceipt = JSON.parse(JSON.stringify(receipt)); },
    async readProducer(context) {
      if (!allowed) throw new ObservationStoreError("tool_observation_unavailable");
      return get(context);
    },
    async beginWrite(context, value) {
      const row = get(context);
      Object.assign(row, value, { state: value.storageMode === "OBJECT" ? "STORING" : "READY", reservedBytes: value.byteSize,
        ...(value.storageMode === "OBJECT" ? { storageKey: `tool-observations/v1/${row.id}/test`, leaseToken: "test-lease" } : {}) });
      return row;
    },
    async finishWrite(context) {
      const row = get(context);
      Object.assign(row, { state: "READY", leaseToken: null });
      return row;
    },
    async unavailable(context, code) {
      const row = get(context);
      if (row.state !== "READY") Object.assign(row, { state: "UNAVAILABLE", reservedBytes: 0, failureCode: code });
    },
    async read(actor, id) {
      const row = [...rows.values()].find(row => row.id === id && row.modelRunId === actor.runId);
      if (!allowed || row?.state !== "READY") throw new ObservationStoreError("tool_observation_unavailable");
      return { ...row, modelRun: { chatId: "chat-1", assistantMessageId: "assistant-1" }, toolCall: { state: "complete" as const } };
    },
    async readSource(actor, id) {
      const source = await repository.read(actor, id);
      return { source, original: loadSource({ ...actor, toolCallId: source.toolCallId }) };
    },
    async loadProducerSource(context) { return loadSource(context); },
    async readSearchAccounting(context) { return rows.get(context.toolCallId) ?? null; }
  };
  const service = () => createToolObservationService({ repository, storage });
  return { rows, storage, service, repository, revoke: () => { allowed = false; },
    failWrites: () => vi.spyOn(storage, "putObjectStream").mockRejectedValue(new Error("synthetic_storage_failure")) };
}
