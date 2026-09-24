// @vitest-environment node
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Prisma, ToolObservation } from "@prisma/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { estimateApproxTokens } from "../../domain/contextBudget";
import { createFileSystemStorageAdapter, type StorageAdapter } from "../uploads/storage";
import { TOOL_OBSERVATION_LIMITS } from "./contract";
import { ObservationStoreError } from "./repository";
import { createToolObservationService, type ToolObservationRepository } from "./service";
import { captureMcpObservation, captureWorkspaceObservation, captureSearchObservation, captureOwnedObservation, projectObservationForProvider } from "./sourceAdapters";
import { snapshotToolExecutionResult } from "../runs/toolExecutionPersistence";
import { searchToolResultContent, type SearchExecutionEvidence } from "../search/toolResult";
import { SearchToolCancelledError } from "../search/toolExecutor";
import type { ToolExecutionResult } from "../tools/types";

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
      if (row) return { claimed: false, observation: row };
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

  it.each(["😀", "Я", '"', "\\"])("bounds bytes and estimated tokens for %s-heavy fragments", async char => {
    const f = fixture();
    const projection = await f.write({ text: char.repeat(10000) });
    const read = await f.service().read(producer, { handle: projection.observation.handle });
    expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(TOOL_OBSERVATION_LIMITS.readerBytes);
    expect(estimateApproxTokens(read)).toBeLessThanOrEqual(TOOL_OBSERVATION_LIMITS.readerEstimatedTokens);
    expect(read.cursor).not.toBeNull();
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

  it("externalizes canonical Search once and retains exact sources and independent usage when its object is lost", async () => {
    const f = fixture();
    const execute = vi.fn(async () => searchResult(true));
    const result = await captureSearchObservation({ service: f.service(), producer }, call, sources, execute);
    expect(f.row().byteSize).toBeGreaterThan(256 * 1024);
    expect(JSON.stringify(result).length).toBeLessThan(8192);
    expect(snapshotToolExecutionResult(result, 256 * 1024)).not.toBeNull();
    expect((await f.service().read(producer, { handle: result.observation!.handle, query: "rare-search-3" })).fragment).toContain("rare-search-3");
    const accounting = await f.service().searchAccounting(producer);
    expect(accounting.map(execution => execution.usage.totalTokens)).toEqual([11, 22, 33]);
    expect(accounting[2]?.sources[0]?.snippet).toBe("Accepted snippet 3");
    expect(accounting.every(execution => execution.findings === undefined)).toBe(true);
    await f.storage.deleteObject(f.row().storageKey!);
    const retained = await f.service().searchAccounting(producer);
    expect(retained.map(execution => execution.usage.totalTokens)).toEqual([11, 22, 33]);
    expect(retained.every(execution => execution.sources.length === 0)).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
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
    expect(result.observation?.maskable).toBe(source !== "skill");
    const projected = projectObservationForProvider(result);
    expect(projected.content[0]).toEqual(original.content[0]);
    expect(JSON.parse((await f.service().read(producer, { handle: result.observation!.handle })).fragment)).toEqual(original);
  });
});
