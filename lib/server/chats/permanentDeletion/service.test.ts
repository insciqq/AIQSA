import { describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../../contracts/memoryClient";
import {
  createPermanentChatDeletionService,
  PermanentChatDeletionError,
  type PermanentChatDeletionRepository,
  type PermanentChatDeletionSnapshot
} from "./service";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const request = {
  alsoForgetOriginMemories: false,
  confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
  requestId: "request-1"
} as const;

function snapshot(overrides: Partial<PermanentChatDeletionSnapshot> = {}): PermanentChatDeletionSnapshot {
  return { activeLeafMessageId: "leaf-1", activeRunCount: 0, memoryMode: "NORMAL", ...overrides };
}

function fixture(overrides: Partial<PermanentChatDeletionRepository> = {}) {
  const order: string[] = [];
  const repository: PermanentChatDeletionRepository = {
    admit: vi.fn(async () => { order.push("admit"); return { deletionId: "deletion-1", kind: "ok" as const }; }),
    progress: vi.fn(async () => "in_progress" as const),
    readSnapshot: vi.fn(async () => snapshot()),
    ...overrides
  };
  const stopSubagents = vi.fn(async () => { order.push("stopSubagents"); });
  const service = createPermanentChatDeletionService({
    capability: { enabled: true }, now: () => NOW, repository, stopSubagents
  });
  return { order, repository, service, stopSubagents };
}

describe("permanent chat deletion service", () => {
  it("fences the snapshot the owner confirmed and answers in progress", async () => {
    const { order, repository, service } = fixture();
    const condition = vi.fn(async () => true);
    await expect(service.confirm("user-1", "chat-1", request, { condition })).resolves.toEqual({ status: "IN_PROGRESS" });
    expect(repository.admit).toHaveBeenCalledWith({
      chatId: "chat-1", condition, expectedActiveLeafMessageId: "leaf-1", now: NOW, userId: "user-1"
    });
    // Background sub-agents stop once the fence holds; the worker purges after that.
    expect(order).toEqual(["admit", "stopSubagents"]);
  });

  it("refuses to also forget saved memories, which only a page from before the note asks, before reading or fencing", async () => {
    const { repository, service, stopSubagents } = fixture();
    await expect(service.confirm("user-1", "chat-1", { ...request, alsoForgetOriginMemories: true }))
      .rejects.toEqual(new PermanentChatDeletionError("chat_permanent_delete_reload_required"));
    expect(repository.readSnapshot).not.toHaveBeenCalled();
    expect(repository.admit).not.toHaveBeenCalled();
    expect(stopSubagents).not.toHaveBeenCalled();
  });

  it("refuses a missing, Temporary or busy chat before any change", async () => {
    for (const [value, code] of [
      [null, "chat_not_found"],
      [snapshot({ memoryMode: "TEMPORARY" }), "chat_permanent_delete_temporary_forbidden"],
      [snapshot({ activeRunCount: 1 }), "active_run_in_progress"]
    ] as const) {
      const { repository, service } = fixture({ readSnapshot: vi.fn(async () => value) });
      await expect(service.confirm("user-1", "chat-1", request)).rejects.toEqual(new PermanentChatDeletionError(code));
      expect(repository.admit).not.toHaveBeenCalled();
    }
  });

  it("maps a refused admission to its stable code and never stops sub-agents then", async () => {
    for (const [kind, code] of [
      ["not_found", "chat_not_found"],
      ["stale", "chat_permanent_delete_stale"],
      ["temporary", "chat_permanent_delete_temporary_forbidden"],
      ["active_run", "active_run_in_progress"]
    ] as const) {
      const { service, stopSubagents } = fixture({ admit: vi.fn(async () => ({ kind })) });
      await expect(service.confirm("user-1", "chat-1", request)).rejects.toEqual(new PermanentChatDeletionError(code));
      expect(stopSubagents).not.toHaveBeenCalled();
    }
    const { service } = fixture({ admit: vi.fn(async () => { throw new Error("synthetic_database_down"); }) });
    await expect(service.confirm("user-1", "chat-1", request))
      .rejects.toEqual(new PermanentChatDeletionError("chat_permanent_delete_failed"));
  });

  it("keeps the answer when stopping sub-agents fails", async () => {
    const { service } = fixture();
    const failing = createPermanentChatDeletionService({
      capability: { enabled: true },
      repository: fixture().repository,
      stopSubagents: async () => { throw new Error("synthetic_stop_failed"); }
    });
    await expect(failing.confirm("user-1", "chat-1", request)).resolves.toEqual({ status: "IN_PROGRESS" });
    await expect(service.confirm("user-1", "chat-1", request)).resolves.toEqual({ status: "IN_PROGRESS" });
  });

  it("reads progress for the owner only, a finished deletion as complete", async () => {
    const progress = vi.fn<PermanentChatDeletionRepository["progress"]>(async ({ userId }) =>
      userId === "user-1" ? "complete" : null);
    const { service } = fixture({ progress });
    await expect(service.consumerStatus("user-1", "chat-1")).resolves.toEqual({ status: "COMPLETE" });
    await expect(service.consumerStatus("user-2", "chat-1"))
      .rejects.toEqual(new PermanentChatDeletionError("chat_not_found"));
    progress.mockResolvedValueOnce("in_progress");
    await expect(service.consumerStatus("user-1", "chat-1")).resolves.toEqual({ status: "IN_PROGRESS" });
  });

  it("refuses everything while the capability is off", async () => {
    const repository = fixture().repository;
    const service = createPermanentChatDeletionService({ capability: { enabled: false }, repository });
    await expect(service.confirm("user-1", "chat-1", request))
      .rejects.toEqual(new PermanentChatDeletionError("chat_permanent_delete_unavailable"));
    expect(repository.readSnapshot).not.toHaveBeenCalled();
  });
});
