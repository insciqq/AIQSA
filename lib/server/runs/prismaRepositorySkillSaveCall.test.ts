// @vitest-environment node
import type { Prisma, PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MCP_APPROVAL_CONTINUATION_KIND } from "../../contracts/mcpApprovals";
import { SUBAGENT_CALLBACK_TURN_KIND } from "../../contracts/subagents";
import { BROWSER_SIGN_IN_TURN_KIND } from "../../contracts/browserSignIn";
import { commitSkillSaveInTransaction } from "../skills/skillSave";
import { SAVE_SKILL_TOOL_NAME } from "../tools/skillSave";
import { saveSkillForToolCall } from "./prismaRepositorySkillSaveCall";

vi.mock("../skills/skillSave", () => ({ commitSkillSaveInTransaction: vi.fn() }));

type StoredTurn = Readonly<{ scheduledTaskPrompt: boolean; systemTurnKind: string | null }>;
const own: StoredTurn = { scheduledTaskPrompt: false, systemTurnKind: null };
const allow: StoredTurn = { scheduledTaskPrompt: false, systemTurnKind: MCP_APPROVAL_CONTINUATION_KIND };
const wakeUp: StoredTurn = { scheduledTaskPrompt: false, systemTurnKind: SUBAGENT_CALLBACK_TURN_KIND };
const signIn: StoredTurn = { scheduledTaskPrompt: false, systemTurnKind: BROWSER_SIGN_IN_TURN_KIND };

/**
 * A running `save_skill` call of an active personal run whose user message has the stored chain `chain`
 * (`storedUserRequest`): the message first, then the message of the run each Allow gated.
 */
function harness(chain: readonly StoredTurn[]) {
  const turnReads: unknown[][] = [];
  const tx = {
    $queryRaw: vi.fn(async (query: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
      const text = (Array.isArray(query) ? query : (query as Prisma.Sql).strings).join("?");
      if (text.includes("WITH RECURSIVE")) {
        turnReads.push(values);
        return chain;
      }
      if (text.includes("r.\"errorPayload\"")) {
        return [{ errorPayload: null, scheduledTaskId: null, status: "streaming", userMessageId: "message-1" }];
      }
      if (text.includes("r.\"chatId\", r.\"userId\"")) return [{ chatId: "chat-1", userId: "user-1" }];
      return [{ id: "locked" }];
    }),
    modelRunToolCall: { findFirst: vi.fn(async () => ({ providerCallId: "provider-call-1", result: null, state: "running",
      toolName: SAVE_SKILL_TOOL_NAME })) },
    user: { findFirst: vi.fn(async () => ({ id: "user-1" })) }
  };
  const prisma = { $transaction: vi.fn(async (operation: (client: typeof tx) => Promise<unknown>) => operation(tx)) };
  const save = () => saveSkillForToolCall(prisma as unknown as PrismaClient, { bundle: null, callId: "persisted-1",
    changeNote: null, result: () => { throw new Error("not_saved_here"); }, runId: "run-1",
    target: { kind: "new" }, userId: "user-1" });
  return { save, turnReads };
}

beforeEach(() => {
  vi.mocked(commitSkillSaveInTransaction).mockReset().mockResolvedValue({ code: "skill_save_unavailable" as never, kind: "refused" });
});

describe("a Skill save's run fence", () => {
  it.each([
    ["the user's own message", [own]],
    ["the continuation after an MCP Allow of the user's own turn", [allow, own]],
    ["a continuation of a continuation of the user's own turn", [allow, allow, own]]
  ] as const)("reaches the save for %s, reading the run's own message as its user", async (_name, chain) => {
    const h = harness(chain);
    expect(await h.save()).toMatchObject({ kind: "not_saved" });
    expect(commitSkillSaveInTransaction).toHaveBeenCalledTimes(1);
    expect(h.turnReads[0]?.slice(0, 3)).toEqual(["message-1", "user-1", "user-1"]);
  });

  it.each([
    ["a sub-agent wake-up", [wakeUp]],
    ["a browser sign-in request", [signIn]],
    ["the continuation after an MCP Allow of a wake-up's call", [allow, wakeUp]],
    ["the continuation after an MCP Allow of a sign-in request's call", [allow, signIn]],
    ["a continuation of a continuation of a wake-up", [allow, allow, wakeUp]],
    ["a continuation that names no Allow, as in a branch copy", [allow]],
    ["an answer to a scheduled task's prompt", [{ ...own, scheduledTaskPrompt: true }]],
    ["a missing message", []]
  ] as const)("saves nothing for %s", async (_name, chain) => {
    expect(await harness(chain).save()).toEqual({ kind: "unavailable" });
    expect(commitSkillSaveInTransaction).not.toHaveBeenCalled();
  });
});
