import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { threadOnBranch } from "./branchPath";

/** Two answers on one branch, and a sibling that edited the first question. */
const PATHS: Readonly<Record<string, readonly string[]>> = {
  "answer-1": ["answer-1", "question-1"],
  "answer-2": ["answer-2", "question-2", "answer-1", "question-1"],
  "answer-sibling": ["answer-sibling", "question-sibling"]
};

function tx(input: Readonly<{ activeLeaf: string | null; chatFound?: boolean; parentAnswer?: string | null; threads: readonly Readonly<{ anchor: string | null; id: string }>[] }>) {
  return {
    $queryRaw: vi.fn(async (_query: TemplateStringsArray, _chatId: string, leaf: string) => (PATHS[leaf] ?? []).map((id) => ({ id }))),
    chat: { findFirst: vi.fn(async () => input.chatFound === false ? null : { activeLeafMessageId: input.activeLeaf }) },
    modelRun: { findFirst: vi.fn(async () => input.parentAnswer === null ? null : { assistantMessageId: input.parentAnswer ?? "answer-1" }) },
    subagentThread: { findMany: vi.fn(async () => input.threads.map((thread) => ({ anchorRun: { assistantMessageId: thread.anchor }, id: thread.id }))) }
  } as unknown as Prisma.TransactionClient;
}

const scope = { chatId: "chat", name: "shop", parentRunId: "run-1", userId: "user" };

describe("the thread a name means on an agent's branch", () => {
  it("finds one the main agent started after the agent's own run, on the branch the chat is on", async () => {
    const found = await threadOnBranch(tx({ activeLeaf: "answer-2", threads: [{ anchor: "answer-2", id: "thread-later" }] }), scope);
    expect(found?.threadId).toBe("thread-later");
    expect(found?.path.has("answer-2")).toBe(true);
  });

  it("leaves a sibling branch's thread of the name alone, the user's switch to it included", async () => {
    const threads = [{ anchor: "answer-sibling", id: "thread-sibling" }];
    expect(await threadOnBranch(tx({ activeLeaf: "answer-2", threads }), scope)).toBeNull();
    expect(await threadOnBranch(tx({ activeLeaf: "answer-sibling", threads }), scope)).toBeNull();
  });

  it("reads the agent's own path when the chat moved off it", async () => {
    const found = await threadOnBranch(tx({ activeLeaf: "answer-sibling", threads: [{ anchor: "answer-1", id: "thread-own" }] }), scope);
    expect(found?.threadId).toBe("thread-own");
    expect(found?.path.has("answer-sibling")).toBe(false);
  });

  it("means nothing for an anchor with no answer, a run with none or a chat out of reach", async () => {
    expect(await threadOnBranch(tx({ activeLeaf: "answer-2", threads: [{ anchor: null, id: "thread-unanswered" }] }), scope)).toBeNull();
    expect(await threadOnBranch(tx({ activeLeaf: "answer-2", parentAnswer: null, threads: [{ anchor: "answer-1", id: "thread" }] }), scope)).toBeNull();
    expect(await threadOnBranch(tx({ activeLeaf: "answer-2", chatFound: false, threads: [{ anchor: "answer-1", id: "thread" }] }), scope)).toBeNull();
  });
});
