// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
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
import { captureMcpObservation, captureWorkspaceObservation, captureSearchObservation, captureOwnedObservation, projectObservationForProvider,
  observationRestoreRefused, observationWholeDeliveryBatches, restoreObservedResult, wholeDeliveryAllowance } from "./sourceAdapters";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { boundedRenderedSearchToolResultText, boundedRetainedSearchToolResultText, searchExecutionsFromToolResult, searchToolResultContent, searchToolResultText,
  type SearchExecutionEvidence } from "../search/toolResult";
import { mcpToolExecutionResult } from "../mcp/toolExecutor";
import { SearchToolCancelledError } from "../search/toolExecutor";
import { decodeSearchObservationReceipt, SEARCH_OBSERVATION_RECEIPT_BYTES, searchObservationReceipt } from "./searchReceipt";
import type { ToolExecutionResult } from "../tools/types";
import { ObservationReadError } from "./byteReader";
import { McpToolAccessDeniedError } from "../mcp/toolAccess";

const producer = { runId: "synthetic-run", userId: "synthetic-owner", toolCallId: "synthetic-call" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const clean of cleanups.splice(0)) await clean(); });

/** A service fault-injection double, not evidence of relational authorization
 * or concurrency. Those contracts have their own disposable Prisma tests. */
function fixture(storage: StorageAdapter = createMemoryStorageAdapter()) {
  let row: ToolObservation | null = null;
  let allowed = true;
  let sourceOriginal: unknown = null;
  const source = () => ({ ...row!, modelRun: { chatId: "synthetic-chat", assistantMessageId: "synthetic-answer" },
    toolCall: { state: "complete" as const } });
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
  return { repository, storage, service, write, row: () => row!, revoke: () => { allowed = false; },
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

describe("accepted observation source adapters", () => {
  const call = { id: "synthetic-call", name: "synthetic_tool", arguments: {} };
  const binding = { version: 1 as const, source: "mcp" as const, serverId: "server", originalName: "synthetic_tool",
    revisionId: "revision", fingerprint: "a".repeat(64) };
  const searchResult = (large = false): ToolExecutionResult => {
    const executions: SearchExecutionEvidence[] = [1, 2, 3].map(index => ({ displayName: `Source ${index}`,
      invocationId: `invocation-${index}`, modelId: "model", optionId: `option-${index}`, provider: "provider",
      revisionId: `revision-${index}`, findings: `${"z".repeat(large ? 128 * 1024 - 20 : 10)} rare-search-${index}`,
      status: "complete", sources: [{ rank: 1, title: `Title ${index}`, url: `https://example.com/${index}`, snippet: `Accepted snippet ${index}` }],
      usage: { inputTokens: 10 * index, outputTokens: index, totalTokens: 11 * index } }));
    return { name: call.name, callId: call.id, status: "complete", content: searchToolResultContent(executions),
      rawPreview: { providerCall: true, searchResultVersion: 2, searchExecutions: executions } };
  };
  const sources = [1, 2, 3].map(index => ({ optionId: `option-${index}`, revisionId: `revision-${index}` }));

  it("stores a large MCP original before normalization and recalls its tail without another business call", async () => {
    const f = fixture();
    const original = { isError: false, structuredContent: { rows: "m".repeat(300_000), tail: "rare-mcp-tail" },
      text: ["Unique explanation"], unsupportedContentTypes: [] };
    const execute = vi.fn(async () => original);
    const result = await captureMcpObservation({ service: f.service(), producer }, call, binding, execute);
    expect(JSON.stringify(result).length).toBeLessThan(8192);
    expect(snapshotToolExecutionResult(result, 256 * 1024)).not.toBeNull();
    original.structuredContent.tail = "changed-upstream";
    const read = await f.service().read(producer, { handle: result.observation!.handle, query: "rare-mcp-tail" });
    expect(read.fragment).toContain("rare-mcp-tail");
    expect(execute).toHaveBeenCalledOnce();
    expect((await f.service().restore(producer)).projection.observation).toEqual(result.observation);
    await f.storage.deleteObject(f.row().storageKey!);
    await expect(f.service().restore(producer)).rejects.toThrow();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("keeps small MCP model normalization separate from exact recall and refuses to mask unsupported parts", async () => {
    const f = fixture();
    const original = { isError: true, structuredContent: { value: 42 }, text: ['{"value":42}', "Unique detail"], unsupportedContentTypes: ["image"] };
    const result = await captureMcpObservation({ service: f.service(), producer }, call, binding, async () => original);
    expect(result.status).toBe("error");
    expect(result.observation?.maskable).toBe(false);
    expect(result.content.filter(part => part.type === "text").map(part => part.text)).toEqual(["Unique detail"]);
    const read = await f.service().read(producer, { handle: result.observation!.handle });
    expect(JSON.parse(read.fragment)).toEqual(original);
    expect(projectObservationForProvider(result).content).toHaveLength(result.content.length + 1);
  });

  it("keeps Workspace's accepted truncation and exit metadata after the mutable guest source changes", async () => {
    const f = fixture();
    let guest = `old ${"x".repeat(300_000)} rare-workspace-tail`;
    const execute = vi.fn(async (): Promise<ToolExecutionResult> => ({ callId: call.id, name: call.name, status: "error",
      content: [{ type: "text", text: guest }], rawPreview: { truncated: true, exitCode: 9, originalByteCount: 900_000 } }));
    const result = await captureWorkspaceObservation({ service: f.service(), producer }, call, execute);
    guest = "new unrelated guest content";
    const read = await f.service().read(producer, { handle: result.observation!.handle, query: "rare-workspace-tail", maxBytes: 1024 });
    expect(read.fragment).toContain("rare-workspace-tail");
    expect(read.fragment).toContain('"exitCode":9');
    expect(result).toMatchObject({ status: "error", observation: { sourceTruncated: true } });
    expect(execute).toHaveBeenCalledOnce();
  });

  const internalSearchFields = ["invocation-", "option-", "revision-", "inputTokens", "totalTokens", "estimatedCostMicros", "usage"];

  it("gives the model the same canonical Search text as Off and retains only that model-facing text", async () => {
    const f = fixture();
    const off = searchResult();
    const result = await captureSearchObservation({ service: f.service(), producer }, call, sources, async () => searchResult());
    expect(result.content).toEqual(off.content);
    const executions = off.rawPreview!.searchExecutions as SearchExecutionEvidence[];
    expect(result.content).toEqual([{ type: "text", text: searchToolResultText(executions) }]);
    expect(result).not.toHaveProperty("usage");
    const visible = JSON.stringify(projectObservationForProvider(result).content);
    expect(visible).toContain("1. Title 1 — https://example.com/1");
    expect(visible).toContain(result.observation!.handle);
    for (const field of internalSearchFields) expect(visible).not.toContain(field);
    // The checkpoint keeps the same text and descriptor, never the compact original.
    const checkpoint = JSON.stringify(snapshotToolExecutionResult(result, 256 * 1024));
    for (const field of internalSearchFields) expect(checkpoint).not.toContain(field);
    // The reader serves exactly the text Off delivers; accounting stays in the receipt.
    const saved = (await f.service().read(producer, { handle: result.observation!.handle })).fragment;
    expect(JSON.parse(saved)).toEqual({ status: "complete", content: [{ type: "text", text: searchToolResultText(executions) }] });
    for (const field of internalSearchFields) expect(saved).not.toContain(field);
    expect((await f.service().searchAccounting(producer)).map(execution => execution.invocationId))
      .toEqual(["invocation-1", "invocation-2", "invocation-3"]);
    // A restart before settlement restores the same text.
    expect(await restoreObservedResult({ service: f.service(), producer }, call)).toEqual(result);
  });

  it("accounts an ordinary three-engine Search with the same thread sources and snippets Off persists", async () => {
    const f = fixture();
    const executions: SearchExecutionEvidence[] = [1, 2, 3].map(index => ({ displayName: `Source ${index}`,
      invocationId: `invocation-${index}`, modelId: "model", optionId: `option-${index}`, provider: "provider",
      revisionId: `revision-${index}`, findings: `Synthetic findings ${index}`, status: "complete",
      sources: Array.from({ length: 20 }, (_, rank) => {
        const url = `https://example.com/${index}/${rank}/`;
        return { rank: rank + 1, title: `Title ${index}-${rank}`, url: url + "p".repeat(400 - url.length), snippet: `${rank}`.padEnd(300, "s") };
      }),
      usage: { inputTokens: 10 * index, outputTokens: index, totalTokens: 11 * index } }));
    const off: ToolExecutionResult = { name: call.name, callId: call.id, status: "complete", content: searchToolResultContent(executions),
      rawPreview: { providerCall: true, searchResultVersion: 2, searchExecutions: executions } };
    await captureSearchObservation({ service: f.service(), producer }, call, sources, async () => off);
    // Both paths persist one SearchRun per execution from these sources.
    const accounted = await f.service().searchAccounting(producer);
    expect(accounted.map(execution => execution.sources)).toEqual(searchExecutionsFromToolResult(off).map(execution => execution.sources));
    expect(accounted.flatMap(execution => execution.sources).every(source => source.snippet?.length === 300)).toBe(true);
  });

  it("externalizes canonical Search once and keeps usage and thread sources in the receipt when its object is lost", async () => {
    const f = fixture();
    const execute = vi.fn(async () => searchResult(true));
    const result = await captureSearchObservation({ service: f.service(), producer }, call, sources, execute);
    expect(f.row().byteSize).toBeGreaterThan(256 * 1024);
    const [part] = result.content;
    expect(result.content).toHaveLength(1);
    const text = part?.type === "text" ? part.text : "";
    // Off would have dropped these engines; the model receives their canonical
    // text within a bounded budget, every numbered source and the reader.
    expect(text.startsWith('Search source "Source 1":\nzzz')).toBe(true);
    expect(text).toContain("Findings shortened here");
    expect(text).toContain("Sources:\n1. Title 1 — https://example.com/1\n2. Title 2 — https://example.com/2\n3. Title 3 — https://example.com/3");
    expect(text).not.toContain("rare-search-1");
    expect(Buffer.byteLength(text)).toBeLessThan(80 * 1024);
    for (const field of internalSearchFields) expect(JSON.stringify(result)).not.toContain(field);
    expect(snapshotToolExecutionResult(result, 256 * 1024)).not.toBeNull();
    // A restore has only the retained text and the receipt: it bounds that
    // same text and keeps the receipt's numbered sources.
    const restored = await restoreObservedResult({ service: f.service(), producer }, call);
    const restoredText = restored.content[0]?.type === "text" ? restored.content[0].text : "";
    expect(restored).toMatchObject({ status: "complete", observation: result.observation });
    expect(restoredText.startsWith('Search source "Source 1":\nzzz')).toBe(true);
    expect(restoredText).toContain("Search result shortened here");
    expect(restoredText.endsWith("Sources:\n1. Title 1 — https://example.com/1\n2. Title 2 — https://example.com/2\n3. Title 3 — https://example.com/3"))
      .toBe(true);
    expect(snapshotToolExecutionResult(restored, 256 * 1024)).not.toBeNull();
    for (const field of internalSearchFields) expect(JSON.stringify(restored)).not.toContain(field);
    const tail = (await f.service().read(producer, { handle: result.observation!.handle, query: "rare-search-3" })).fragment;
    expect(tail).toContain("rare-search-3");
    for (const field of internalSearchFields) expect(tail).not.toContain(field);
    const accounting = await f.service().searchAccounting(producer);
    expect(accounting.map(execution => execution.usage.totalTokens)).toEqual([11, 22, 33]);
    expect(accounting[2]?.sources[0]?.snippet).toBe("Accepted snippet 3");
    expect(accounting.every(execution => execution.findings === undefined)).toBe(true);
    await f.storage.deleteObject(f.row().storageKey!);
    expect(await f.service().searchAccounting(producer)).toEqual(accounting);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("bounds the Search receipt by dropping snippets, then trailing sources, never usage", () => {
    const executions: SearchExecutionEvidence[] = [1, 2, 3].map(index => ({ displayName: `Source ${index}`,
      invocationId: `invocation-${index}`, modelId: "model", optionId: `option-${index}`, provider: "provider",
      revisionId: `revision-${index}`, findings: "Synthetic findings", status: "complete",
      sources: Array.from({ length: 20 }, (_, rank) => ({ rank: rank + 1, title: `Title ${index}-${rank} ${"t".repeat(400)}`,
        url: `https://example.com/${index}/${rank}/${"p".repeat(900)}`, snippet: "s".repeat(1900) })),
      usage: { inputTokens: index, outputTokens: 1, totalTokens: index + 1 } }));
    const receipt = searchObservationReceipt({ callId: call.id, name: call.name, status: "complete",
      content: searchToolResultContent(executions), rawPreview: { searchResultVersion: 2, searchExecutions: executions } });
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

  it("retains Search usage on Stop without publishing a reader handle", async () => {
    const f = fixture();
    const controller = new AbortController();
    await expect(captureSearchObservation({ service: f.service(), producer, signal: controller.signal }, call, sources, async () => {
      controller.abort(new Error("synthetic_stop"));
      throw new SearchToolCancelledError(searchResult(true), controller.signal.reason);
    })).rejects.toThrow("synthetic_stop");
    expect(f.row()).toMatchObject({ state: "UNAVAILABLE", executionOutcome: "complete", storageKey: null });
    expect((await f.service().searchAccounting(producer)).map(execution => execution.usage.totalTokens)).toEqual([11, 22, 33]);
  });

  it.each(["skill", "knowledge"] as const)("reuses the %s owner and preserves admitted content in the provider projection", async source => {
    const f = fixture();
    delete f.storage.getObjectStream;
    delete f.storage.putObjectStream;
    const original: ToolExecutionResult = { callId: call.id, name: source === "skill" ? "load_skill" : "search_knowledge", status: "complete",
      content: [{ type: "text", text: "Exact admitted instructions or citation evidence" }] };
    let settled = false;
    f.repository.loadProducerSource.mockImplementation(async () => {
      expect(settled).toBe(true);
      return original;
    });
    f.setSource(original);
    const result = await captureOwnedObservation({ service: f.service(), producer }, source,
      source === "skill" ? { version: 1, source, skillId: "skill", revisionId: "revision" } : undefined,
      async () => { settled = true; return original; });
    expect(f.row()).toMatchObject({ storageMode: "SOURCE", storageKey: null, inlineText: null });
    // Neither owner is maskable: instructions stay pinned, evidence stays whole.
    expect(result.observation?.maskable).toBe(false);
    expect(f.row()).toMatchObject({ maskable: false });
    const projected = projectObservationForProvider(result);
    expect(projected.content[0]).toEqual(original.content[0]);
    expect(JSON.parse((await f.service().read(producer, { handle: result.observation!.handle })).fragment)).toEqual(original);
  });

  const skillBinding = { version: 1 as const, source: "skill" as const, skillId: "skill", revisionId: "revision" };
  const instructions: ToolExecutionResult = { callId: call.id, name: "load_skill", status: "complete",
    content: [{ type: "text", text: "Exact admitted instructions" }] };

  it("loads a Skill again after a crash left its reservation unpublished", async () => {
    const f = fixture();
    delete f.storage.getObjectStream;
    delete f.storage.putObjectStream;
    await f.repository.reserve(producer, "skill", 256 * 1024, skillBinding);
    f.setSource(instructions);
    f.repository.loadProducerSource.mockImplementation(async () => instructions);
    const execute = vi.fn(async () => instructions);
    const result = await captureOwnedObservation({ service: f.service(), producer }, "skill", skillBinding, execute);
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ content: instructions.content, observation: { source: "skill", maskable: false } });
    expect(f.row()).toMatchObject({ state: "READY", storageMode: "SOURCE" });
  });

  it("keeps a settled Skill result when its descriptor cannot be published", async () => {
    const f = fixture();
    f.repository.beginWrite.mockRejectedValue(new ObservationStoreError("tool_observation_conflict"));
    f.repository.loadProducerSource.mockImplementation(async () => instructions);
    const result = await captureOwnedObservation({ service: f.service(), producer }, "skill", skillBinding, async () => instructions);
    expect(result).toEqual(instructions);
    expect(f.row()).toMatchObject({ state: "UNAVAILABLE", executionOutcome: "complete" });
  });

  it("executes an owner-claimed Skill without touching a producer that was already retired", async () => {
    const f = fixture();
    await f.repository.reserve(producer, "skill", 256 * 1024, skillBinding);
    await f.repository.unavailable(producer, "tool_observation_unavailable");
    const execute = vi.fn(async () => instructions);
    const result = await captureOwnedObservation({ service: f.service(), producer }, "skill", skillBinding, execute);
    expect(result).toEqual(instructions);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.repository.loadProducerSource).not.toHaveBeenCalled();
    expect(f.repository.recordOutcome).not.toHaveBeenCalled();
  });

  it("preserves a Knowledge error result that has no retrieval receipt", async () => {
    const f = fixture();
    const failure: ToolExecutionResult = { callId: call.id, name: "search_knowledge", status: "error",
      content: [{ type: "text", text: "Knowledge search failed: invalid query." }] };
    f.repository.loadProducerSource.mockRejectedValue(new ObservationStoreError("tool_observation_unavailable"));
    const result = await captureOwnedObservation({ service: f.service(), producer }, "knowledge", undefined, async () => failure);
    expect(result).toEqual(failure);
    expect(f.row()).toMatchObject({ state: "UNAVAILABLE", executionOutcome: "error" });
  });
});

describe("observed MCP and Workspace projections match Off", () => {
  const call = { id: "parity-call", name: "synthetic_tool", arguments: {} };
  const binding = { version: 1 as const, source: "mcp" as const, serverId: "server", originalName: "synthetic_tool",
    revisionId: "revision", fingerprint: "a".repeat(64) };
  /** Incompressible, never duplicated text of an exact UTF-8 size. */
  const unique = (bytes: number, seed: string) => Array.from({ length: Math.ceil(bytes / 64) },
    (_, index) => createHash("sha256").update(`${seed}:${index}`).digest("hex")).join("").slice(0, bytes);
  /** A quarter of a 128,000-token admitted budget. */
  const share = 32_000;
  const descriptorPart = (result: ToolExecutionResult) =>
    ({ type: "json", value: { observation: result.observation, reader: "read_tool_result" } });
  const mcpOriginal = (bytes: number) => ({ isError: false, structuredContent: null,
    text: [`${unique(bytes, "mcp")} rare-mcp-tail`], unsupportedContentTypes: [] });

  it("delivers a 100 KiB unique MCP result whole with its descriptor, and a restore repeats it", async () => {
    const f = fixture();
    const original = mcpOriginal(100 * 1024);
    const off = mcpToolExecutionResult(call, original);
    const result = await captureMcpObservation({ service: f.service(), producer, wholeDelivery: wholeDeliveryAllowance(share) }, call, binding,
      async () => original);
    expect(f.row()).toMatchObject({ state: "READY", storageMode: "OBJECT" });
    expect(result.observation).toMatchObject({ source: "mcp", maskable: true, byteSize: Buffer.byteLength(JSON.stringify(original)) });
    expect(result.content).toEqual(off.content);
    expect(projectObservationForProvider(result).content).toEqual([...off.content, descriptorPart(result)]);
    expect(snapshotToolExecutionResult(result, 256 * 1024)).not.toBeNull();
    // The reader still recalls the exact retained original.
    const read = await f.service().read(producer, { handle: result.observation!.handle, query: "rare-mcp-tail" });
    expect(read.fragment).toContain("rare-mcp-tail");
    // Ambiguous recovery restores the same projection live execution delivered.
    expect(await restoreObservedResult({ service: f.service(), producer, wholeDelivery: wholeDeliveryAllowance(share) }, call)).toEqual(result);
  });

  it("keeps the bounded preview for an MCP result above the persisted result bound, live and restored", async () => {
    const f = fixture();
    const result = await captureMcpObservation({ service: f.service(), producer, wholeDelivery: wholeDeliveryAllowance(Number.POSITIVE_INFINITY) },
      call, binding, async () => mcpOriginal(300 * 1024));
    expect(JSON.stringify(result.content)).not.toContain("rare-mcp-tail");
    expect(result.content).toEqual([{ type: "json", value: expect.objectContaining({ observation: result.observation,
      incomplete: true, reader: "read_tool_result" }) }]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(8192);
    expect(await restoreObservedResult({ service: f.service(), producer, wholeDelivery: wholeDeliveryAllowance(Number.POSITIVE_INFINITY) }, call))
      .toEqual(result);
  });

  it("keeps the bounded preview when the result alone would exceed a small window's share", async () => {
    const f = fixture();
    // A 16,000-token budget admits a 4,000-token share; 100 KiB is ~25,600 tokens.
    const context = { service: f.service(), producer, wholeDelivery: wholeDeliveryAllowance(4_000) };
    const result = await captureMcpObservation(context, call, binding, async () => mcpOriginal(100 * 1024));
    expect(JSON.stringify(result.content)).not.toContain("rare-mcp-tail");
    expect(result.content).toEqual([{ type: "json", value: expect.objectContaining({ observation: result.observation,
      reader: "read_tool_result" }) }]);
    expect(await restoreObservedResult(context, call)).toEqual(result);
    // An inline-sized original counts toward the share too.
    const small = fixture();
    const inline = await captureMcpObservation({ service: small.service(), producer, wholeDelivery: wholeDeliveryAllowance(1) }, call, binding,
      async () => mcpOriginal(4 * 1024));
    expect(small.row().storageMode).toBe("INLINE");
    expect(inline.content).toEqual([{ type: "json", value: expect.objectContaining({ observation: inline.observation,
      reader: "read_tool_result" }) }]);
    // Without a known window it stays whole, as Off delivers it.
    const unknown = fixture();
    const whole = await captureMcpObservation({ service: unknown.service(), producer,
      wholeDelivery: wholeDeliveryAllowance(Number.POSITIVE_INFINITY) }, call, binding, async () => mcpOriginal(4 * 1024));
    expect(whole.content).toEqual(mcpToolExecutionResult(call, mcpOriginal(4 * 1024)).content);
  });

  it("delivers a 40 KiB Workspace shell result whole with artifacts, exit and truncation metadata", async () => {
    const f = fixture();
    const stdout = `${unique(40 * 1024, "workspace")} rare-workspace-tail`;
    const shell: ToolExecutionResult = { callId: call.id, name: call.name, status: "complete",
      content: [{ type: "text", text: JSON.stringify({ ok: true, data: { exitCode: 0, stdout, stderr: "" } }) }],
      rawPreview: { exitCode: 0, originalByteCount: 900_000, truncated: true },
      artifacts: [{ type: "artifact", data: { artifactType: "workspace_activity", payload: { id: "activity-1" } } }] };
    const result = await captureWorkspaceObservation({ service: f.service(), producer, wholeDelivery: wholeDeliveryAllowance(share) }, call,
      async () => shell);
    expect(f.row()).toMatchObject({ state: "READY", storageMode: "OBJECT", sourceTruncated: true });
    expect(result).toEqual({ ...shell, observation: result.observation });
    expect(result.observation).toMatchObject({ source: "workspace", sourceTruncated: true, maskable: true });
    expect(projectObservationForProvider(result).content).toEqual([...shell.content, descriptorPart(result)]);
    expect(snapshotToolExecutionResult(result, 256 * 1024)).not.toBeNull();
    // Artifacts were never retained with the original; the model projection is identical.
    const { artifacts: _artifacts, ...withoutArtifacts } = result;
    expect(await restoreObservedResult({ service: f.service(), producer, wholeDelivery: wholeDeliveryAllowance(share) }, call)).toEqual(withoutArtifacts);
    // Above the share the bounded preview still carries artifacts and runtime metadata.
    const bounded = fixture();
    const preview = await captureWorkspaceObservation({ service: bounded.service(), producer, wholeDelivery: wholeDeliveryAllowance(1_000) }, call,
      async () => shell);
    expect(JSON.stringify(preview.content)).not.toContain("rare-workspace-tail");
    expect(preview).toMatchObject({ artifacts: shell.artifacts, rawPreview: shell.rawPreview, observation: { sourceTruncated: true } });
  });

  it("restores a Search result above the persisted bound with every numbered receipt source and its warnings", async () => {
    const f = fixture();
    const executions: SearchExecutionEvidence[] = [1, 2, 3].map((index): SearchExecutionEvidence => index === 3
      ? { displayName: "Source 3", invocationId: "invocation-3", modelId: "model", optionId: "option-3", provider: "provider",
        revisionId: "revision-3", failure: { code: "search_timeout" }, sources: [], status: "error",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      : { displayName: `Source ${index}`, invocationId: `invocation-${index}`, modelId: "model", optionId: `option-${index}`,
        provider: "provider", revisionId: `revision-${index}`, findings: `${unique(128 * 1024 - 40, `search-${index}`)} rare-search-${index}`,
        status: "complete", sources: Array.from({ length: 6 }, (_, rank) => ({ rank: rank + 1, title: `Title ${index}-${rank}`,
          url: `https://example.com/${index}/${rank}`, snippet: `Snippet ${index}-${rank}` })),
        usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } });
    const search: ToolExecutionResult = { name: call.name, callId: call.id, status: "complete",
      content: searchToolResultContent(executions), rawPreview: { providerCall: true, searchResultVersion: 2, searchExecutions: executions } };
    const canonical = searchToolResultText(executions);
    const tail = canonical.slice(canonical.lastIndexOf("\n\nSources:\n") + 2);
    expect(tail).toContain("12. Title 2-5 — https://example.com/2/5");
    expect(tail).toMatch(/\n\nSearch warnings: "Source 3": search_timeout$/u);
    const live = await captureSearchObservation({ service: f.service(), producer }, call,
      [1, 2, 3].map(index => ({ optionId: `option-${index}`, revisionId: `revision-${index}` })), async () => search);
    expect(f.row().byteSize).toBeGreaterThan(256 * 1024);
    const restored = await restoreObservedResult({ service: f.service(), producer }, call);
    const text = restored.content[0]?.type === "text" ? restored.content[0].text : "";
    expect(restored).toMatchObject({ status: "complete", observation: live.observation });
    expect(text.startsWith('Search source "Source 1":\n')).toBe(true);
    expect(text).toContain("Search result shortened here");
    expect(text.endsWith(`\n\n${tail}`)).toBe(true);
    expect(text).not.toContain("rare-search-2");
    expect(snapshotToolExecutionResult(restored, 256 * 1024)).not.toBeNull();
  });

  it("bounds rendered Search text only when the receipt names its exact source list", () => {
    const executions: SearchExecutionEvidence[] = [{ displayName: "Source", invocationId: "invocation", modelId: null,
      optionId: "option", provider: "provider", revisionId: "revision", findings: "f".repeat(4096), status: "complete",
      sources: [1, 2].map(rank => ({ rank, title: `Title ${rank}`, url: `https://example.com/${rank}` })),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }];
    const text = searchToolResultText(executions);
    const bounded = boundedRenderedSearchToolResultText(text, executions, 1024);
    expect(bounded).toContain("Search result shortened here");
    expect(bounded?.endsWith("\n\nSources:\n1. Title 1 — https://example.com/1\n2. Title 2 — https://example.com/2")).toBe(true);
    const trimmed = [{ ...executions[0]!, sources: executions[0]!.sources.slice(0, 1) }];
    expect(boundedRenderedSearchToolResultText(text, trimmed, 1024)).toBeNull();
    expect(boundedRenderedSearchToolResultText(`${text}\n\nforged trailer`, executions, 1024)).toBeNull();
  });
});

describe("observation review fixes: batch share, restore classification, Search receipts", () => {
  const binding = { version: 1 as const, source: "mcp" as const, serverId: "server", originalName: "synthetic_tool",
    revisionId: "revision", fingerprint: "a".repeat(64) };
  const unique = (bytes: number, seed: string) => Array.from({ length: Math.ceil(bytes / 64) },
    (_, index) => createHash("sha256").update(`${seed}:${index}`).digest("hex")).join("").slice(0, bytes);
  const mcpOriginal = (bytes: number, seed: string) => ({ isError: false, structuredContent: null,
    text: [unique(bytes, seed)], unsupportedContentTypes: [] });
  const isWhole = (result: ToolExecutionResult) => result.content.some(part => part.type === "text");
  const projectedTokens = (result: ToolExecutionResult) => estimateApproxTokens(projectObservationForProvider(result).content);

  it("delivers a batch whole only while its shared allowance lasts, and restores the same projections", async () => {
    const observations = memoryToolObservations();
    const actor = { runId: "batch-run", userId: "batch-owner" };
    const calls = [1, 2, 3, 4].map(index => ({ id: `batch-${index}`, name: "synthetic_tool", arguments: {} }));
    const probe = await captureMcpObservation({ service: memoryToolObservations().service(), producer: { ...actor, toolCallId: "probe" },
      wholeDelivery: wholeDeliveryAllowance(Number.POSITIVE_INFINITY) }, calls[0]!, binding, async () => mcpOriginal(12 * 1024, "probe"));
    // Room for exactly two whole 12 KiB results.
    const share = 2 * projectedTokens(probe) + 10;
    const live = observationWholeDeliveryBatches();
    const order: string[] = [];
    const results = await Promise.all(calls.map(call => captureMcpObservation({ service: observations.service(),
      producer: { ...actor, toolCallId: call.id }, wholeDelivery: live.allowance(3, share) }, call, binding,
      async () => mcpOriginal(12 * 1024, call.id)).then(result => { order.push(call.id); return result; })));
    const whole = results.filter(isWhole);
    expect(whole).toHaveLength(2);
    expect(whole.reduce((sum, result) => sum + projectedTokens(result), 0)).toBeLessThanOrEqual(share);
    for (const result of results.filter(result => !isWhole(result))) {
      expect(result.content).toEqual([{ type: "json", value: expect.objectContaining({ observation: result.observation,
        reader: "read_tool_result" }) }]);
    }
    // The next batch starts with its own allowance.
    expect(live.allowance(4, share).remainingTokens).toBe(share);
    // Ambiguous recovery of the same batch in the same order repeats every projection.
    const restoring = observationWholeDeliveryBatches();
    for (const id of order) {
      const index = calls.findIndex(call => call.id === id);
      expect(await restoreObservedResult({ service: observations.service(), producer: { ...actor, toolCallId: id },
        wholeDelivery: restoring.allowance(3, share) }, calls[index]!)).toEqual(results[index]);
    }
    // Settled siblings replayed into the batch keep their whole deliveries
    // counted; previews count nothing. A restored sibling then stays bounded.
    const replayed = observationWholeDeliveryBatches();
    for (const result of results) replayed.replay(3, share, result);
    expect(replayed.allowance(3, share).remainingTokens).toBe(share - whole.reduce((sum, result) => sum + projectedTokens(result), 0));
    const wholeIndex = results.indexOf(whole[0]!);
    const restored = await restoreObservedResult({ service: observations.service(), producer: { ...actor, toolCallId: calls[wholeIndex]!.id },
      wholeDelivery: replayed.allowance(3, share) }, calls[wholeIndex]!);
    expect(isWhole(restored)).toBe(false);
  });

  it("keeps a restore's storage or database failure transient and every proof of loss a refusal", async () => {
    const storage = createMemoryStorageAdapter();
    const f = fixture(storage);
    const call = { id: "restore-call", name: "synthetic_tool", arguments: {} };
    const context = () => ({ service: f.service(), producer, wholeDelivery: wholeDeliveryAllowance(32_000) });
    const live = await captureMcpObservation(context(), call, binding, async () => mcpOriginal(100 * 1024, "restore"));
    const failure = async () => restoreObservedResult(context(), call).then(() => null, (error: unknown) => error);
    // An S3 timeout opening the object.
    const timeout = Object.assign(new Error("synthetic S3 timeout"), { name: "TimeoutError", $metadata: { httpStatusCode: 503 } });
    vi.spyOn(storage, "getObjectStream").mockRejectedValueOnce(timeout);
    expect(await failure()).toBe(timeout);
    expect(observationRestoreRefused(timeout)).toBe(false);
    // A transport failure mid-stream keeps its private detail hidden but stays transient.
    vi.spyOn(storage, "getObjectStream").mockResolvedValueOnce({ byteSize: live.observation!.byteSize, contentType: "application/json",
      storageKey: f.row().storageKey!, body: new ReadableStream({ pull(controller) { controller.error(new Error("private-socket-detail")); } }) });
    const reset = await failure();
    expect(reset).toBeInstanceOf(ObservationReadError);
    expect(String(reset)).not.toContain("private-socket-detail");
    expect(observationRestoreRefused(reset)).toBe(false);
    // A database failure reading the producer.
    const database = new Error("could not serialize access");
    f.repository.readProducer.mockRejectedValueOnce(database);
    expect(observationRestoreRefused(await failure())).toBe(false);
    // Revoked authority and a row that never became READY are refusals.
    f.repository.readProducer.mockRejectedValueOnce(new McpToolAccessDeniedError());
    expect(observationRestoreRefused(await failure())).toBe(true);
    f.repository.readProducer.mockResolvedValueOnce({ ...f.row(), state: "UNAVAILABLE" });
    expect(observationRestoreRefused(await failure())).toBe(true);
    // Corrupt bytes, then a missing object, prove the original lost.
    const key = f.row().storageKey!;
    const stored = storage.objects.get(key)!;
    storage.objects.set(key, { ...stored, body: Buffer.from(Buffer.from(stored.body).toString("utf8").replace("0", "1")) });
    expect(observationRestoreRefused(await failure())).toBe(true);
    storage.objects.clear();
    expect(observationRestoreRefused(await failure())).toBe(true);
  });

  it("restores a Search above the bound with every retained numbered source after the receipt dropped them", async () => {
    const f = fixture();
    const call = { id: "search-call", name: "search_selected_engines", arguments: {} };
    const executions: SearchExecutionEvidence[] = [1, 2, 3].map(engine => ({ displayName: `Engine ${engine}`,
      invocationId: `invocation-${engine}`, modelId: "model", optionId: `option-${engine}`, provider: "provider",
      revisionId: `revision-${engine}`, status: "complete", findings: `${unique(110 * 1024, `findings-${engine}`)} rare-${engine}`,
      sources: Array.from({ length: 20 }, (_, rank) => ({ rank: rank + 1,
        title: `Title ${engine}-${rank} ${"t".repeat(300)}`.slice(0, 300),
        url: `https://example.com/${engine}/${rank}?q=${"u".repeat(1200)}`.slice(0, 1200),
        snippet: `Snippet ${engine}-${rank} ${"s".repeat(300)}`.slice(0, 300) })),
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }));
    const search: ToolExecutionResult = { name: call.name, callId: call.id, status: "complete", content: searchToolResultContent(executions),
      rawPreview: { providerCall: true, searchResultVersion: 2, searchExecutions: executions } };
    const receipt = searchObservationReceipt(search);
    // The receipt stayed bounded by dropping snippets and trailing sources.
    expect(receipt.executions.some(execution => execution.sources.length < 20)).toBe(true);
    expect(receipt.executions.flatMap(execution => execution.sources).some(source => source.snippet)).toBe(false);
    const canonical = searchToolResultText(executions);
    const tail = canonical.slice(canonical.lastIndexOf("\n\nSources:\n") + 2);
    expect(tail).toContain("\n24. Title");
    await captureSearchObservation({ service: f.service(), producer }, call,
      [1, 2, 3].map(engine => ({ optionId: `option-${engine}`, revisionId: `revision-${engine}` })), async () => search);
    expect(f.row().byteSize).toBeGreaterThan(256 * 1024);
    const restored = await restoreObservedResult({ service: f.service(), producer }, call);
    const text = restored.content[0]?.type === "text" ? restored.content[0].text : "";
    expect(text.startsWith('Search source "Engine 1":\n')).toBe(true);
    expect(text).toContain("Search result shortened here");
    expect(text.endsWith(`\n\n${tail}`)).toBe(true);
    expect(text).not.toContain("rare-3");
    expect(snapshotToolExecutionResult(restored, 256 * 1024)).not.toBeNull();
  });

  it("keeps a retained source list and warnings only when their numbering proves them whole", () => {
    const findings = `Search source "Engine":\n${"f".repeat(4096)}`;
    const list = "Sources:\n1. Title one\ncontinued — https://example.com/1\n2. Title two — https://example.com/2";
    const warnings = 'Search warnings: "Engine 2": search_timeout';
    const kept = boundedRetainedSearchToolResultText(`${findings}\n\n${list}\n\n${warnings}`, 1024);
    expect(kept).toContain("Search result shortened here");
    expect(kept?.endsWith(`\n\n${list}\n\n${warnings}`)).toBe(true);
    // A gap in the numbering is not the canonical list; only the warnings line stays.
    const gapped = boundedRetainedSearchToolResultText(`${findings}\n\nSources:\n1. A — https://a.test\n3. C — https://c.test\n\n${warnings}`, 1024);
    expect(gapped?.endsWith(`[Search result shortened here; the complete saved result remains readable.]\n\n${warnings}`)).toBe(true);
    expect(boundedRetainedSearchToolResultText(`${findings}\n\nforged trailer`, 1024)).toBeNull();
  });

  it("keeps an executed Search's usage and says it executed when its receipt cannot be recorded", async () => {
    const f = fixture();
    const call = { id: "search-call", name: "search_selected_engines", arguments: {} };
    const executions: SearchExecutionEvidence[] = [{ displayName: "Engine", invocationId: "invocation-1", modelId: "model",
      optionId: "option-1", provider: "provider", revisionId: "revision-1", status: "complete", findings: "Findings",
      sources: [{ rank: 1, title: "Title", url: "https://example.com/1" }], usage: { inputTokens: 9, outputTokens: 3, totalTokens: 12 } }];
    const search: ToolExecutionResult = { name: call.name, callId: call.id, status: "complete", content: searchToolResultContent(executions),
      rawPreview: { providerCall: true, searchResultVersion: 2, searchExecutions: executions } };
    f.repository.recordSearchReceipt.mockRejectedValueOnce(new Error("could not serialize access"));
    const unrecorded = vi.fn();
    const execute = vi.fn(async () => search);
    const error = await captureSearchObservation({ service: f.service(), producer, onUnrecordedSearch: unrecorded }, call,
      [{ optionId: "option-1", revisionId: "revision-1" }], execute).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(ObservationStoreError);
    expect(error).toMatchObject({ code: "tool_observation_unavailable", executed: true });
    expect(observationFailure(error)).toEqual({ code: "tool_observation_unavailable",
      message: "The operation executed, but its saved result is unavailable. Do not execute it again to recover the result." });
    expect(unrecorded).toHaveBeenCalledWith(search);
    expect(execute).toHaveBeenCalledOnce();
    expect(f.row()).toMatchObject({ state: "UNAVAILABLE", executionReceipt: null });
    expect(await f.service().searchAccounting(producer)).toEqual([]);
  });
});
