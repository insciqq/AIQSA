import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaSubagentBackgroundStore } from "./store";

const scope = { chatId: "chat-1", userId: "user-1" };

/** A chat with no owed turn whose one unread message sits under `answer`, its active branch holding `path`. */
function chat(input: Readonly<{ answer: string; path: readonly string[] }>) {
  const $transaction = vi.fn(async () => null);
  const client = {
    $queryRaw: vi.fn(async () => input.path.map((id) => ({ id }))),
    $transaction,
    chat: { findFirst: vi.fn(async () => ({ activeLeafMessageId: "leaf" })) },
    runFollowup: { findFirst: vi.fn(async ({ where }: { where: { modelRun: { assistantMessageId?: { in: string[] } } } }) => {
      const answers = where.modelRun.assistantMessageId?.in;
      return !answers || answers.includes(input.answer) ? { id: "message-1" } : null;
    }) },
    subagentTurn: { findFirst: vi.fn(async () => null) }
  };
  return { $transaction, client, store: createPrismaSubagentBackgroundStore(client as unknown as PrismaClient) };
}

describe("what a chat owes the main agent", () => {
  it("takes no lock for a message left on a branch the user left: every flush would meet it again, forever", async () => {
    const { $transaction, store } = chat({ answer: "answer-old", path: ["leaf", "answer-new"] });
    expect(await store.owedCallbacks(scope)).toEqual({ activeBranch: [], inactiveTurnIds: [], mainRun: null });
    expect($transaction).not.toHaveBeenCalled();
  });

  it("reads a message of the active branch, which the next answer takes", async () => {
    const { $transaction, store } = chat({ answer: "answer-new", path: ["leaf", "answer-new"] });
    await store.owedCallbacks(scope);
    expect($transaction).toHaveBeenCalledOnce();
  });

  it("walks no branch while nothing sits unread", async () => {
    const { $transaction, client, store } = chat({ answer: "answer-new", path: [] });
    client.runFollowup.findFirst.mockResolvedValue(null);
    await store.owedCallbacks(scope);
    expect(client.$queryRaw).not.toHaveBeenCalled();
    expect($transaction).not.toHaveBeenCalled();
  });
});
