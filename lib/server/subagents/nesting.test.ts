// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_ERROR_CODES, SUBAGENT_LIMITS } from "../../contracts/subagents";
import {
  MAIN_AGENT_AUTHOR,
  childAdmissionRefusal,
  mailboxWriter,
  turnAnswerMessageId,
  turnMainRunId,
  turnsOfMainRuns
} from "./nesting";
import type { SubagentParentAgent } from "./ports";

const parentAgent: SubagentParentAgent = { name: "research", runId: "run-bg", threadId: "thread-parent", toolState: { calls: 0 }, turnId: "turn-parent" };

function tx(input: Readonly<{ parentTurn?: Readonly<{ id: string }> | null; running?: number; starter?: Readonly<{ parentThreadId: string | null }> | null }> = {}) {
  return {
    subagentThread: { findFirst: vi.fn(async () => input.starter === undefined ? { parentThreadId: null } : input.starter) },
    subagentTurn: { count: vi.fn(async () => input.running ?? 0), findFirst: vi.fn(async () => input.parentTurn === undefined ? { id: "turn-parent" } : input.parentTurn) }
  } as unknown as Parameters<typeof childAdmissionRefusal>[0];
}

const refusal = (client: Parameters<typeof childAdmissionRefusal>[0], extra: Partial<Parameters<typeof childAdmissionRefusal>[1]> = {}) =>
  childAdmissionRefusal(client, { chatId: "chat", parentAgent, thread: null, userId: "user", ...extra });

describe("what places a child on its branch", () => {
  it("is the main-agent run behind its parent: the run that holds its call answers nothing when its parent runs in the background", () => {
    const background = { assistantMessageId: null, subagentTurn: { parentRun: { assistantMessageId: "answer-1" }, parentRunId: "run-main" } };
    expect(turnAnswerMessageId(background)).toBe("answer-1");
    expect(turnMainRunId("run-bg", background)).toBe("run-main");
  });

  it("is its own parent run for what the main agent, or a foreground parent inside its run, started", () => {
    expect(turnAnswerMessageId({ assistantMessageId: "answer-2", subagentTurn: null })).toBe("answer-2");
    expect(turnMainRunId("run-main", { subagentTurn: null })).toBe("run-main");
  });

  it("selects a main-agent run's turns and those one step under it", () => {
    expect(turnsOfMainRuns(["run-main", "run-main"])).toEqual({ OR: [{ parentRunId: { in: ["run-main"] } },
      { parentRun: { subagentTurn: { is: { parentRunId: { in: ["run-main"] } } } } }] });
  });
});

describe("a mailbox row's writer", () => {
  it("is a sub-agent's name, never the main agent's label", () => {
    expect(mailboxWriter("research")).toBe("research");
    expect(mailboxWriter(MAIN_AGENT_AUTHOR)).toBeUndefined();
    expect(mailboxWriter("Sub-agent")).toBeUndefined();
  });
});

describe("what a sub-agent may start", () => {
  it("admits a child up to the limit, counting only its own that are active", async () => {
    const client = tx({ running: SUBAGENT_LIMITS.childrenPerSubagent - 1 });
    expect(await refusal(client)).toBeNull();
    expect(client.subagentTurn.count).toHaveBeenCalledWith({ where: { chatId: "chat", state: { in: ["running", "waiting"] },
      thread: { parentThreadId: "thread-parent" }, userId: "user" } });
  });

  it("refuses a third child at once, and a child starting its own", async () => {
    expect(await refusal(tx({ running: SUBAGENT_LIMITS.childrenPerSubagent }))).toBe(SUBAGENT_ERROR_CODES.childLimit);
    expect(await refusal(tx({ starter: { parentThreadId: "thread-grandparent" } }))).toBe(SUBAGENT_ERROR_CODES.depthLimit);
  });

  it("refuses a parent it cannot find under the caller's chat and owner", async () => {
    expect(await refusal(tx({ starter: null }))).toBe(SUBAGENT_ERROR_CODES.notFound);
  });

  it("needs its parent's very turn active, whatever the run behind it does", async () => {
    const client = tx({ parentTurn: null });
    expect(await refusal(client)).toBe(SUBAGENT_ERROR_CODES.notActive);
    expect(client.subagentTurn.findFirst).toHaveBeenCalledWith({ select: { id: true }, where: { chatId: "chat", id: "turn-parent", state: { in: ["running", "waiting"] },
      threadId: "thread-parent", userId: "user" } });
  });

  it("keeps a thread with the agent that started it, and leaves the main agent's own alone", async () => {
    expect(await refusal(tx(), { thread: { parentThreadId: "thread-other" } })).toBe(SUBAGENT_ERROR_CODES.notOwnChild);
    expect(await refusal(tx(), { thread: { parentThreadId: null } })).toBe(SUBAGENT_ERROR_CODES.notOwnChild);
    expect(await refusal(tx(), { thread: { parentThreadId: "thread-parent" } })).toBeNull();
    const client = tx();
    expect(await childAdmissionRefusal(client, { chatId: "chat", thread: { parentThreadId: "thread-parent" }, userId: "user" }))
      .toBe(SUBAGENT_ERROR_CODES.notOwnChild);
    expect(await childAdmissionRefusal(client, { chatId: "chat", thread: { parentThreadId: null }, userId: "user" })).toBeNull();
    expect(await childAdmissionRefusal(client, { chatId: "chat", thread: null, userId: "user" })).toBeNull();
  });
});
