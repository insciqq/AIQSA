import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createPermanentChatDeletionService } from "../chats/permanentDeletion/service";
import { deleteAllPersonalChats } from "../chats/deleteAll";
import {
  createPermanentChatDeletionPass,
  createTemporaryChatDeletionPass,
  PERMANENT_CHAT_DELETION_DUTY,
  type ChatDeletionDuty,
  type ChatDeletionHandler,
  type ChatDeletionWorkStore
} from "./chatDeletionPasses";
import { BackgroundWorkError } from "./errors";
import {
  backgroundWorkRetryDelayMs,
  BACKGROUND_WORK_LEASE_MS,
  BACKGROUND_WORK_RENEW_MS,
  type BackgroundWorkClaim
} from "./workItems";

type Row = {
  attemptCount: number;
  completedAt: Date | null;
  lastErrorCode: string | null;
  leaseExpiresAt: Date | null;
  leaseToken: string | null;
  nextAttemptAt: Date | null;
  userId: string;
};

type Chat = { due: (duty: ChatDeletionDuty) => boolean; userId: string };

/** The `BackgroundWorkItem` claim rules (`workItems.ts`) over plain maps, for the pass orchestration. */
function memoryStore(chats: Map<string, Chat>) {
  const rows = new Map<string, Row>();
  const renewFailures = { count: 0 };
  let tokens = 0;
  const key = (duty: string, itemId: string) => `${duty}:${itemId}`;
  const claimable = (row: Row | undefined, now: Date) => !row || (row.completedAt === null &&
    (row.leaseToken === null || row.leaseExpiresAt! <= now) &&
    (row.nextAttemptAt === null || row.nextAttemptAt <= now));
  const store: ChatDeletionWorkStore = {
    async claim({ duty, itemId, now, userId }) {
      const row = rows.get(key(duty, itemId));
      if (!claimable(row, now) || (row && row.userId !== userId)) return null;
      tokens += 1;
      const next: Row = {
        attemptCount: (row?.attemptCount ?? 0) + 1,
        completedAt: null,
        lastErrorCode: row?.lastErrorCode ?? null,
        leaseExpiresAt: new Date(now.getTime() + BACKGROUND_WORK_LEASE_MS),
        leaseToken: `token-${tokens}`,
        nextAttemptAt: null,
        userId
      };
      rows.set(key(duty, itemId), next);
      return { attempt: next.attemptCount, duty, itemId, leaseExpiresAt: next.leaseExpiresAt!, token: next.leaseToken!, userId };
    },
    async complete(_tx, claim, now) {
      const row = rows.get(key(claim.duty, claim.itemId));
      if (row?.leaseToken !== claim.token) return false;
      Object.assign(row, { completedAt: now, lastErrorCode: null, leaseExpiresAt: null, leaseToken: null, nextAttemptAt: null });
      return true;
    },
    async dueChats(duty, now, limit) {
      return [...chats].filter(([id, chat]) => chat.due(duty) && claimable(rows.get(key(duty, id)), now))
        .slice(0, limit).map(([chatId, chat]) => ({ chatId, userId: chat.userId }));
    },
    async fail(claim, { code, now }) {
      const row = rows.get(key(claim.duty, claim.itemId));
      if (row?.leaseToken !== claim.token) return;
      Object.assign(row, { lastErrorCode: code, leaseExpiresAt: null, leaseToken: null,
        nextAttemptAt: new Date(now.getTime() + backgroundWorkRetryDelayMs(claim.attempt)) });
    },
    async prune() {},
    async renew(claim, now) {
      const row = rows.get(key(claim.duty, claim.itemId));
      if (renewFailures.count > 0) {
        renewFailures.count -= 1;
        throw new Error("synthetic_database_unavailable");
      }
      if (row?.leaseToken !== claim.token || row.completedAt) return null;
      row.leaseExpiresAt = new Date(now.getTime() + BACKGROUND_WORK_LEASE_MS);
      return row.leaseExpiresAt;
    },
    async release(claim) {
      const row = rows.get(key(claim.duty, claim.itemId));
      if (row?.leaseToken !== claim.token) return;
      Object.assign(row, { attemptCount: Math.max(0, row.attemptCount - 1), leaseExpiresAt: null, leaseToken: null,
        nextAttemptAt: null });
    },
    async settleVanished(duty, now) {
      for (const [id, row] of rows) {
        const [rowDuty, itemId] = id.split(":") as [string, string];
        if (rowDuty !== duty || row.completedAt || chats.has(itemId)) continue;
        if (row.leaseToken && row.leaseExpiresAt! > now) continue;
        if (duty === PERMANENT_CHAT_DELETION_DUTY) Object.assign(row, { completedAt: now, leaseToken: null, leaseExpiresAt: null });
        else rows.delete(id);
      }
    }
  };
  return { renewFailures, row: (duty: string, itemId: string) => rows.get(key(duty, itemId)), store };
}

function clock(start: string) {
  let current = new Date(start).getTime();
  return { advance(ms: number) { current += ms; }, now: () => new Date(current) };
}

const dependencies = { client: {} as PrismaClient, storage: { async deleteObject() {} } };

/** A handler that removes the chat after a fake Workspace stop and file deletes; it may fail or hold. */
function fakeHandler(chats: Map<string, Chat>, options: {
  failOnce?: Set<string>;
  hold?: Promise<void>;
  log: string[];
}): ChatDeletionHandler {
  return async (_dependencies, scope, context) => {
    options.log.push(`start:${scope.chatId}`);
    if (options.hold) await options.hold;
    context.signal.throwIfAborted();
    if (options.failOnce?.delete(scope.chatId)) throw new BackgroundWorkError("chat_deletion_object_delete_failed");
    if (!chats.has(scope.chatId)) {
      await context.complete({} as never);
      return "gone";
    }
    options.log.push(`files:${scope.chatId}`, `workspace:${scope.chatId}`);
    chats.delete(scope.chatId);
    if (!(await context.complete({} as never))) throw new BackgroundWorkError("chat_deletion_lease_lost");
    return "deleted";
  };
}

function passContext(now: () => Date, signal = new AbortController().signal) {
  return { now, signal };
}

describe("chat deletion passes", () => {
  it("deletes Temporary chats past their deadline and leaves the others", async () => {
    const chats = new Map<string, Chat>([
      ["due", { due: (duty) => duty === "temporary_chat_deletion", userId: "owner" }],
      ["later", { due: () => false, userId: "owner" }]
    ]);
    const { row, store } = memoryStore(chats);
    const log: string[] = [];
    const pass = createTemporaryChatDeletionPass(dependencies, { handler: fakeHandler(chats, { log }), store });
    const time = clock("2026-11-22T12:00:00.000Z");
    await pass.run(passContext(time.now));
    expect([...chats.keys()]).toEqual(["later"]);
    expect(log).toEqual(["start:due", "files:due", "workspace:due"]);
    expect(row("temporary_chat_deletion", "due")?.completedAt).not.toBeNull();
  });

  it("retries a failed purge after its backoff and completes it", async () => {
    const chats = new Map<string, Chat>([["fenced", { due: (duty) => duty === PERMANENT_CHAT_DELETION_DUTY, userId: "owner" }]]);
    const { row, store } = memoryStore(chats);
    const log: string[] = [];
    const pass = createPermanentChatDeletionPass(dependencies, {
      handler: fakeHandler(chats, { failOnce: new Set(["fenced"]), log }), store
    });
    const time = clock("2026-11-22T12:00:00.000Z");
    await pass.run(passContext(time.now));
    expect(chats.has("fenced")).toBe(true);
    expect(row(PERMANENT_CHAT_DELETION_DUTY, "fenced")).toMatchObject({
      attemptCount: 1, lastErrorCode: "chat_deletion_object_delete_failed", leaseToken: null
    });
    // Within its backoff the item is not picked up again.
    time.advance(backgroundWorkRetryDelayMs(1) - 1);
    await pass.run(passContext(time.now));
    expect(log.filter((entry) => entry === "start:fenced")).toHaveLength(1);
    time.advance(1);
    await pass.run(passContext(time.now));
    expect(chats.has("fenced")).toBe(false);
    expect(row(PERMANENT_CHAT_DELETION_DUTY, "fenced")).toMatchObject({ attemptCount: 2, completedAt: time.now() });
  });

  it("never lets two workers process the same chat", async () => {
    const chats = new Map<string, Chat>([
      ["one", { due: () => true, userId: "owner" }],
      ["two", { due: () => true, userId: "owner" }]
    ]);
    const { store } = memoryStore(chats);
    const log: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const time = clock("2026-11-22T12:00:00.000Z");
    const first = createPermanentChatDeletionPass(dependencies, { batch: 1, handler: fakeHandler(chats, { hold, log }), store });
    const second = createPermanentChatDeletionPass(dependencies, { batch: 1, handler: fakeHandler(chats, { hold, log }), store });
    const running = [first.run(passContext(time.now)), second.run(passContext(time.now))];
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all(running);
    // Whatever both saw as due, a chat one worker holds is never started by the other.
    await Promise.all([first.run(passContext(time.now)), second.run(passContext(time.now))]);
    expect(log.filter((entry) => entry.startsWith("start:")).sort()).toEqual(["start:one", "start:two"]);
    expect(chats.size).toBe(0);
  });

  it("gives an item back at shutdown so the next worker takes it at once", async () => {
    const chats = new Map<string, Chat>([["fenced", { due: () => true, userId: "owner" }]]);
    const { row, store } = memoryStore(chats);
    const log: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const controller = new AbortController();
    const time = clock("2026-11-22T12:00:00.000Z");
    const pass = createPermanentChatDeletionPass(dependencies, { handler: fakeHandler(chats, { hold, log }), store });
    const running = pass.run(passContext(time.now, controller.signal));
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error("background_worker_stopping"));
    release();
    await expect(running).resolves.toEqual({ more: false });
    expect(row(PERMANENT_CHAT_DELETION_DUTY, "fenced")).toMatchObject({
      attemptCount: 0, leaseToken: null, nextAttemptAt: null, completedAt: null
    });
    const next = createPermanentChatDeletionPass(dependencies, { handler: fakeHandler(chats, { log }), store });
    await next.run(passContext(time.now));
    expect(chats.has("fenced")).toBe(false);
  });

  it("takes over an item whose worker died once its lease expires", async () => {
    const chats = new Map<string, Chat>([["fenced", { due: () => true, userId: "owner" }]]);
    const { store } = memoryStore(chats);
    const time = clock("2026-11-22T12:00:00.000Z");
    const crashed: BackgroundWorkClaim | null = await store.claim({
      duty: PERMANENT_CHAT_DELETION_DUTY, itemId: "fenced", now: time.now(), userId: "owner"
    });
    expect(crashed).not.toBeNull();
    const log: string[] = [];
    const pass = createPermanentChatDeletionPass(dependencies, { handler: fakeHandler(chats, { log }), store });
    await pass.run(passContext(time.now));
    expect(log).toEqual([]);
    time.advance(BACKGROUND_WORK_LEASE_MS);
    await pass.run(passContext(time.now));
    expect(chats.has("fenced")).toBe(false);
  });

  it("finishes \"delete all\": every fenced chat is purged and reads as complete", async () => {
    const chats = new Map<string, Chat & { fenced: boolean }>();
    for (const id of ["a", "b", "c"]) {
      const chat = { due: () => chat.fenced, fenced: false, userId: "owner" };
      chats.set(id, chat);
    }
    const { row, store } = memoryStore(chats);
    const service = createPermanentChatDeletionService({
      capability: { enabled: true },
      repository: {
        async admit({ chatId }) {
          const chat = chats.get(chatId);
          if (!chat || chat.fenced) return { kind: "not_found" };
          chat.fenced = true;
          return { deletionId: `deletion-${chatId}`, kind: "ok" };
        },
        async progress({ chatId, userId }) {
          if (chats.get(chatId)?.fenced) return "in_progress";
          return row(PERMANENT_CHAT_DELETION_DUTY, chatId)?.userId === userId &&
            row(PERMANENT_CHAT_DELETION_DUTY, chatId)?.completedAt ? "complete" : null;
        },
        async readSnapshot({ chatId }) {
          const chat = chats.get(chatId);
          return chat && !chat.fenced
            ? { activeLeafMessageId: null, activeRunCount: 0, memoryMode: "NORMAL" }
            : null;
        }
      }
    });
    const result = await deleteAllPersonalChats({
      archive: async () => ({ kind: "ok" }) as never,
      capability: { enabled: true },
      deletion: service,
      listPersonalChats: async () => [...chats.keys()].map((id) => ({
        archived: false, id, memoryMode: "NORMAL" as const
      }))
    }, "owner");
    expect(result).toMatchObject({ scheduled: 3, skipped: 0 });
    await expect(service.consumerStatus("owner", "a")).resolves.toEqual({ status: "IN_PROGRESS" });

    const time = clock("2026-11-22T12:00:00.000Z");
    const pass = createPermanentChatDeletionPass(dependencies, { handler: fakeHandler(chats, { log: [] }), store });
    await pass.run(passContext(time.now));
    expect(chats.size).toBe(0);
    await expect(service.consumerStatus("owner", "a")).resolves.toEqual({ status: "COMPLETE" });
    await expect(service.consumerStatus("intruder", "a")).rejects.toMatchObject({ code: "chat_not_found" });
  });

  describe("a slow purge", () => {
    function slowFixture() {
      const chats = new Map<string, Chat>([["one", { due: () => true, userId: "owner" }]]);
      const fixture = memoryStore(chats);
      const log: string[] = [];
      let release!: () => void;
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let signal: AbortSignal | null = null;
      const held = fakeHandler(chats, { hold, log });
      const handler: ChatDeletionHandler = async (dependencies, scope, context) => {
        signal = context.signal;
        return held(dependencies, scope, context);
      };
      const now = () => new Date();
      return { chats, ...fixture, handler, log, now, release, signal: () => signal as AbortSignal | null };
    }

    it("keeps its claim past the lease, so a second worker never starts the same chat", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-22T12:00:00.000Z"));
      try {
        const fixture = slowFixture();
        const first = createPermanentChatDeletionPass(dependencies, { handler: fixture.handler, store: fixture.store });
        const second = createPermanentChatDeletionPass(dependencies, {
          handler: fakeHandler(fixture.chats, { log: fixture.log }), store: fixture.store
        });
        const running = first.run(passContext(fixture.now));
        await vi.advanceTimersByTimeAsync(0);
        // Longer than one lease: the holder's renewals keep it.
        await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_LEASE_MS + 1);
        await second.run(passContext(fixture.now));
        expect(fixture.log.filter((entry) => entry === "start:one")).toHaveLength(1);
        expect(fixture.signal()?.aborted).toBe(false);
        fixture.release();
        await running;
        expect(fixture.chats.size).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops issuing operations once another worker holds its chat", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-22T12:00:00.000Z"));
      try {
        const fixture = slowFixture();
        const pass = createPermanentChatDeletionPass(dependencies, { handler: fixture.handler, store: fixture.store });
        const running = pass.run(passContext(fixture.now));
        await vi.advanceTimersByTimeAsync(0);
        // Another worker took the chat over (its lease had lapsed while this one was stalled).
        fixture.row(PERMANENT_CHAT_DELETION_DUTY, "one")!.leaseToken = "other-worker";
        await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_RENEW_MS);
        expect(fixture.signal()?.aborted).toBe(true);
        fixture.release();
        await running;
        // The handler stopped before its file and Workspace steps, and the new holder's claim is untouched.
        expect(fixture.log).toEqual(["start:one"]);
        expect(fixture.chats.has("one")).toBe(true);
        expect(fixture.row(PERMANENT_CHAT_DELETION_DUTY, "one")).toMatchObject({ leaseToken: "other-worker" });
      } finally {
        vi.useRealTimers();
      }
    });

    it("rides out one failed renewal but stops before its lease could lapse unrenewed", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-22T12:00:00.000Z"));
      try {
        const fixture = slowFixture();
        fixture.renewFailures.count = 2;
        const pass = createPermanentChatDeletionPass(dependencies, { handler: fixture.handler, store: fixture.store });
        const running = pass.run(passContext(fixture.now));
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_RENEW_MS);
        expect(fixture.signal()?.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(BACKGROUND_WORK_RENEW_MS);
        expect(fixture.signal()?.aborted).toBe(true);
        fixture.release();
        await running;
        expect(fixture.row(PERMANENT_CHAT_DELETION_DUTY, "one")).toMatchObject({
          lastErrorCode: "background_work_lease_lost", leaseToken: null
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
