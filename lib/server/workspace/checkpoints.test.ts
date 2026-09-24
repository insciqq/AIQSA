import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ProviderRunRequest } from "../providers/types";
import type { createWorkspaceSelectedCaptures } from "./selectedCapture";
import { createWorkspaceCheckpoints } from "./checkpoints";

const factory = vi.hoisted(() => vi.fn());
vi.mock("./checkpointStore", () => ({ createWorkspaceCheckpointStore: factory }));
const call = { id: "call", name: "checkpoint_outputs", arguments: { files: ["project/design.psd"], description: "Prepared design" } };
const context = { runId: "run", userId: "user", persistedToolCallId: "tool", request: { workspace: {}, workspaceCheckpoints: true, toolMode: "auto" } as ProviderRunRequest };
function fixture() {
  const result = { callId: call.id, name: call.name, status: "complete" as const, content: [{ type: "json" as const, value: { saved: true } }] };
  const row = { id: "checkpoint", state: "PENDING", result: null };
  const store = { reserve: vi.fn(async () => row), read: vi.fn(async () => row), bind: vi.fn(),
    publish: vi.fn(async () => result), decode: vi.fn(() => result), pending: vi.fn(async (): Promise<unknown[]> => []), unavailable: vi.fn(), defer: vi.fn() };
  factory.mockReturnValue(store);
  const retained = vi.fn(async () => ({ id: "a".repeat(32), files: [], readiness: "durable" }));
  const captures = { lookup: vi.fn(async () => ({ id: "a".repeat(32), files: [], readiness: "captured" })), create: vi.fn(async () => ({ id: "a".repeat(32), files: [], readiness: "captured" })),
    acquire: vi.fn(async () => ({ id: "a".repeat(32), files: [], readiness: "durable" })), retain: retained,
    settleRetained: vi.fn(async (_input, commit) => commit({}, [])) };
  const prisma = { workspaceSelectedCapture: { findUnique: vi.fn(async () => ({ id: "capture" })) } };
  const service = createWorkspaceCheckpoints(prisma as unknown as PrismaClient, captures as unknown as ReturnType<typeof createWorkspaceSelectedCaptures>, 1024);
  return { service, captures, store, prisma, result, row };
}
beforeEach(() => vi.clearAllMocks());
describe("Workspace checkpoint consumer", () => {
  it("publishes only after durable retention and preserves failure without false success", async () => {
    const f = fixture();
    f.captures.retain.mockRejectedValueOnce(new Error("storage_down"));
    await expect(f.service.execute(call, context)).rejects.toThrow("storage_down");
    expect(f.store.publish).not.toHaveBeenCalled();
    expect(await f.service.restore(call, context)).toEqual(f.result);
    expect(f.store.bind).toHaveBeenCalledWith(expect.anything(), "a".repeat(32), ["project/design.psd"]);
    expect(f.store.publish).toHaveBeenCalledOnce();
  });
  it("never invents a capture on crash recovery without an existing reservation", async () => {
    const f = fixture(); f.prisma.workspaceSelectedCapture.findUnique.mockResolvedValue(null as never);
    await expect(f.service.restore(call, context)).rejects.toThrow("workspace_checkpoint_unavailable");
    expect(f.captures.create).not.toHaveBeenCalled();
    expect(f.captures.retain).not.toHaveBeenCalled();
  });
  it("reuses an explicit capture and replays a settled checkpoint without capture/storage work", async () => {
    const f = fixture();
    await f.service.execute({ ...call, arguments: { ...call.arguments, capture_id: "a".repeat(32) } }, context);
    expect(f.captures.acquire).toHaveBeenCalledOnce();
    expect(f.captures.create).not.toHaveBeenCalled();
    f.row.state = "SETTLED";
    await f.service.restore(call, context);
    expect(f.captures.acquire).toHaveBeenCalledOnce();
    expect(f.captures.retain).toHaveBeenCalledOnce();
  });
  it("terminal recovery publishes only retained bytes without new guest or storage I/O", async () => {
    const f = fixture();
    const pending = { id: "checkpoint", modelRunId: "run", toolCallId: "tool", arguments: call.arguments,
      captureId: "a".repeat(32), toolCall: { providerCallId: "call" }, binding: { modelRun: { userId: "user" } }, capture: { files: [{ storageState: "READY" }] } };
    f.store.pending.mockResolvedValue([pending, { ...pending, id: "missing", capture: { files: [{ storageState: "NONE" }] } }]);
    expect(await f.service.recover()).toEqual({ completed: 1 });
    expect(f.captures.create).not.toHaveBeenCalled();
    expect(f.captures.acquire).not.toHaveBeenCalled();
    expect(f.captures.retain).not.toHaveBeenCalled();
    expect(f.captures.settleRetained).toHaveBeenCalledWith(expect.anything(), expect.any(Function), { allowEndedRun: true });
    expect(f.store.unavailable).toHaveBeenCalledOnce();
  });
  it("rejects Stop and unaccepted tools before reserving or capturing", async () => {
    const f = fixture(); const abort = new AbortController(); abort.abort();
    await expect(f.service.execute(call, context, abort.signal)).rejects.toThrow();
    await expect(f.service.execute(call, { ...context, request: { ...context.request, workspaceCheckpoints: undefined } })).rejects.toThrow();
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.captures.create).not.toHaveBeenCalled();
  });
});
