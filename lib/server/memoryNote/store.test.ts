// @vitest-environment node
import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MCP_APPROVAL_CONTINUATION_KIND } from "../../contracts/mcpApprovals";
import { SUBAGENT_CALLBACK_TURN_KIND } from "../../contracts/subagents";
import { BROWSER_SIGN_IN_TURN_KIND } from "../../contracts/browserSignIn";
import { createPrismaMemoryNoteRepository } from "./store";

type StoredTurn = Readonly<{ scheduledTaskPrompt: boolean; systemTurnKind: string | null }>;
const own: StoredTurn = { scheduledTaskPrompt: false, systemTurnKind: null };
const allow: StoredTurn = { scheduledTaskPrompt: false, systemTurnKind: MCP_APPROVAL_CONTINUATION_KIND };
const wakeUp: StoredTurn = { scheduledTaskPrompt: false, systemTurnKind: SUBAGENT_CALLBACK_TURN_KIND };
const signIn: StoredTurn = { scheduledTaskPrompt: false, systemTurnKind: BROWSER_SIGN_IN_TURN_KIND };

/** A run of the user's own chat whose message has the stored chain `chain` (`storedUserRequest`), the message first. */
function repository(chain: readonly StoredTurn[]) {
  const tx = {
    $queryRaw: vi.fn(async (..._query: unknown[]) => chain),
    modelRun: { findFirst: vi.fn(async () => ({ assistantMessageId: "answer-1", chat: { memoryMode: "NORMAL", userId: "user-1" },
      userMessageId: "message-1" })) }
  };
  return { repo: createPrismaMemoryNoteRepository(tx as unknown as Prisma.TransactionClient), tx };
}

describe("the memory note's read of the turn a change belongs to", () => {
  it.each([
    ["the user's own message", [own], true],
    ["the continuation after an MCP Allow of the user's own turn", [allow, own], true],
    ["a continuation of a continuation of the user's own turn", [allow, allow, own], true],
    ["a sub-agent wake-up", [wakeUp], false],
    ["a browser sign-in request", [signIn], false],
    ["the continuation after an MCP Allow of a wake-up's call", [allow, wakeUp], false],
    ["the continuation after an MCP Allow of a sign-in request's call", [allow, signIn], false],
    ["a continuation that names no Allow, as in a branch copy", [allow], false],
    ["an answer to a scheduled task's prompt", [{ ...own, scheduledTaskPrompt: true }], false]
  ] as const)("reads %s from the stored chain of the run's own message", async (_name, chain, userTurn) => {
    const { repo, tx } = repository(chain);
    expect(await repo.runChat({ chatId: "chat-1", runId: "run-1", userId: "user-1" }))
      .toEqual({ assistantMessageId: "answer-1", memoryMode: "NORMAL", userTurn });
    const [strings, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    expect(strings.join("?")).toContain("WITH RECURSIVE");
    expect(values.slice(0, 3)).toEqual(["message-1", "user-1", "user-1"]);
  });
});
