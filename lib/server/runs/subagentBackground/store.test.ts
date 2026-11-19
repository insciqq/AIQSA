import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { copyCallProviderBindings, createPrismaSubagentBackgroundStore } from "./store";

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

/** A running answer and a turn waiting on `ask-1`, which `moved` swaps for `ask-2` at the given step, as the runner would. */
function waitingTurn(moved: "before_read" | "never" | "after_read" = "never") {
  const order: string[] = [];
  let current = "ask-1";
  const turn = { callbackRunId: null as string | null, endedAt: null, id: "turn-1", reasonCode: "waiting_for_answer", state: "waiting" };
  const row = { answerCompletedAt: null, assistantMessageId: "answer", chatId: scope.chatId, followupClosedAt: null, followupMode: "chat", followupRevision: 0,
    id: "parent-answer", reserveTokens: null, scheduledTaskId: null, status: "streaming", subagentTurnId: null, userId: scope.userId };
  const asks = { "ask-1": "Which size?", "ask-2": "Which colour?" };
  const tx = {
    $queryRaw: vi.fn(async (query: readonly string[] | Readonly<{ text: string }>) => {
      const text = "text" in query ? query.text : query.join("?");
      if (/"SubagentTurn".*FOR UPDATE/su.test(text)) {
        order.push("lock turn");
        if (moved === "before_read") current = "ask-2";
      }
      return [row];
    }),
    chat: { findFirst: vi.fn(async () => ({ activeLeafMessageId: "answer" })) },
    modelRun: { update: vi.fn(async () => ({})) },
    modelRunToolCall: { findMany: vi.fn(async () => {
      order.push("read question");
      const rows = [{ arguments: { question: asks[current as keyof typeof asks] }, id: current, subagentTurnId: turn.id }];
      if (moved === "after_read") current = "ask-2";
      return rows;
    }) },
    runFollowup: { create: vi.fn(async (_input: { data: { nonce: string; text: string } }) => {
      order.push("follow-up");
      return {};
    }), findMany: vi.fn(async () => []) },
    subagentTurn: {
      findFirst: vi.fn(async () => {
        order.push("read turn");
        return { ...turn, executionRun: { id: "background-run" }, parentRun: { assistantMessageId: "parent-answer" }, result: null, thread: { name: "asker" } };
      }),
      updateMany: vi.fn(async ({ data, where }: { data: { callbackRunId: string }; where: { OR: ReadonlyArray<{ executionRun?: { is: { toolCalls: { some: { id: string } } } };
        id: unknown; state?: string }> } }) => {
        order.push("claim");
        // What the row and the open call say now, not what the delivery read; a claim that names no call matches any.
        const claimed = where.OR.some((entry) => {
          const call = entry.executionRun?.is.toolCalls.some.id;
          return entry.id === turn.id && entry.state === turn.state && (call === undefined || call === current);
        });
        if (claimed) turn.callbackRunId = data.callbackRunId;
        return { count: claimed ? 1 : 0 };
      })
    }
  };
  const client = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) };
  const deliver = () => createPrismaSubagentBackgroundStore(client as unknown as PrismaClient).deliverIntoRun({ ...scope, runId: "main", turnId: turn.id });
  return { deliver, order, turn, tx };
}

describe("a question delivered into a running answer", () => {
  it("claims the question it renders, holding the turn from before it reads to the follow-up", async () => {
    const { deliver, order, turn, tx } = waitingTurn();
    expect(await deliver()).toBe("delivered");
    expect(order).toEqual(["lock turn", "read turn", "read question", "claim", "follow-up"]);
    expect(turn.callbackRunId).toBe("main");
    expect(tx.runFollowup.create.mock.calls[0]![0].data).toMatchObject({ nonce: "subagent-question:ask-1", text: expect.stringContaining("Which size?") as string });
  });

  it("claims nothing when the turn moved on to another question after the read", async () => {
    const { deliver, turn, tx } = waitingTurn("after_read");
    expect(await deliver()).not.toBe("delivered");
    expect(turn.callbackRunId).toBeNull();
    expect(tx.runFollowup.create).not.toHaveBeenCalled();
  });

  it("renders the question the turn asks once the lock is its own", async () => {
    const { deliver, tx } = waitingTurn("before_read");
    expect(await deliver()).toBe("delivered");
    expect(tx.runFollowup.create.mock.calls[0]![0].data).toMatchObject({ nonce: "subagent-question:ask-2", text: expect.stringContaining("Which colour?") as string });
  });
});

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

describe("the provider bindings a background run takes from its parent", () => {
  type Binding = Readonly<{ bindingKey: string; connectionId: string | null; credentialId: string | null; credentialSource: string;
    credentialVersionId: string | null; executionSnapshot: unknown; modelRunId: string; providerModelId: string | null; role: string }>;
  const row = (modelRunId: string, bindingKey: string, role = bindingKey): Binding => ({ bindingKey, connectionId: "connection-1",
    credentialId: "credential-1", credentialSource: "default", credentialVersionId: "version-1", executionSnapshot: { model: bindingKey },
    modelRunId, providerModelId: `model-${bindingKey}`, role });

  /** A parent's rows as the database filters them by run and key. */
  function tx(rows: readonly Binding[]) {
    const findMany = vi.fn(async ({ where }: { where: { bindingKey: { in: string[] }; modelRunId: string } }) => rows
      .filter((binding) => binding.modelRunId === where.modelRunId && where.bindingKey.in.includes(binding.bindingKey))
      .map(({ modelRunId: _run, ...binding }) => binding));
    const createMany = vi.fn(async (_input: { data: readonly Binding[] }) => ({ count: 0 }));
    return { client: { providerRunBinding: { createMany, findMany } } as unknown as Parameters<typeof copyCallProviderBindings>[0],
      createMany, findMany };
  }

  it("copies its parent's image and Vision bindings unchanged, so their attempt and usage rows have a binding of their own run", async () => {
    const { client, createMany } = tx([row("run-main", "answer"), row("run-main", "vision_analysis"), row("run-main", "image"),
      row("run-main", "search:web", "search"), row("run-other", "image")]);
    await copyCallProviderBindings(client, { fromRunId: "run-main", toRunId: "run-bg" });
    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany.mock.calls[0]![0].data).toEqual([row("run-bg", "vision_analysis"), row("run-bg", "image")]);
  });

  it("copies nothing a parent was not admitted with: its calls then fail as the parent's would", async () => {
    const { client, createMany, findMany } = tx([row("run-main", "answer"), row("run-other", "vision_analysis")]);
    await copyCallProviderBindings(client, { fromRunId: "run-main", toRunId: "run-bg" });
    expect(findMany).toHaveBeenCalledOnce();
    expect(createMany).not.toHaveBeenCalled();
  });
});
