import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createTranscriptRepository } from "./transcriptRepository";
import { unknownEffectsOf } from "./unknownEffects";

const at = (ms: number) => new Date(Date.UTC(2026, 9, 30, 10, 0, 0, ms));

describe("transcript hydration for the unknown-effect fence", () => {
  it("hydrate a resultless continuation's attempt: its in-flight marker is fenced from the continuation's durable attempt", async () => {
    // The earlier run's call (recorded at 0) and the approval continuation's in-flight marker (100) in its own run; the
    // continuation sent the call at 200 and ended at 300 with no result saved.
    const findAttempts = vi.fn(async () => [{ completedAt: at(300), modelRunId: "continuation-run", providerCallId: "call-1",
      startedAt: at(200) }]);
    const client = {
      modelRunToolCall: { findMany: findAttempts },
      runTranscriptItem: { findMany: vi.fn(async () => [
        { body: { arguments: '{"title":"x"}', name: "create" }, callId: "call-1", createdAt: at(0), id: "call", kind: "tool_call",
          modelRunId: "earlier-run" },
        { body: { inFlight: true, name: "create", outcome: "unknown", output: "Sent after the approval." }, callId: "call-1",
          createdAt: at(100), id: "marker", kind: "tool_result", modelRunId: "continuation-run" }
      ]) }
    } as unknown as PrismaClient;
    const loaded = await createTranscriptRepository(client).loadRuns({ chatId: "chat", runIds: ["earlier-run", "continuation-run"],
      userId: "user" });
    expect(findAttempts).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ providerCallId: { in: ["call-1"] },
      subagentThreadId: null }) }));
    const items = [...loaded.get("earlier-run")!, ...loaded.get("continuation-run")!];
    expect(items[1]).toMatchObject({ inFlight: true, recordedAt: at(300) });
    // An exact approval decided at 150 is older than the fence, so it cannot authorize another dispatch.
    expect(unknownEffectsOf(items, () => false).find({ arguments: { title: "x" }, name: "create" })?.after).toEqual(at(300));
  });
});

describe("the mailbox messages a transcript write holds", () => {
  const scope = { chatId: "chat", runId: "run", thread: { threadId: "thread", turnId: "turn" }, userId: "user" };
  const items = [{ id: "item", kind: "user" as const, text: "It costs 42" }];
  const read = { nonces: ["m-1"], runIds: ["run", "run"], threadId: "thread" };

  function fake() {
    const tx = { runFollowup: { updateMany: vi.fn(async () => ({ count: 1 })) }, runTranscriptItem: { createMany: vi.fn(async () => ({ count: 1 })) } };
    const client = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<void>) => work(tx)),
      runTranscriptItem: { ...tx.runTranscriptItem, count: vi.fn(async () => 1) } };
    return { client, repository: createTranscriptRepository(client as unknown as PrismaClient), tx };
  }

  it("are stamped in the transaction that records them, and a write without any takes no transaction", async () => {
    const { client, repository, tx } = fake();
    await repository.append(scope, 3, items, read);
    expect(client.$transaction).toHaveBeenCalledOnce();
    expect(tx.runTranscriptItem.createMany).toHaveBeenCalledOnce();
    expect(tx.runFollowup.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { deliveredAt: expect.any(Date) as Date },
      where: expect.objectContaining({ chatId: "chat", deliveredAt: null, modelRunId: { in: ["run"] }, nonce: { in: ["m-1"] },
        subagentTurn: { threadId: "thread", userId: "user" } }) as unknown }));
    await repository.append(scope, 4, items);
    expect(client.$transaction).toHaveBeenCalledOnce();
  });

  it("stay unread when the write fails", async () => {
    const { repository, tx } = fake();
    tx.runTranscriptItem.createMany.mockRejectedValueOnce(new Error("database_unavailable"));
    await expect(repository.append(scope, 3, items, read)).rejects.toThrow("database_unavailable");
    expect(tx.runFollowup.updateMany).not.toHaveBeenCalled();
  });

  it("need nothing more when a write that committed is repeated: its rows and its stamp went together", async () => {
    const { client, repository } = fake();
    client.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("taken", { clientVersion: "test", code: "P2002" }));
    await expect(repository.append(scope, 3, items, read)).resolves.toBeUndefined();
    client.$transaction.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError("taken", { clientVersion: "test", code: "P2002" }));
    client.runTranscriptItem.count.mockResolvedValueOnce(0);
    await expect(repository.append(scope, 3, items, read)).rejects.toThrow("taken");
  });
});
