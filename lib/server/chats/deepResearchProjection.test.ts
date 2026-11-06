import { describe, expect, it, vi } from "vitest";
import { decodeChatUpdateData } from "../../contracts/chats";
import { serializeChatUpdate } from "../runs/chatUpdateWire";
import type { RunChatUpdateRecord } from "../runs/runRepositoryContract";
import { loadDeepResearchMarks } from "./deepResearchProjection";

const SENT_WITH = { equals: true, path: ["deepResearch"] };

describe("the Deep research marks of a page and of a run's chat update", () => {
  it("marks a question by its runs' frozen choice and an answer by its run's choice or research frame, asking only of the main agent's runs", async () => {
    const findMany = vi.fn(async (args: { where: Readonly<Record<string, unknown>> }) => "userMessageId" in args.where ? [{ userMessageId: "question" }]
      : [{ assistantMessageId: "answer" }, { assistantMessageId: "continued" }, { assistantMessageId: null }]);
    const marks = await loadDeepResearchMarks({ modelRun: { findMany } } as never, { chatId: "chat", userId: "user" }, [{ id: "question", role: "user" },
      { id: "answer", role: "assistant" }, { id: "continue", role: "user" }, { id: "continued", role: "assistant" }]);
    expect([...marks.sentWithDeepResearch]).toEqual(["question"]);
    // A Continue's answer is a research answer by its own run, which a Continue's message never is: it was not sent with Deep research.
    expect([...marks.researchAnswers]).toEqual(["answer", "continued"]);
    expect(findMany.mock.calls).toEqual([
      [{ distinct: ["userMessageId"], select: { userMessageId: true },
        where: { chatId: "chat", normalizedRequest: SENT_WITH, subagentTurnId: null, userId: "user", userMessageId: { in: ["question", "continue"] } } }],
      [{ distinct: ["assistantMessageId"], select: { assistantMessageId: true }, where: { assistantMessageId: { in: ["answer", "continued"] }, chatId: "chat",
        OR: [{ normalizedRequest: SENT_WITH }, { researchFrame: { isNot: null } }], subagentTurnId: null, userId: "user" } }]
    ]);
  });

  it("asks nothing of a role the messages do not have", async () => {
    const findMany = vi.fn(async () => []);
    const marks = await loadDeepResearchMarks({ modelRun: { findMany } } as never, { chatId: "chat", userId: "user" }, []);
    expect(findMany).not.toHaveBeenCalled();
    expect([marks.researchAnswers.size, marks.sentWithDeepResearch.size]).toEqual([0, 0]);
  });

  it("carries each mark on a run's chat update only on its own role, so a live answer keeps what a reload shows", () => {
    const message = (id: string, role: "assistant" | "user", marks: Readonly<{ deepResearch?: true; researchAnswer?: true }>) => ({ content: { blocks: [] },
      createdAt: "2026-11-06T00:00:00.000Z", id, modelId: null, parentMessageId: null, provider: null, role, status: "complete", ...marks });
    const update = serializeChatUpdate({ chat: { activeLeafMessageId: "answer", contextStats: { approximateActiveBranchInputTokens: 0 }, createdAt: "2026-11-06T00:00:00.000Z",
      defaultModelId: null, defaultProvider: null, folderId: null, id: "chat", messageCount: 2, pinned: false, title: "Research", updatedAt: "2026-11-06T00:00:00.000Z" },
    messages: [message("question", "user", { deepResearch: true, researchAnswer: true }), message("answer", "assistant", { deepResearch: true, researchAnswer: true }),
      message("plain", "assistant", {})] } satisfies RunChatUpdateRecord);
    // As the browser reads it, through the same decoder as the page.
    expect(decodeChatUpdateData(JSON.parse(JSON.stringify(update)))?.messages.map((entry) => [entry.id, entry.deepResearch ?? null, entry.researchAnswer ?? null]))
      .toEqual([["question", true, null], ["answer", null, true], ["plain", null, null]]);
  });
});
