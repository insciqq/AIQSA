import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";

const workspace = vi.hoisted(() => ({ fail: 0, removed: [] as string[] }));

vi.mock("../workspace/removal", () => ({
  async removeWorkspaceForDeletion(input: { prisma: { __state: FakeState }; sessionId: string; signal?: AbortSignal }) {
    input.signal?.throwIfAborted();
    if (workspace.fail > 0) {
      workspace.fail -= 1;
      throw new Error("synthetic_vm_stop_failed");
    }
    workspace.removed.push(input.sessionId);
    for (const session of input.prisma.__state.sessions.values()) {
      if (session.id === input.sessionId) session.runtimeSandboxId = null;
    }
  }
}));

import { BackgroundWorkError } from "../background/errors";
import { deleteChatAggregate } from "./aggregateDeletion";
import { purgePermanentlyDeletedChat } from "./permanentDeletion/cleanup";
import { deleteExpiredTemporaryChat } from "./temporaryDeletion";

type FakeChat = {
  archived: boolean;
  id: string;
  memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
  permanentDeletionAt: Date | null;
  temporaryRetentionDeadline: Date | null;
  temporaryRetentionPolicyVersion: string | null;
  userId: string;
};
type FakeState = {
  attachments: Array<{ chatId: string; id: string; storageKey: string; userId: string }>;
  deletionJobs: string[];
  objectLocks: string[];
  chats: Map<string, FakeChat>;
  messages: Array<{ chatId: string; id: string; status: string }>;
  runs: Array<{ assistantMessageId: string | null; chatId: string; id: string; status: string; userId: string }>;
  sessions: Map<string, { chatId: string; id: string; runtimeSandboxId: string | null }>;
  shares: Array<{ chatId: string }>;
};

const NOW = new Date("2026-11-22T12:00:00.000Z");
const ACTIVE = ["preparing", "queued", "streaming", "in_progress"];

function clone(state: FakeState): FakeState {
  return {
    attachments: state.attachments.map((row) => ({ ...row })),
    deletionJobs: [...state.deletionJobs],
    objectLocks: [...state.objectLocks],
    chats: new Map([...state.chats].map(([id, chat]) => [id, { ...chat }])),
    messages: state.messages.map((row) => ({ ...row })),
    runs: state.runs.map((row) => ({ ...row })),
    sessions: new Map([...state.sessions].map(([id, row]) => [id, { ...row }])),
    shares: state.shares.map((row) => ({ ...row }))
  };
}

function statusIn(where: { status?: { in?: string[] } }, status: string): boolean {
  return !where.status?.in || where.status.in.includes(status);
}

/** A small in-memory stand-in for the Prisma calls the two deletion stages make; transactions roll back on throw. */
function fakeClient(initial: FakeState) {
  const box = { state: initial };
  const sqlText = (query: { strings: readonly string[] }) => query.strings.join("?");
  const client = {
    get __state() { return box.state; },
    async $transaction(work: (tx: unknown) => Promise<unknown>) {
      const before = clone(box.state);
      try {
        return await work(client);
      } catch (error) {
        box.state = before;
        throw error;
      }
    },
    async $queryRaw(query: { strings: readonly string[]; values: unknown[] }) {
      const text = sqlText(query);
      if (text.includes("\"residual\"")) {
        const [userId, chatId] = query.values as string[];
        const residual = (box.state.chats.has(chatId!) ? 1 : 0) +
          box.state.messages.filter((row) => row.chatId === chatId).length +
          box.state.runs.filter((row) => row.chatId === chatId && row.userId === userId).length +
          box.state.attachments.filter((row) => row.chatId === chatId).length +
          box.state.shares.filter((row) => row.chatId === chatId).length;
        return [{ residual }];
      }
      if (text.includes("pg_advisory_xact_lock")) {
        box.state.objectLocks.push(String(query.values[0]));
        return [{ lock: "" }];
      }
      if (text.includes("FROM \"Chat\"")) {
        const [chatId, userId] = query.values as string[];
        const chat = box.state.chats.get(chatId!);
        return chat && chat.userId === userId ? [{ ...chat }] : [];
      }
      throw new Error(`unexpected query: ${text}`);
    },
    async $executeRaw(query: { strings: readonly string[]; values: unknown[] }) {
      const text = sqlText(query);
      if (text.includes("UPDATE \"ModelRun\"")) {
        for (const run of box.state.runs) {
          if (query.values.includes(run.id) && ACTIVE.includes(run.status)) run.status = "error";
        }
      }
      return 0;
    },
    attachment: {
      async count({ where }: { where: { id: { notIn: string[] }; storageKey: string } }) {
        return box.state.attachments.filter((row) => !where.id.notIn.includes(row.id) &&
          row.storageKey === where.storageKey).length;
      },
      async deleteMany({ where }: { where: { chatId: string } }) {
        box.state.attachments = box.state.attachments.filter((row) => row.chatId !== where.chatId);
        return { count: 1 };
      },
      async findMany({ where }: { where: { chatId: string } }) {
        return box.state.attachments.filter((row) => row.chatId === where.chatId)
          .sort((left, right) => left.id.localeCompare(right.id))
          .map((row) => ({ ...row, chatPdfArtifacts: [] }));
      }
    },
    attachmentDeletionJob: {
      async create({ data }: { data: { storageKey: string } }) { box.state.deletionJobs.push(data.storageKey); },
      async deleteMany() { return { count: 0 }; },
      async findUnique({ where }: { where: { storageKey: string } }) {
        return box.state.deletionJobs.includes(where.storageKey) ? { id: where.storageKey } : null;
      }
    },
    chat: {
      async deleteMany({ where }: { where: { id: string; memoryMode?: string; permanentDeletionAt?: unknown } }) {
        const chat = box.state.chats.get(where.id);
        if (!chat || (where.memoryMode && chat.memoryMode !== where.memoryMode) ||
          (where.permanentDeletionAt && chat.permanentDeletionAt === null)) return { count: 0 };
        box.state.chats.delete(where.id);
        box.state.messages = box.state.messages.filter((row) => row.chatId !== where.id);
        return { count: 1 };
      }
    },
    chatPdfArtifact: { async count() { return 0; } },
    message: {
      async updateMany({ data, where }: { data: { status: string }; where: { id: { in: string[] } } }) {
        for (const row of box.state.messages) if (where.id.in.includes(row.id)) row.status = data.status;
        return { count: 1 };
      }
    },
    modelRun: {
      async count({ where }: { where: { chatId: string; status?: { in: string[] } } }) {
        return box.state.runs.filter((row) => row.chatId === where.chatId && statusIn(where, row.status)).length;
      },
      async deleteMany({ where }: { where: { id: { in: string[] } } }) {
        box.state.runs = box.state.runs.filter((row) => !where.id.in.includes(row.id));
        return { count: 1 };
      },
      async findMany({ where }: { where: { chatId: string; status?: { in: string[] } } }) {
        return box.state.runs.filter((row) => row.chatId === where.chatId && statusIn(where, row.status));
      }
    },
    modelRunToolCall: { async updateMany() { return { count: 0 }; } },
    sharedChatSnapshot: {
      async deleteMany({ where }: { where: { chatId: string } }) {
        box.state.shares = box.state.shares.filter((row) => row.chatId !== where.chatId);
        return { count: 1 };
      }
    },
    workspaceCleanupJob: { async deleteMany() { return { count: 0 }; } },
    workspaceSession: {
      async delete({ where }: { where: { id: string } }) {
        for (const [chatId, row] of box.state.sessions) if (row.id === where.id) box.state.sessions.delete(chatId);
      },
      async findUnique({ where }: { where: { chatId: string } }) {
        const row = box.state.sessions.get(where.chatId);
        return row ? { ...row } : null;
      }
    }
  };
  return client;
}

function state(chat: Partial<FakeChat> & Pick<FakeChat, "id">): FakeState {
  return {
    attachments: [
      { chatId: chat.id, id: `${chat.id}-a1`, storageKey: `uploads/${chat.id}-1`, userId: "owner" },
      { chatId: chat.id, id: `${chat.id}-a2`, storageKey: "uploads/shared", userId: "owner" },
      { chatId: "other-chat", id: "other-a", storageKey: "uploads/shared", userId: "owner" }
    ],
    deletionJobs: [],
    objectLocks: [],
    chats: new Map([[chat.id, {
      archived: false, memoryMode: "NORMAL", permanentDeletionAt: null, temporaryRetentionDeadline: null,
      temporaryRetentionPolicyVersion: null, userId: "owner", ...chat
    }]]),
    messages: [{ chatId: chat.id, id: `${chat.id}-m1`, status: "complete" }],
    runs: [{ assistantMessageId: `${chat.id}-m1`, chatId: chat.id, id: `${chat.id}-r1`, status: "complete", userId: "owner" }],
    sessions: new Map([[chat.id, { chatId: chat.id, id: `${chat.id}-ws`, runtimeSandboxId: "vm-1" }]]),
    shares: [{ chatId: chat.id }]
  };
}

function storage(failures = 0) {
  const deleted: string[] = [];
  let remaining = failures;
  return {
    deleted,
    adapter: {
      async deleteObject(key: string) {
        if (remaining > 0) {
          remaining -= 1;
          throw new Error("synthetic_storage_unavailable");
        }
        deleted.push(key);
      }
    }
  };
}

function context(completions: string[]) {
  return {
    complete: async () => { completions.push("complete"); return true; },
    now: NOW,
    signal: new AbortController().signal
  };
}

beforeEach(() => {
  workspace.fail = 0;
  workspace.removed.length = 0;
});

describe("Temporary chat expiry", () => {
  const temporary = {
    id: "temp-1", memoryMode: "TEMPORARY" as const,
    temporaryRetentionDeadline: new Date(NOW.getTime() - 1_000), temporaryRetentionPolicyVersion: "temporary-24h-v1"
  };

  it("deletes a chat past its deadline with its Workspace and the files only it references", async () => {
    const client = fakeClient(state(temporary));
    const files = storage();
    const completions: string[] = [];
    await expect(deleteExpiredTemporaryChat(
      { client: client as unknown as PrismaClient, storage: files.adapter },
      { chatId: "temp-1", userId: "owner" }, context(completions)
    )).resolves.toBe("deleted");
    expect(files.deleted).toEqual(["uploads/temp-1-1"]);
    expect(workspace.removed).toEqual(["temp-1-ws"]);
    expect(client.__state.chats.has("temp-1")).toBe(false);
    expect(client.__state.attachments.map((row) => row.id)).toEqual(["other-a"]);
    expect(client.__state.runs).toEqual([]);
    expect(client.__state.sessions.size).toBe(0);
    expect(completions).toEqual(["complete"]);
  });

  it("leaves a chat whose deadline has not come", async () => {
    const client = fakeClient(state({ ...temporary, temporaryRetentionDeadline: new Date(NOW.getTime() + 60_000) }));
    const files = storage();
    await expect(deleteExpiredTemporaryChat(
      { client: client as unknown as PrismaClient, storage: files.adapter },
      { chatId: "temp-1", userId: "owner" }, context([])
    )).resolves.toBe("not_due");
    expect(files.deleted).toEqual([]);
    expect(client.__state.chats.has("temp-1")).toBe(true);
  });

  it("settles a run still active past the deadline before deleting", async () => {
    const initial = state(temporary);
    initial.runs[0]!.status = "streaming";
    initial.messages[0]!.status = "streaming";
    const client = fakeClient(initial);
    await expect(deleteExpiredTemporaryChat(
      { client: client as unknown as PrismaClient, storage: storage().adapter },
      { chatId: "temp-1", userId: "owner" }, context([])
    )).resolves.toBe("deleted");
    expect(client.__state.chats.has("temp-1")).toBe(false);
  });

  it("completes at once when the chat is already gone", async () => {
    const client = fakeClient({ ...state(temporary), chats: new Map() });
    const completions: string[] = [];
    await expect(deleteExpiredTemporaryChat(
      { client: client as unknown as PrismaClient, storage: storage().adapter },
      { chatId: "temp-1", userId: "owner" }, context(completions)
    )).resolves.toBe("gone");
    expect(completions).toEqual(["complete"]);
  });
});

describe("permanent chat purge", () => {
  const fenced = { archived: true, id: "chat-1", permanentDeletionAt: new Date(NOW.getTime() - 5_000) };

  it("resumes and completes after a storage failure in the middle", async () => {
    const client = fakeClient(state(fenced));
    const files = storage(1);
    const dependencies = { client: client as unknown as PrismaClient, storage: files.adapter };
    await expect(purgePermanentlyDeletedChat(dependencies, { chatId: "chat-1", userId: "owner" }, context([])))
      .rejects.toEqual(new BackgroundWorkError("chat_deletion_object_delete_failed"));
    // The Workspace went first; the rows are untouched and the fence still holds.
    expect(workspace.removed).toEqual(["chat-1-ws"]);
    expect(client.__state.chats.get("chat-1")?.permanentDeletionAt).not.toBeNull();
    expect(client.__state.attachments).toHaveLength(3);

    const completions: string[] = [];
    await expect(purgePermanentlyDeletedChat(dependencies, { chatId: "chat-1", userId: "owner" }, context(completions)))
      .resolves.toBe("deleted");
    expect(files.deleted).toEqual(["uploads/chat-1-1"]);
    expect(client.__state.chats.size).toBe(0);
    expect(client.__state.shares).toEqual([]);
    expect(client.__state.attachments.map((row) => row.id)).toEqual(["other-a"]);
    expect(completions).toEqual(["complete"]);
  });

  it("retries a Workspace that could not be stopped and never deletes rows meanwhile", async () => {
    workspace.fail = 1;
    const client = fakeClient(state(fenced));
    const dependencies = { client: client as unknown as PrismaClient, storage: storage().adapter };
    await expect(purgePermanentlyDeletedChat(dependencies, { chatId: "chat-1", userId: "owner" }, context([])))
      .rejects.toEqual(new BackgroundWorkError("chat_deletion_workspace_cleanup_failed"));
    expect(client.__state.chats.has("chat-1")).toBe(true);
    await expect(purgePermanentlyDeletedChat(dependencies, { chatId: "chat-1", userId: "owner" }, context([])))
      .resolves.toBe("deleted");
  });

  it("waits while a run of the chat is still active", async () => {
    const initial = state(fenced);
    initial.runs[0]!.status = "in_progress";
    const client = fakeClient(initial);
    await expect(purgePermanentlyDeletedChat(
      { client: client as unknown as PrismaClient, storage: storage().adapter },
      { chatId: "chat-1", userId: "owner" }, context([])
    )).rejects.toEqual(new BackgroundWorkError("chat_deletion_run_still_active"));
    expect(client.__state.chats.has("chat-1")).toBe(true);
  });

  it("refuses a chat that is not fenced", async () => {
    const client = fakeClient(state({ id: "chat-1" }));
    await expect(purgePermanentlyDeletedChat(
      { client: client as unknown as PrismaClient, storage: storage().adapter },
      { chatId: "chat-1", userId: "owner" }, context([])
    )).rejects.toEqual(new BackgroundWorkError("chat_deletion_fence_invalid"));
  });

  it("rolls the final transaction back when the claim was lost", async () => {
    const client = fakeClient(state(fenced));
    await expect(purgePermanentlyDeletedChat(
      { client: client as unknown as PrismaClient, storage: storage().adapter },
      { chatId: "chat-1", userId: "owner" },
      { complete: async () => false, now: NOW, signal: new AbortController().signal }
    )).rejects.toEqual(new BackgroundWorkError("chat_deletion_lease_lost"));
    expect(client.__state.chats.has("chat-1")).toBe(true);
    expect(client.__state.attachments).toHaveLength(3);
  });
});

describe("objects shared between deleted chats", () => {
  const fenced = { archived: true, id: "chat-1", permanentDeletionAt: new Date(NOW.getTime() - 5_000) };

  it("stages the object's deletion when the other chat's reference went while this one waited for the object lock", async () => {
    const initial = state(fenced);
    // The other chat sharing the object was deleted (and committed) after this purge found the object shared.
    initial.attachments = initial.attachments.filter((row) => row.id !== "other-a");
    initial.sessions.clear();
    const client = fakeClient(initial);
    const attachments = [
      { id: "chat-1-a1", storageKey: "uploads/chat-1-1" },
      { id: "chat-1-a2", storageKey: "uploads/shared" }
    ];
    await client.$transaction((tx) => deleteChatAggregate(tx as never, {
      attachments,
      chatExists: true,
      chatWhere: { permanentDeletionAt: { not: null } },
      dispositions: [{ deleted: true, storageKey: "uploads/chat-1-1" }, { deleted: false, storageKey: "uploads/shared" }],
      scope: { chatId: "chat-1", userId: "owner" }
    }));
    // The reference check ran under the object's lock, and the bytes are left to the object worker.
    expect(client.__state.objectLocks).toEqual(["uploads/shared"]);
    expect(client.__state.deletionJobs).toEqual(["uploads/shared"]);
    expect(client.__state.chats.size).toBe(0);
  });

  it("leaves an object another chat still references without staging its deletion", async () => {
    const client = fakeClient(state(fenced));
    await expect(purgePermanentlyDeletedChat(
      { client: client as unknown as PrismaClient, storage: storage().adapter },
      { chatId: "chat-1", userId: "owner" }, context([])
    )).resolves.toBe("deleted");
    expect(client.__state.objectLocks).toEqual(["uploads/shared"]);
    expect(client.__state.deletionJobs).toEqual([]);
    expect(client.__state.attachments.map((row) => row.storageKey)).toEqual(["uploads/shared"]);
  });

  it("starts no object delete or final transaction once the claim is lost", async () => {
    const client = fakeClient(state(fenced));
    const files = storage();
    const controller = new AbortController();
    controller.abort(new BackgroundWorkError("background_work_lease_lost"));
    await expect(purgePermanentlyDeletedChat(
      { client: client as unknown as PrismaClient, storage: files.adapter },
      { chatId: "chat-1", userId: "owner" },
      { complete: async () => true, now: NOW, signal: controller.signal }
    )).rejects.toEqual(new BackgroundWorkError("background_work_lease_lost"));
    expect(files.deleted).toEqual([]);
    expect(workspace.removed).toEqual([]);
    expect(client.__state.chats.has("chat-1")).toBe(true);
  });
});
