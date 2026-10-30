// @vitest-environment node

import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createMemoryStorageAdapter } from "@/tests/support/storage";
import { createWorkspaceAvailabilityService } from "./availability";
import { getWorkspaceConfig } from "./config";
import { createWorkspaceLifecycleService } from "./lifecycle";
import { createWorkspaceLifecycleHandlers } from "./lifecycleHandlers";
import type { WorkspacePolicyRepository } from "./policyRepository";
import type { WorkspaceRuntime } from "./runtime";

vi.mock("./executionRegistry", () => ({ acknowledgeWorkspaceCommandsStopped: vi.fn(async () => undefined) }));
vi.mock("./sessionOperation", async (importOriginal) => ({
  ...await importOriginal<typeof import("./sessionOperation")>(),
  failWorkspaceExportsForLostDisk: vi.fn(async () => undefined)
}));

const config = getWorkspaceConfig({
  AIQSA_TEST_MODE: "1",
  AIQSA_WORKSPACE_DETERMINISTIC_RUNTIME: "1",
  NODE_ENV: "test"
});

type Row = Record<string, unknown>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (key === "OR") return (condition as Row[]).some(branch => matches(row, branch));
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const filter = condition as { in?: unknown[]; not?: unknown };
      if (filter.in) return filter.in.includes(row[key]);
      if ("not" in filter) return row[key] !== filter.not;
    }
    return row[key] === condition;
  });
}

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    row[key] = value && typeof value === "object" && "increment" in value
      ? (row[key] as number) + (value as { increment: number }).increment
      : value;
  }
}

/** One personal chat, its optional Workspace session and its carried seeds, behind the calls the lifecycle makes. */
function fakeDatabase(input: Readonly<{
  activeRuns?: number;
  seeds?: Row[];
  session?: Row | null;
  subagentRuns?: number;
}>) {
  const chat = { archived: false, id: "chat-1", permanentDeletionAt: null, userId: "owner-1" as string | null };
  const session: Row | null = input.session ? {
    id: "session-1", chatId: chat.id, imageRef: "image", internetEnabled: true, operationOwner: null,
    operationExpiresAt: null, runtimeSandboxId: null, sandboxName: "aiqsa-ws-session-1", state: "FAILED", version: 3,
    ...input.session
  } : null;
  const seeds: Row[] = (input.seeds ?? []).map((seed, index) => ({
    id: `seed-${index}`, newChatId: chat.id, leaseToken: null, leaseExpiresAt: null, failureCode: null, ...seed
  }));
  const cleanupJobs: Row[] = [];
  const deletionJobs: string[] = [];
  const seedWrites: Row[] = [];
  const tx = {
    async $queryRaw(query: TemplateStringsArray | { sql: string }) {
      const text = Array.isArray(query) ? query.join("?") : (query as { sql: string }).sql;
      return text.includes("FROM \"Chat\"") ? [chat] : [];
    },
    // Active main-agent runs only; `subagentRuns` are background sub-agent runs.
    modelRun: { count: async ({ where }: { where?: Row } = {}) =>
      where?.subagentTurnId ? input.subagentRuns ?? 0 : (input.activeRuns ?? 0) + (input.subagentRuns ?? 0) },
    workspaceSession: {
      findUnique: async () => session && { ...session },
      findFirst: async ({ where }: { where: Row }) => session && matches(session, where) ? { id: session.id } : null,
      update: async ({ data }: { data: Row }) => {
        apply(session!, data);
        return { ...session! };
      },
      updateMany: async ({ data, where }: { data: Row; where: Row }) => {
        if (!session || !matches(session, where)) return { count: 0 };
        apply(session, data);
        return { count: 1 };
      }
    },
    chatContinuationWorkspaceSeed: {
      count: async ({ where }: { where: Row }) => seeds.filter(seed => matches(seed, where)).length,
      findMany: async ({ where }: { where: Row }) => seeds.filter(seed => matches(seed, where)).map(seed => ({ ...seed })),
      updateMany: async ({ data, where }: { data: Row; where: Row }) => {
        const selected = seeds.filter(seed => matches(seed, where));
        for (const seed of selected) apply(seed, data);
        seedWrites.push({ data, where });
        return { count: selected.length };
      }
    },
    workspaceCleanupJob: {
      upsert: async ({ create }: { create: Row }) => {
        const job = { id: "cleanup-1", ...create };
        cleanupJobs.splice(0, cleanupJobs.length, job);
        return job;
      },
      findUnique: async () => cleanupJobs[0] ?? null,
      delete: async () => cleanupJobs.splice(0, 1)[0],
      updateMany: async ({ data, where }: { data: Row; where: Row }) => {
        const selected = cleanupJobs.filter(job => matches(job, where));
        for (const job of selected) apply(job, data);
        return { count: selected.length };
      }
    },
    attachmentDeletionJob: {
      upsert: async ({ create }: { create: { storageKey: string } }) => {
        deletionJobs.push(create.storageKey);
        return create;
      }
    }
  };
  const prisma = {
    async $transaction<T>(work: (client: typeof tx) => Promise<T>): Promise<T> {
      return work(tx);
    },
    chat: {
      findUnique: async () => {
        const received = seeds[0];
        return {
          ...chat,
          defaultProviderModel: null,
          receivedWorkspaceSeeds: received ? [{ failureCode: received.failureCode, status: received.status }] : [],
          workspaceEnabled: true,
          workspaceSession: session && { internetEnabled: session.internetEnabled, state: session.state }
        };
      }
    }
  };
  return { chat, cleanupJobs, deletionJobs, prisma: prisma as unknown as PrismaClient, seedWrites, seeds, session };
}

function fakeRuntime(): WorkspaceRuntime {
  return {
    claimSessionOperation: vi.fn(async () => undefined),
    removeSession: vi.fn(async () => undefined),
    retireSessionOperation: vi.fn(async () => undefined)
  } as unknown as WorkspaceRuntime;
}

const policy: WorkspacePolicyRepository = {
  async read() {
    return { enabled: true, internetEnabled: true, version: 7 };
  },
  async update() {
    throw new Error("unused");
  }
};

function lifecycleFor(database: ReturnType<typeof fakeDatabase>, runtime = fakeRuntime()) {
  return {
    lifecycle: createWorkspaceLifecycleService({
      availability: createWorkspaceAvailabilityService({
        health: { invalidate() {}, read: async () => ({ state: "ready" as const }) },
        policy
      }),
      config,
      policy,
      prisma: database.prisma,
      runtime,
      storage: createMemoryStorageAdapter()
    }),
    runtime
  };
}

const owner = { chatId: "chat-1", userId: "owner-1" };
const carriedSeed = { scheduledTaskId: "task-1", status: "TRANSFERRED", storageKey: "owner-1/workspace-seeds/seed" };

describe("Workspace reset with a carried project that was never restored", () => {
  it("abandons the pending seed and removes any guest a failed start left, so the chat starts a fresh Workspace", async () => {
    const database = fakeDatabase({ seeds: [carriedSeed], session: { state: "FAILED", lastErrorCode: "workspace_carryover_unavailable" } });
    const { lifecycle, runtime } = lifecycleFor(database);

    await expect(lifecycle.reset(owner)).resolves.toMatchObject({
      continuationFiles: { reason: "reset_consumed", status: "failed" },
      sessionState: "not_started"
    });

    // The guest is addressed by session, without a runtime identity the failed start never recorded.
    expect(runtime.claimSessionOperation).toHaveBeenCalledWith(expect.objectContaining({ runtimeSandboxId: null, sessionId: "session-1" }));
    expect(runtime.removeSession).toHaveBeenCalledWith(expect.objectContaining({ runtimeSandboxId: null, sessionId: "session-1" }));
    expect(database.session).toMatchObject({
      operationOwner: null, policyRevision: 7, runtimeSandboxId: null, state: "PENDING", version: 5
    });
    expect(database.seeds[0]).toMatchObject({
      failureCode: "workspace_reset_consumed", leaseExpiresAt: null, leaseToken: null, status: "ABANDONED"
    });
    // Only this chat's seeds are consumed, and their archive is queued for deletion.
    expect(database.seedWrites).toEqual([expect.objectContaining({ where: expect.objectContaining({ newChatId: "chat-1" }) })]);
    expect(database.deletionJobs).toEqual(["owner-1/workspace-seeds/seed"]);
    expect(database.cleanupJobs).toEqual([]);
  });

  it("also abandons a seed after maintenance settled the failed start back to pending", async () => {
    const database = fakeDatabase({ seeds: [{ ...carriedSeed, status: "RESTORING" }], session: { state: "PENDING" } });
    const { lifecycle } = lifecycleFor(database);

    await expect(lifecycle.reset(owner)).resolves.toMatchObject({ continuationFiles: { status: "failed" } });
    expect(database.seeds[0]).toMatchObject({ status: "ABANDONED" });
    expect(database.session).toMatchObject({ state: "PENDING", runtimeSandboxId: null });
  });

  it("abandons the seed of a chat whose Workspace session was never created without touching the runtime", async () => {
    const database = fakeDatabase({ seeds: [carriedSeed], session: null });
    const { lifecycle, runtime } = lifecycleFor(database);

    await expect(lifecycle.reset(owner)).resolves.toMatchObject({
      continuationFiles: { reason: "reset_consumed", status: "failed" }
    });
    expect(database.seeds[0]).toMatchObject({ status: "ABANDONED" });
    expect(database.deletionJobs).toEqual(["owner-1/workspace-seeds/seed"]);
    expect(runtime.claimSessionOperation).not.toHaveBeenCalled();
    expect(runtime.removeSession).not.toHaveBeenCalled();
  });

  it("refuses a second reset once the seed is consumed, changing nothing", async () => {
    const database = fakeDatabase({ seeds: [carriedSeed], session: { state: "FAILED" } });
    const { lifecycle, runtime } = lifecycleFor(database);
    await lifecycle.reset(owner);
    const settled = { seeds: structuredClone(database.seeds), session: { ...database.session } };

    await expect(lifecycle.reset(owner)).rejects.toMatchObject({ code: "workspace_not_started" });
    expect(database.seeds).toEqual(settled.seeds);
    expect(database.session).toEqual(settled.session);
    expect(runtime.removeSession).toHaveBeenCalledTimes(1);
  });

  it("keeps refusing a reset of a Workspace that never started and carries nothing pending", async () => {
    for (const seeds of [[], [{ ...carriedSeed, status: "FAILED" }], [{ ...carriedSeed, status: "READY" }]]) {
      const database = fakeDatabase({ seeds, session: { state: "FAILED" } });
      const { lifecycle, runtime } = lifecycleFor(database);
      await expect(lifecycle.reset(owner)).rejects.toMatchObject({ code: "workspace_not_started" });
      expect(runtime.removeSession).not.toHaveBeenCalled();
      expect(database.session).toMatchObject({ state: "FAILED", version: 3 });
      expect(database.seedWrites).toEqual([]);
    }
  });

  it("does not let a Workspace download consume the pending seed", async () => {
    const database = fakeDatabase({ seeds: [carriedSeed], session: { state: "FAILED" } });
    const { lifecycle } = lifecycleFor(database);

    await expect(lifecycle.archive(owner)).rejects.toMatchObject({ code: "workspace_not_started" });
    expect(database.seeds[0]).toMatchObject({ status: "TRANSFERRED" });
    expect(database.seedWrites).toEqual([]);
  });

  it("refuses another user, an active run and a busy session without consuming the seed", async () => {
    const stranger = fakeDatabase({ seeds: [carriedSeed], session: null });
    await expect(lifecycleFor(stranger).lifecycle.reset({ chatId: "chat-1", userId: "someone-else" }))
      .rejects.toMatchObject({ code: "workspace_reset_conflict", status: 404 });

    const running = fakeDatabase({ activeRuns: 1, seeds: [carriedSeed], session: null });
    await expect(lifecycleFor(running).lifecycle.reset(owner)).rejects.toMatchObject({ code: "workspace_busy" });

    const busy = fakeDatabase({ seeds: [carriedSeed], session: { operationOwner: "run:other", state: "CREATING" } });
    const { lifecycle, runtime } = lifecycleFor(busy);
    await expect(lifecycle.reset(owner)).rejects.toMatchObject({ code: "workspace_reset_conflict" });
    expect(runtime.removeSession).not.toHaveBeenCalled();

    // Running sub-agents refuse a Reset with their own reason, so the user knows to stop them first.
    const subagents = fakeDatabase({ seeds: [carriedSeed], session: null, subagentRuns: 1 });
    await expect(lifecycleFor(subagents).lifecycle.reset(owner)).rejects.toMatchObject({ code: "workspace_subagents_running", status: 409 });

    for (const database of [stranger, running, busy, subagents]) {
      expect(database.seeds[0]).toMatchObject({ status: "TRANSFERRED" });
      expect(database.seedWrites).toEqual([]);
      expect(database.deletionJobs).toEqual([]);
    }
  });
});

describe("Workspace of a chat left from a removed Project", () => {
  it("is neither reset nor archived by a former member, who is answered as for a chat they cannot see", async () => {
    const database = fakeDatabase({ seeds: [carriedSeed], session: { state: "STOPPED" } });
    database.chat.userId = null;
    const { lifecycle, runtime } = lifecycleFor(database);
    const member = { chatId: "chat-1", userId: "member-1" };

    await expect(lifecycle.reset(member)).rejects.toMatchObject({ code: "workspace_reset_conflict", status: 404 });
    await expect(lifecycle.archive(member)).rejects.toMatchObject({ code: "workspace_not_started", status: 404 });
    expect(runtime.claimSessionOperation).not.toHaveBeenCalled();
    expect(runtime.removeSession).not.toHaveBeenCalled();
    expect(database.seedWrites).toEqual([]);
    expect(database.session).toMatchObject({ state: "STOPPED", version: 3 });

    const handlers = createWorkspaceLifecycleHandlers({
      resolveAuth: async () => ({ user: { status: "active" }, userId: "member-1" }) as never,
      service: lifecycle
    });
    const response = await handlers.reset(new Request("http://app.local/api/chats/chat-1/workspace/reset", { method: "POST" }),
      { params: { chatId: "chat-1" } });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "workspace_reset_conflict" });
  });
});
