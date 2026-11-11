import { describe, expect, it } from "vitest";
import { decodeChatDetailResponse } from "@/lib/contracts/chats";
import { serializeChatDetail, type ChatDetailRecord } from "./handlers";

/**
 * Both installations upgrade with tabs open, so a task chat's detail must
 * stay decodable by the previous release's client: its marker check wants
 * exactly `taskId`, `taskRunId`, `title` and `unseen`, and its live detail
 * decoder reads named fields only, so the new `quietChecks` passes it by.
 */
describe("a task chat's detail on the wire", () => {
  const at = "2026-11-11T11:00:00.000Z";
  const record: ChatDetailRecord = {
    activeLeafMessageId: "answer-1",
    contextStats: { approximateActiveBranchInputTokens: 3 },
    createdAt: at,
    defaultModelId: null,
    defaultProvider: null,
    folderId: null,
    id: "chat-1",
    messageCount: 600,
    messages: [{
      content: { blocks: [{ text: "Check the release page", type: "text" }] }, createdAt: at, id: "question-1", modelId: null,
      parentMessageId: null, provider: null, role: "user", scheduledOutcome: "baseline",
      // A turn whose occurrence was pruned: its own run's id names it.
      scheduledTask: { taskId: "task-1", taskRunId: "run-1", title: "Release watch", unseen: false }, status: "complete"
    }, {
      content: { blocks: [{ text: "Version 1.0 is current.", type: "text" }] }, createdAt: at, id: "answer-1", modelId: null,
      parentMessageId: "question-1", provider: null, role: "assistant", scheduledOutcome: "baseline", status: "complete"
    }],
    pageInfo: { activeLeafMessageId: "answer-1", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: at },
    pinned: false,
    quietChecks: { count: 297, lastAt: new Date(at) },
    title: "Release watch",
    updatedAt: at,
    usageStats: null
  };

  it("keeps the marker's four keys and decodes with its summary", () => {
    const wire = JSON.parse(JSON.stringify({ chat: serializeChatDetail(record) })) as { chat: { messages: Array<Record<string, unknown>> } };
    expect(Object.keys(wire.chat.messages[0]!.scheduledTask as object).sort()).toEqual(["taskId", "taskRunId", "title", "unseen"]);
    const decoded = decodeChatDetailResponse(wire);
    expect(decoded?.messages[0]?.scheduledTask).toEqual({ taskId: "task-1", taskRunId: "run-1", title: "Release watch", unseen: false });
    expect(decoded?.quietChecks).toEqual({ count: 297, lastAt: at });
  });
});
