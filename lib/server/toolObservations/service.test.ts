// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prisma, ToolObservation } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { memoryToolObservations } from "@/tests/support/toolObservations";
import { createObservationAdmission } from "./admission";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { createFileSystemStorageAdapter, type StorageAdapter } from "../uploads/storage";
import { observationFailure, TOOL_OBSERVATION_LIMITS } from "./contract";
import { ObservationStoreError } from "./repository";
import { createToolObservationService, type ToolObservationRepository } from "./service";
import { SEARCH_TOOL_RESULT_VERSION, searchToolResultContent, type SearchExecutionEvidence } from "../search/toolResult";
import { decodeSearchObservationReceipt, SEARCH_OBSERVATION_RECEIPT_BYTES, searchObservationReceipt } from "./searchReceipt";
import * as observability from "../observability";

const producer = { runId: "synthetic-run", userId: "synthetic-owner", toolCallId: "synthetic-call" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });

/** A service fault-injection double, not evidence of relational authorization
 * or concurrency. Those contracts have their own disposable Prisma tests. */
function fixture(storage: StorageAdapter = createMemoryStorageAdapter()) {
  let row: ToolObservation | null = null;
  let allowed = true;
  let sourceOriginal: unknown = null;
  const source = () => ({ ...row!, modelRun: { chatId: "synthetic-chat", assistantMessageId: "synthetic-answer",
    userMessageId: "synthetic-question" }, toolCall: { state: "complete" as const } });
  const repository = {
    reserve: vi.fn<ToolObservationRepository["reserve"]>(async (_context, sourceKind, reservedBytes) => {
      if (row) return { claimed: row.sourceKind === "skill" && row.state === "RESERVED", observation: row };
      row = { id: randomUUID().replaceAll("-", ""), modelRunId: producer.runId, toolCallId: producer.toolCallId,
        formatVersion: 1, sourceKind, sourceBinding: null, executionReceipt: null, state: "RESERVED", reservedBytes, executionOutcome: null, byteSize: null,
        checksum: null, storageMode: null, inlineText: null, storageKey: null, projection: null,
        sourceTruncated: false, maskable: false, leaseToken: null, leaseExpiresAt: null, failureCode: null,
        createdAt: new Date(), updatedAt: new Date() };
      return { claimed: true, observation: row };
    }),
    recordOutcome: vi.fn<ToolObservationRepository["recordOutcome"]>(async (_context, outcome) => { if (row && !row.executionOutcome) row.executionOutcome = outcome; }),
    recordSearchReceipt: vi.fn<ToolObservationRepository["recordSearchReceipt"]>(async (_context, receipt) => { row!.executionReceipt = JSON.parse(JSON.stringify(receipt)); }),
    beginWrite: vi.fn<ToolObservationRepository["beginWrite"]>(async (_context, value) => {
      const external = value.storageMode === "OBJECT";
      row = { ...row!, ...value, projection: value.projection as Prisma.JsonValue,
        state: external ? "STORING" : "READY", reservedBytes: value.byteSize,
        storageKey: external ? `tool-observations/v1/${row!.id}/synthetic-lease` : null,
        leaseToken: external ? "lease" : null };
      return row;
    }),
    finishWrite: vi.fn<ToolObservationRepository["finishWrite"]>(async () => { row = { ...row!, state: "READY", leaseToken: null }; return row; }),
    unavailable: vi.fn<ToolObservationRepository["unavailable"]>(async () => { if (row && row.state !== "READY") { row.state = "UNAVAILABLE"; row.reservedBytes = 0; } }),
    read: vi.fn<ToolObservationRepository["read"]>(async () => {
      if (!allowed || row?.state !== "READY") throw new ObservationStoreError("tool_observation_unavailable");
      return source();
    }),
    available: vi.fn<ToolObservationRepository["available"]>(async (_actor, ids) =>
      allowed && row?.state === "READY" && ids.every(id => id === row!.id)),
    readSource: vi.fn<ToolObservationRepository["readSource"]>(async () => ({ source: source(), original: sourceOriginal })),
    readProducer: vi.fn<ToolObservationRepository["readProducer"]>(async () => row!),
    loadProducerSource: vi.fn<ToolObservationRepository["loadProducerSource"]>(async () => sourceOriginal),
    readSearchAccounting: vi.fn<ToolObservationRepository["readSearchAccounting"]>(async () => row!)
  };
  const service = () => createToolObservationService({ repository, storage });
  const write = (original: unknown, extra: { maximumBytes?: number; signal?: AbortSignal; sourceOwned?: boolean } = {}) =>
    service().withReservation({ producer, source: extra.sourceOwned ? "knowledge" : "mcp", maximumBytes: 1024 * 1024, ...extra },
      receipt => receipt.store({ original, outcome: "complete", sourceTruncated: true, maskable: true }));
  /** The repository's next reservation when the run or branch budget cannot
   * admit its ceiling: claimed and degraded, with a zero ceiling. */
  const exhaust = () => {
    const reserve = repository.reserve.getMockImplementation()!;
    repository.reserve.mockImplementationOnce(async (context, source, _maximumBytes, binding) =>
      ({ ...await reserve(context, source, 0, binding), degraded: true as const }));
  };
  return { repository, storage, service, write, exhaust, row: () => row!, revoke: () => { allowed = false; },
    setSource: (original: unknown) => { sourceOriginal = original; } };
}

describe("observation storage and recall boundary", () => {
  it.each(["getObjectStream", "putObjectStream"] as const)("requires %s before a potentially large business dispatch", async method => {
    const f = fixture();
    delete f.storage[method];
    const business = vi.fn();
    await expect(f.service().withReservation({ producer, source: "mcp", maximumBytes: 10000 }, business))
      .rejects.toThrow("tool_observation_storage_unavailable");
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.reserve).not.toHaveBeenCalled();
  });

  it("keeps small inline originals readable without streaming, including error semantics in the source", async () => {
    const f = fixture();
    delete f.storage.getObjectStream;
    delete f.storage.putObjectStream;
    const original = { isError: true, text: ["accepted detail"] };
    const projection = await f.write(original, { maximumBytes: 2048 });
    expect(f.row().storageMode).toBe("INLINE");
    const read = await f.service().read(producer, { handle: projection.observation.handle });
    expect(JSON.parse(read.fragment)).toEqual(original);
    expect(read.incomplete).toBe(false);
    expect(read.observation.sourceTruncated).toBe(true);
    expect(JSON.stringify(read)).not.toContain("synthetic-owner");
  });

  it("finds the exact tail from the filesystem after discarding the original and service instance", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiqsa-observation-fs-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const f = fixture(createFileSystemStorageAdapter(directory));
    const original = { text: "abcd".repeat(100000), tail: { marker: "rare-Я😀", count: 271828 } };
    const exact = JSON.stringify(original);
    const projection = await f.write(original);
    original.tail.count = 0;
    original.text = "source changed after the accepted call";
    expect(f.row().storageMode).toBe("OBJECT");
    expect(projection.incomplete).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(TOOL_OBSERVATION_LIMITS.projectionBytes);
    const recalled = await f.service().read(producer, { handle: projection.observation.handle, query: "rare-Я😀" });
    expect(recalled.fragment).toBe(Buffer.from(exact).subarray(recalled.offset, recalled.endOffset).toString());
    expect(recalled.fragment).toContain('"count":271828');
    expect(f.repository.reserve).toHaveBeenCalledOnce();
    expect(f.repository.read).toHaveBeenCalledTimes(2);
    expect(recalled).not.toHaveProperty("storageKey");
  });

  it.each(["upload", "verification", "commit"])("preserves successful execution and prohibits a second dispatch after %s fails", async stage => {
    const storage = createMemoryStorageAdapter();
    const f = fixture(storage);
    if (stage === "upload") vi.spyOn(storage, "putObjectStream").mockRejectedValue(new Error("private-upload-error"));
    if (stage === "verification") vi.spyOn(storage, "getObjectStream").mockRejectedValue(new Error("private-read-error"));
    if (stage === "commit") f.repository.finishWrite.mockRejectedValue(new Error("private-commit-error"));
    const business = vi.fn(async () => ({ value: "x".repeat(10000) }));
    const run = () => f.service().withReservation({ producer, source: "mcp", maximumBytes: 20000 }, async receipt =>
      receipt.store({ original: await business(), outcome: "complete", sourceTruncated: false, maskable: true }));
    await expect(run()).rejects.toThrow("tool_observation_unavailable");
    expect(f.row().executionOutcome).toBe("complete");
    expect(f.row().state).toBe("UNAVAILABLE");
    await expect(run()).rejects.toThrow("tool_observation_conflict");
    expect(business).toHaveBeenCalledOnce();
    expect(f.repository.unavailable).toHaveBeenCalledWith(producer, "tool_observation_unavailable", "lease");
  });

  it("checks written bytes before READY even if the adapter silently corrupts them", async () => {
    const storage = createMemoryStorageAdapter();
    const write = storage.putObjectStream!.bind(storage);
    vi.spyOn(storage, "putObjectStream").mockImplementation(async value => {
      await write(value);
      const object = storage.objects.get(value.storageKey)!;
      object.body[object.body.length - 5] ^= 1;
    });
    const f = fixture(storage);
    await expect(f.write({ text: "x".repeat(10000) })).rejects.toThrow("tool_observation_unavailable");
    expect(f.repository.finishWrite).not.toHaveBeenCalled();
    expect(f.row().executionOutcome).toBe("complete");
  });

  it("retains the source transport failure without claiming a storage preflight stopped its dispatch", async () => {
    const f = fixture();
    const failure = Object.assign(new Error("bounded_response_rejected"), { code: "mcp_response_too_large" });
    await expect(f.service().withReservation({ producer, source: "mcp", maximumBytes: 10000 }, async () => { throw failure; }))
      .rejects.toBe(failure);
    expect(f.row()).toMatchObject({ executionOutcome: "unknown", state: "UNAVAILABLE" });
    const another = fixture();
    await expect(another.service().withReservation({ producer, source: "mcp", maximumBytes: 20000 }, async receipt => {
      delete another.storage.putObjectStream;
      return receipt.store({ original: { text: "x".repeat(10000) }, outcome: "complete", sourceTruncated: false, maskable: true });
    })).rejects.toMatchObject({ code: "tool_observation_unavailable" });
    expect(another.row().executionOutcome).toBe("complete");
  });

  it("suppresses a fragment when access is revoked during storage I/O", async () => {
    const storage = createMemoryStorageAdapter();
    const f = fixture(storage);
    const projection = await f.write({ text: "x".repeat(10000) });
    const read = storage.getObjectStream!.bind(storage);
    vi.spyOn(storage, "getObjectStream").mockImplementation(async (key, options) => {
      const result = await read(key, options);
      f.revoke();
      return result;
    });
    await expect(f.service().read(producer, { handle: projection.observation.handle }))
      .rejects.toThrow("tool_observation_unavailable");
    expect(f.repository.read).toHaveBeenCalledTimes(2);
  });

  it("checks availability of a handle set in one repository call without reading any object", async () => {
    const storage = createMemoryStorageAdapter();
    const f = fixture(storage);
    const projection = await f.write({ text: "x".repeat(10000) });
    expect(f.row().storageMode).toBe("OBJECT");
    const objectReads = vi.spyOn(storage, "getObjectStream");
    const handles = Array.from({ length: 50 }, () => projection.observation.handle);
    await expect(f.service().available(producer, handles)).resolves.toBe(true);
    expect(f.repository.available).toHaveBeenCalledOnce();
    expect(f.repository.available).toHaveBeenCalledWith(producer, [f.row().id]);
    expect(f.repository.read).not.toHaveBeenCalled();
    expect(f.repository.readSource).not.toHaveBeenCalled();
    expect(objectReads).not.toHaveBeenCalled();
    // A malformed handle is unavailable without a lookup; a refusal is unavailable.
    await expect(f.service().available(producer, ["tor1_not-a-handle"])).resolves.toBe(false);
    expect(f.repository.available).toHaveBeenCalledOnce();
    f.revoke();
    await expect(f.service().available(producer, handles)).resolves.toBe(false);
    // Database or storage infrastructure failures propagate for the caller to classify.
    f.repository.available.mockRejectedValueOnce(new Error("connection reset"));
    await expect(f.service().available(producer, handles)).rejects.toThrow("connection reset");
  });

  it("retains the known execution outcome after Stop and publishes no result", async () => {
    const f = fixture();
    const controller = new AbortController();
    await expect(f.service().withReservation({ producer, source: "workspace", maximumBytes: 10000, signal: controller.signal },
      async receipt => {
        controller.abort(new Error("synthetic_stop"));
        return receipt.store({ original: { text: "completed before Stop" }, outcome: "complete", sourceTruncated: false, maskable: true });
      })).rejects.toThrow("synthetic_stop");
    expect(f.row().executionOutcome).toBe("complete");
    expect(f.row().state).toBe("UNAVAILABLE");
    expect(f.repository.beginWrite).not.toHaveBeenCalled();
  });

  it("reads an exact source-owned receipt without a second object copy", async () => {
    const f = fixture();
    delete f.storage.getObjectStream;
    delete f.storage.putObjectStream;
    const original = { evidence: "source-owned ".repeat(1000), citation: "accepted-handle" };
    f.setSource(original);
    const projection = await f.write(original, { sourceOwned: true });
    expect(f.row()).toMatchObject({ storageMode: "SOURCE", storageKey: null, inlineText: null });
    const read = await f.service().read(producer, { handle: projection.observation.handle, query: "accepted-handle" });
    expect(read.fragment).toContain("accepted-handle");
    expect(f.repository.readSource).toHaveBeenCalledOnce();
  });

  it.each(["😀", "Я", '"', "\\", "©", "☀"])("bounds bytes and estimated tokens for %s-heavy fragments", async char => {
    const f = fixture();
    const projection = await f.write({ text: char.repeat(10000) });
    const read = await f.service().read(producer, { handle: projection.observation.handle });
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(TOOL_OBSERVATION_LIMITS.readerBytes);
    expect(estimateApproxTokens(read)).toBeLessThanOrEqual(TOOL_OBSERVATION_LIMITS.readerEstimatedTokens);
    expect(read.cursor).not.toBeNull();
  });

  it("shortens a pictograph-dense fragment instead of refusing it and continues exactly at the cut", async () => {
    const f = fixture();
    const original = { text: "©☀".repeat(6000) + "tail" };
    const exact = Buffer.from(JSON.stringify(original));
    const projection = await f.write(original);
    const first = await f.service().read(producer, { handle: projection.observation.handle, maxBytes: 6144 });
    expect(first.endOffset - first.offset).toBeLessThan(6144);
    expect(first.endOffset - first.offset).toBeGreaterThan(1024);
    expect(first.fragment).toBe(exact.subarray(first.offset, first.endOffset).toString());
    expect(first.incomplete).toBe(true);
    expect(estimateApproxTokens(first)).toBeLessThanOrEqual(TOOL_OBSERVATION_LIMITS.readerEstimatedTokens);
    const next = await f.service().read(producer, { handle: projection.observation.handle, cursor: first.cursor!, maxBytes: 6144 });
    expect(next.offset).toBe(first.endOffset);
    expect(next.fragment).toBe(exact.subarray(next.offset, next.endOffset).toString());
  });
});

describe("observation admission holds storage phases, not business calls", () => {
  function gate() {
    let open!: () => void;
    const promise = new Promise<void>(resolve => { open = resolve; });
    return { promise, open };
  }
  const actor = { runId: "admission-run", userId: "admission-owner" };
  const call = (toolCallId: string) => ({ ...actor, toolCallId });

  it("lets other callers dispatch and read while slow business calls are in flight", async () => {
    const observations = memoryToolObservations();
    const admission = createObservationAdmission(1024 * 1024, 1);
    const service = createToolObservationService({ repository: observations.repository, storage: observations.storage, admission });
    const saved = await service.withReservation({ producer: call("saved"), source: "mcp", maximumBytes: 1024 * 1024 },
      receipt => receipt.store({ original: { text: `${"x".repeat(300_000)} rare-saved` }, outcome: "complete", sourceTruncated: false, maskable: true }));
    const gates = Array.from({ length: 8 }, gate);
    const started: number[] = [];
    const slow = gates.map((current, index) => service.withReservation({ producer: call(`slow-${index}`), source: "workspace",
      maximumBytes: 1024 * 1024 }, async receipt => {
      started.push(index);
      await current.promise;
      return receipt.store({ original: { text: "y".repeat(20_000) }, outcome: "complete", sourceTruncated: false, maskable: true });
    }));
    await vi.waitFor(() => expect(started).toHaveLength(8));
    expect(admission.busy()).toBe(false);
    const read = await service.read(actor, { handle: saved.observation.handle, query: "rare-saved" });
    expect(read.fragment).toContain("rare-saved");
    const fresh = await service.withReservation({ producer: call("fresh"), source: "mcp", maximumBytes: 1024 * 1024 },
      receipt => receipt.store({ original: { text: "fresh" }, outcome: "complete", sourceTruncated: false, maskable: true }));
    expect(fresh.observation.byteSize).toBeGreaterThan(0);
    for (const current of gates) current.open();
    expect((await Promise.all(slow)).every(projection => projection.incomplete)).toBe(true);
  });

  it("refuses new dispatches and reads transiently while storage is saturated, without a budget message", async () => {
    const observations = memoryToolObservations();
    const admission = createObservationAdmission(1024 * 1024, 1);
    const service = createToolObservationService({ repository: observations.repository, storage: observations.storage, admission });
    const saved = await service.withReservation({ producer: call("saved"), source: "mcp", maximumBytes: 1024 * 1024 },
      receipt => receipt.store({ original: { text: "z".repeat(20_000) }, outcome: "complete", sourceTruncated: false, maskable: true }));
    const holder = gate();
    const holding = admission(1024 * 1024, () => holder.promise);
    const waiting = admission(1, async () => undefined, { whenBusy: "wait" });
    const business = vi.fn();
    const refused = await service.withReservation({ producer: call("refused"), source: "search", maximumBytes: 1024 * 1024 }, business)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "tool_observation_busy" });
    expect(business).not.toHaveBeenCalled();
    expect(observations.rows.has("refused")).toBe(false);
    expect(observationFailure(refused)?.message).not.toMatch(/budget|exhausted/iu);
    await expect(service.read(actor, { handle: saved.observation.handle })).rejects.toMatchObject({ code: "tool_observation_busy" });
    holder.open();
    await Promise.all([holding, waiting]);
    expect((await service.read(actor, { handle: saved.observation.handle })).fragment).toContain("zzzz");
  });

  it("reports a reservation refused by run or call authority as not started, never as a lost result", async () => {
    const f = fixture();
    f.repository.reserve.mockRejectedValueOnce(new ObservationStoreError("tool_observation_not_started"));
    const business = vi.fn();
    const refused = await f.service().withReservation({ producer, source: "mcp", maximumBytes: 1024 * 1024 }, business)
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: "tool_observation_not_started" });
    expect(business).not.toHaveBeenCalled();
    expect(f.repository.unavailable).not.toHaveBeenCalled();
    expect(f.repository.recordOutcome).not.toHaveBeenCalled();
    expect(observationFailure(refused)?.message).not.toMatch(/may have completed|retr(y|ied)/iu);
    // A failure after dispatch keeps its no-replay unavailability.
    const lost = await f.service().withReservation({ producer, source: "mcp", maximumBytes: 1024 * 1024 }, async () => {
      throw new ObservationStoreError("tool_observation_unavailable");
    }).catch((error: unknown) => error);
    expect(lost).toMatchObject({ code: "tool_observation_unavailable" });
    expect(observationFailure(lost)?.message).toMatch(/may have completed/iu);
  });

  it("still dispatches a call beyond the retained-bytes budget, keeping its outcome as a receipt and retaining nothing", async () => {
    const f = fixture();
    f.exhaust();
    const events: unknown[] = [];
    const logged = vi.spyOn(observability, "logEvent").mockImplementation((event, fields) => { events.push({ event, fields }); });
    cleanups.push(async () => { logged.mockRestore(); });
    const business = vi.fn(async () => ({ text: "PRIVATE_RESULT ".repeat(1000) }));
    const delivered = await f.service().withReservation({ producer, source: "mcp", maximumBytes: 1024 * 1024 }, async receipt => {
      expect(receipt.retained).toBe(false);
      const original = await business();
      // Nothing can be stored: the caller delivers the result as Off does.
      await expect(receipt.store({ original, outcome: "complete", sourceTruncated: false, maskable: true }))
        .rejects.toMatchObject({ code: "tool_observation_conflict" });
      await receipt.recordUnretained("complete");
      return original;
    });
    expect(delivered.text).toContain("PRIVATE_RESULT");
    expect(business).toHaveBeenCalledOnce();
    expect(f.repository.beginWrite).not.toHaveBeenCalled();
    expect(f.repository.unavailable).toHaveBeenCalledWith(producer, "tool_observation_budget_degraded");
    expect(f.row()).toMatchObject({ state: "UNAVAILABLE", executionOutcome: "complete", reservedBytes: 0,
      storageMode: null, storageKey: null, inlineText: null, maskable: false });
    // One content-free counter per degraded reservation, never a refusal.
    expect(events).toEqual([{ event: "tool_execution", fields: { tool_kind: "mcp", stage: "admission",
      code: "tool_observation_budget_degraded", outcome: "degraded", reason: "policy", action: "degrade" } }]);
    // The receipt forbids a replay; there is no retained result to restore.
    await expect(f.service().withReservation({ producer, source: "mcp", maximumBytes: 1024 * 1024 }, business))
      .rejects.toMatchObject({ code: "tool_observation_conflict" });
    const restore = await f.service().restore(producer).then(() => null, (error: unknown) => error);
    expect(restore).toMatchObject({ code: "tool_observation_unavailable" });
    expect(business).toHaveBeenCalledOnce();
  });

  it("keeps an unretained call's outcome after Stop and fails closed when a callback skips its receipt", async () => {
    const f = fixture();
    f.exhaust();
    const controller = new AbortController();
    await expect(f.service().withReservation({ producer, source: "workspace", maximumBytes: 10000, signal: controller.signal },
      async receipt => {
        controller.abort(new Error("synthetic_stop"));
        return receipt.recordUnretained("error");
      })).rejects.toThrow("synthetic_stop");
    expect(f.row()).toMatchObject({ state: "UNAVAILABLE", executionOutcome: "error" });
    const skipped = fixture();
    skipped.exhaust();
    await expect(skipped.service().withReservation({ producer, source: "search", maximumBytes: 10000 }, async () => "executed"))
      .rejects.toMatchObject({ code: "tool_observation_unavailable" });
    expect(skipped.row()).toMatchObject({ state: "UNAVAILABLE", executionOutcome: "unknown" });
  });

  it("records the executed outcome before an original waits for capacity, then publishes it", async () => {
    const observations = memoryToolObservations();
    const admission = createObservationAdmission(1024 * 1024, 1);
    const service = createToolObservationService({ repository: observations.repository, storage: observations.storage, admission });
    const holder = gate();
    const holding = admission(1024 * 1024, () => holder.promise);
    const business = vi.fn(async () => ({ text: "w".repeat(20_000) }));
    const pending = service.withReservation({ producer: call("queued"), source: "mcp", maximumBytes: 1024 * 1024 },
      async receipt => receipt.store({ original: await business(), outcome: "complete", sourceTruncated: false, maskable: true }));
    // A crash here leaves a dispatched producer with its known outcome for
    // recovery, never an unreserved running call that was not dispatched.
    await vi.waitFor(() => expect(observations.rows.get("queued")).toMatchObject({ state: "RESERVED", executionOutcome: "complete" }));
    expect(business).toHaveBeenCalledOnce();
    holder.open();
    await holding;
    expect((await pending).observation.byteSize).toBeGreaterThan(20_000);
    expect(observations.rows.get("queued")).toMatchObject({ state: "READY", storageMode: "OBJECT" });
  });
});

describe("Search observation receipts", () => {
  const call = { id: "synthetic-call", name: "synthetic_tool", arguments: {} };

  it("bounds the Search receipt by dropping snippets, then trailing sources, never usage", () => {
    const executions: SearchExecutionEvidence[] = [1, 2, 3].map(index => ({ displayName: `Source ${index}`,
      invocationId: `invocation-${index}`, modelId: "model", optionId: `option-${index}`, provider: "provider",
      revisionId: `revision-${index}`, findings: "Synthetic findings", status: "complete",
      sources: Array.from({ length: 20 }, (_, rank) => ({ rank: rank + 1, title: `Title ${index}-${rank} ${"t".repeat(400)}`,
        url: `https://example.com/${index}/${rank}/${"p".repeat(900)}`, snippet: "s".repeat(1900) })),
      usage: { inputTokens: index, outputTokens: 1, totalTokens: index + 1 } }));
    const receipt = searchObservationReceipt({ callId: call.id, name: call.name, status: "complete",
      content: searchToolResultContent(executions), rawPreview: { searchResultVersion: SEARCH_TOOL_RESULT_VERSION, searchExecutions: executions } });
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThanOrEqual(SEARCH_OBSERVATION_RECEIPT_BYTES);
    expect(receipt.executions.map(execution => execution.usage.totalTokens)).toEqual([2, 3, 4]);
    expect(receipt.executions.every(execution => execution.sources.every(source => source.snippet === undefined))).toBe(true);
    expect(receipt.executions[0]!.sources.length).toBeGreaterThan(0);
    expect(receipt.executions[0]!.sources.length).toBeLessThan(20);
    expect(receipt.executions[0]!.sources[0]).toEqual({ rank: 1, title: executions[0]!.sources[0]!.title, url: executions[0]!.sources[0]!.url });
    // PostgreSQL JSON reorders object keys; the receipt must still decode.
    const reordered = { version: 1, executions: receipt.executions.map(execution => ({ ...execution,
      sources: execution.sources.map(({ url, title, rank }) => ({ url, title, rank })) })) };
    expect(decodeSearchObservationReceipt(reordered)).toEqual(receipt);
    expect(decodeSearchObservationReceipt({ ...reordered, executions: [{ ...reordered.executions[0]!,
      sources: [{ url: "javascript:alert(1)", title: "Unsafe", rank: 1 }] }] })).toBeNull();
  });
});
