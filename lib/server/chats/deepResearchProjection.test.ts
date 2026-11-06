import { describe, expect, it, vi } from "vitest";
import { decodeChatUpdateData } from "../../contracts/chats";
import { serializeChatUpdate } from "../runs/chatUpdateWire";
import type { RunChatUpdateRecord } from "../runs/runRepositoryContract";
import { pageOf, researchDatabase, type StoredTurn } from "../research/researchedRuns.testFixtures";
import { loadDeepResearchMarks } from "./deepResearchProjection";

const SENT_WITH = { equals: true, path: ["deepResearch"] };

describe("the Deep research marks of a page and of a run's chat update", () => {
  it("marks a question by its runs' frozen choice, and every answer of a research: its own, the turn after an Allow and a Continue that failed first", async () => {
    const turns: Readonly<Record<string, StoredTurn>> = {
      research: { chosen: true, status: "complete" },
      approved: { message: "approval", previous: "research", status: "error" },
      continued: { message: "continue", previous: "approved", status: "error" },
      again: { message: "continue", previous: "continued", status: "error" },
      ordinary: { previous: "again", status: "error" },
      ordinaryApproval: { message: "approval", previous: "ordinary", status: "error" },
      typed: { message: "continue", previous: "ordinaryApproval", status: "complete" }
    };
    const { client, reads } = researchDatabase(turns);
    const marks = await loadDeepResearchMarks(client as never, { chatId: "chat", userId: "user" }, pageOf(turns));
    expect([...marks.sentWithDeepResearch]).toEqual(["q-research"]);
    expect([...marks.researchAnswers].sort()).toEqual(["a-again", "a-approved", "a-continued", "a-research"]);
    // A page holds its questions' words, so it asks the database of none.
    expect(reads.continues).toBe(0);
    // An ordinary chat's turn after an Allow and its Continue are no research's.
    const plain = { ordinary: { status: "error" }, ordinaryApproval: { message: "approval", previous: "ordinary", status: "error" },
      typed: { message: "continue", previous: "ordinaryApproval", status: "error" } } as const;
    const ordinary = await loadDeepResearchMarks(researchDatabase(plain).client as never, { chatId: "chat", userId: "user" }, pageOf(plain));
    expect([ordinary.researchAnswers.size, ordinary.sentWithDeepResearch.size]).toEqual([0, 0]);
  });

  it("reads past the page for a turn it goes on from, and the words of a question it does not hold", async () => {
    const turns: Readonly<Record<string, StoredTurn>> = { research: { chosen: true, status: "error" }, continued: { message: "continue", previous: "research", status: "error" } };
    const { client, reads } = researchDatabase(turns);
    // A run's chat update holds its own question and answer alone.
    const marks = await loadDeepResearchMarks(client as never, { chatId: "chat", userId: "user" }, pageOf(turns).slice(2));
    expect([...marks.researchAnswers]).toEqual(["a-continued"]);
    expect(reads).toEqual({ continues: 0, rows: 2 });
    const unheld = await loadDeepResearchMarks(client as never, { chatId: "chat", userId: "user" },
      pageOf(turns).slice(2).map(({ content: _content, ...message }) => message));
    expect([...unheld.researchAnswers]).toEqual(["a-continued"]);
    expect(reads.continues).toBe(1);
  });

  it("asks only of the main agent's runs of its owner and chat for the question's mark", async () => {
    const { client } = researchDatabase({ research: { chosen: true, status: "complete" } });
    const findMany = vi.spyOn(client.modelRun, "findMany");
    await loadDeepResearchMarks(client as never, { chatId: "chat", userId: "user" }, [{ id: "q-research", role: "user" }, { id: "q-other", role: "user" }]);
    expect(findMany).toHaveBeenCalledExactlyOnceWith({ distinct: ["userMessageId"], select: { userMessageId: true },
      where: { chatId: "chat", normalizedRequest: SENT_WITH, subagentTurnId: null, userId: "user", userMessageId: { in: ["q-research", "q-other"] } } });
    // Nothing to mark asks nothing.
    findMany.mockClear();
    const none = await loadDeepResearchMarks(client as never, { chatId: "chat", userId: "user" }, [{ id: "a-research", role: "assistant", runId: null }]);
    expect(findMany).not.toHaveBeenCalled();
    expect([none.researchAnswers.size, none.sentWithDeepResearch.size]).toEqual([0, 0]);
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
