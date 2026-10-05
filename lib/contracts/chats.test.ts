import { describe, expect, it } from "vitest";
import { MEMORY_ANSWER_SOURCE_MAX_ITEMS } from "./memoryClient";
import {
  CHAT_BRANCH_PREVIEW_MAX_LENGTH,
  CHAT_HISTORY_PAGE_SIZE,
  THREAD_CITATION_MAX_ITEMS,
  THREAD_REASONING_MAX_CHARACTERS,
  THREAD_REASONING_MAX_ENTRIES,
  THREAD_SEARCH_SOURCE_MAX_ITEMS,
  boundedChatBranchPreview,
  boundedChatTitle,
  CHAT_TITLE_MAX_LENGTH,
  codePointLength,
  DEFAULT_CHAT_TITLE,
  importedChatTitle,
  decodeArchivedChatDetailResponse,
  decodeArchivedChatsResponse,
  decodeChatBranchesResponse,
  decodeChatDetailResponse,
  decodeChatLifecycleRequest,
  decodeChatLifecycleResponse,
  decodeChatMemoryStateResponse,
  CHAT_MESSAGE_MATCH_SNIPPET_MAX_LENGTH,
  chatMessageSearchApplies,
  decodeChatMessageMatchPage,
  decodeChatNavigationPage,
  decodeChatMessagesPageResponse,
  normalizeChatNavigationQuery,
  decodeChatSourceResolutionResponse,
  decodeChatSummaryResponse,
  decodeChatUpdateData,
  decodeWorkspaceChatsResponse,
  applyChatAssistantOverridesPatch,
  CHAT_ASSISTANT_DELETED_MARKER,
  decodeChatAssistantProjection,
  decodeChatAssistantUpdate,
  decodeStoredChatAssistantOverrides,
  storedChatAssistantOverrides
} from "./chats";

const summary = {
  activeLeafMessageId: "message-1",
  createdAt: "2026-07-14T08:00:00.000Z",
  defaultKnowledgePlan: null,
  defaultModelId: "gpt-5.5",
  defaultProvider: "openai",
  folderId: null,
  id: "chat-1",
  messageCount: 1,
  pinned: false,
  projectId: null,
  title: "Exact boundary",
  updatedAt: "2026-07-14T08:01:00.000Z"
};

const nullDefaultSummary = {
  ...summary,
  defaultModelId: null,
  defaultProvider: null,
  id: "chat-without-default",
  title: "Choose a model when ready"
};

const message = {
  artifactSummary: null,
  citationMessageId: null,
  content: { blocks: [{ text: "Answer", type: "text" }] },
  createdAt: "2026-07-14T08:00:30.000Z",
  errorMessage: null,
  id: "message-1",
  modelId: "gpt-5.5",
  modelRunId: "run-1",
  parentMessageId: null,
  provider: "openai",
  role: "assistant",
  status: "complete"
};

const usageStats = {
  hasCompletedAnswer: true,
  incompleteRecordCount: 0,
  recordCount: 1,
  knownCostRecordCount: 0,
  estimatedCostMicros: null,
  totalTokens: 10
};

const contextStats = { approximateActiveBranchInputTokens: 7 };

describe("chat cumulative accounting contract", () => {
  it("keeps only bounded aggregate fields", () => {
    const totals = { hasCompletedAnswer: true, recordCount: 3, knownCostRecordCount: 2, incompleteRecordCount: 1,
      totalTokens: 100, estimatedCostMicros: 0 };
    expect(decodeChatDetailResponse({ chat: detailChat({ messages: [message], usageStats: {
      ...totals, rows: [{ private: true }]
    } }) })?.usageStats).toEqual(totals);
  });
  it.each([
    { hasCompletedAnswer: undefined }, { hasCompletedAnswer: null }, { hasCompletedAnswer: 1 }, { titleUsagePending: "yes" },
    { recordCount: -1 }, { knownCostRecordCount: 2 }, { incompleteRecordCount: 2 },
    { estimatedCostMicros: 1 }, { totalTokens: Number.MAX_SAFE_INTEGER + 1 },
    { knownCostRecordCount: 1, estimatedCostMicros: null }
  ])("rejects inconsistent accounting %j", patch => {
    expect(decodeChatDetailResponse({ chat: detailChat({ messages: [message], usageStats: {
      ...usageStats, ...patch
    } }) })).toBeNull();
  });
  it("preserves server eligibility independently of receipts or the current message page", () => {
    for (const hasCompletedAnswer of [false, true]) {
      const decoded = decodeChatDetailResponse({ chat: detailChat({ messages: [{ ...message, role: "user" }], usageStats: {
        ...usageStats, hasCompletedAnswer
      } }) });
      expect(decoded?.usageStats?.hasCompletedAnswer).toBe(hasCompletedAnswer);
      expect(decoded?.usageStats?.recordCount).toBe(1);
    }
  });
});
const pageInfo = {
  activeLeafMessageId: summary.activeLeafMessageId,
  beforeCursor: null,
  hasOlder: false,
  snapshotUpdatedAt: summary.updatedAt
};

function detailChat(overrides: Record<string, unknown> = {}) {
  return { ...summary, assistant: null, contextStats, pageInfo, ...overrides };
}

describe("chat wire contracts", () => {
  it("decodes the source message for a context snapshot and rejects malformed or orphan identities", () => {
    const session = { approximateInputTokens: 6000, contextWindow: 10000, droppedMessages: 4, loadedTools: 2,
      maxOutputTokens: 1024, modelId: "gpt-5.5", phase: "after_answer", provider: "openai",
      safetyMarginTokens: 1000, version: 1 };
    const decode = (stats: unknown) => decodeChatDetailResponse({
      chat: detailChat({ messages: [message], usageStats, contextStats: stats })
    });
    expect(decode({ ...contextStats, session, sessionMessageId: message.id })?.contextStats)
      .toEqual({ ...contextStats, session, sessionMessageId: message.id, approximateInputTokensAfterSession: 0 });
    for (const id of [12, {}, ""]) expect(decode({ ...contextStats, session, sessionMessageId: id })).toBeNull();
    expect(decode({ ...contextStats, sessionMessageId: message.id })).toBeNull();
    const fallback = { ...contextStats, session, sessionMessageId: "earlier-answer",
      sessionBranchLeafId: message.id, approximateInputTokensAfterSession: 321 };
    expect(decode(fallback)?.contextStats).toEqual(fallback);
    for (const approximateInputTokensAfterSession of [-1, 1.5, "321", null, Number.MAX_SAFE_INTEGER + 1]) {
      expect(decode({ ...fallback, approximateInputTokensAfterSession })).toBeNull();
    }
    for (const sessionBranchLeafId of [12, {}, ""]) expect(decode({ ...fallback, sessionBranchLeafId })).toBeNull();
    expect(decode({ ...fallback, session: null })).toBeNull();
    expect(decode({ ...fallback, sessionMessageId: null })).toBeNull();
  });

  it("preserves authoritative activity origin and rejects unknown origins", () => {
    const call = { round: 1, serverName: "Repository Tools", status: "error", toolName: "search" };
    const decode = (origin: unknown) => decodeChatDetailResponse({
      chat: detailChat({ messages: [{ ...message, toolActivity: { calls: [{ ...call, origin }] } }], usageStats })
    });

    for (const origin of ["mcp", "web_search", "knowledge", "discovery", "workspace", "memory", "session", "tool", "vision"]) {
      expect(decode(origin)?.messages[0]?.toolActivity).toEqual({ calls: [{ ...call, origin }] });
    }
    expect(decode(undefined)?.messages[0]?.toolActivity).toEqual({ calls: [call] });
    for (const origin of ["unknown", "", null, { kind: "mcp" }]) {
      expect(decode(origin)).toBeNull();
    }
  });

  it("keeps a page read's bounded target and outcome only on its own origin", () => {
    const call = { origin: "web_fetch", round: 1, serverName: "Web", status: "error", toolName: "fetch_url",
      fetchTarget: "news.example/today", fetchOutcome: "fetch_http_status", fetchHttpStatus: 503 };
    const decode = (row: Record<string, unknown>) => decodeChatDetailResponse({
      chat: detailChat({ messages: [{ ...message, toolActivity: { calls: [row] } }], usageStats })
    })?.messages[0]?.toolActivity?.calls[0];
    expect(decode(call)).toEqual(call);
    // Unknown outcomes, a scheme in the target and facts on another origin are dropped.
    expect(decode({ ...call, fetchOutcome: "fetch_secret", fetchTarget: "https://news.example/today" }))
      .toEqual({ origin: "web_fetch", round: 1, serverName: "Web", status: "error", toolName: "fetch_url" });
    expect(decode({ ...call, origin: "mcp" })).not.toHaveProperty("fetchTarget");
    expect(decode({ ...call, fetchOutcome: "read" })).not.toHaveProperty("fetchHttpStatus");
    // Where a refused link is allowed belongs only to a not-in-conversation refusal, with a known scope.
    for (const scope of ["scheduled_run", "task_instructions"]) {
      expect(decode({ ...call, fetchOutcome: "fetch_url_not_in_conversation", fetchRefusalScope: scope }))
        .toMatchObject({ fetchRefusalScope: scope });
    }
    expect(decode({ ...call, fetchRefusalScope: "scheduled_run" })).not.toHaveProperty("fetchRefusalScope");
    expect(decode({ ...call, fetchOutcome: "fetch_url_not_in_conversation", fetchRefusalScope: "everywhere" }))
      .not.toHaveProperty("fetchRefusalScope");
  });

  it("preserves bounded MCP call references and refuses references on other origins", () => {
    const call = { origin: "mcp", round: 2, status: "running", toolName: "search" };
    const decode = (details: unknown, origin: unknown = "mcp") => decodeChatDetailResponse({
      chat: detailChat({ messages: [{ ...message, toolActivity: { calls: [{ ...call, origin, details }] } }], usageStats })
    });
    expect(decode({ roundIndex: 2, ordinal: 0, privateId: "discarded" })?.messages[0]?.toolActivity?.calls[0])
      .toEqual({ ...call, details: { roundIndex: 2, ordinal: 0 } });
    for (const details of [null, true, {}, { roundIndex: 1, ordinal: 0 }, { roundIndex: 0, ordinal: 0 },
      { roundIndex: 2, ordinal: -1 }, { roundIndex: 2, ordinal: 0.5 },
      { roundIndex: 2, ordinal: Number.MAX_SAFE_INTEGER + 1 }, { roundIndex: "2", ordinal: 0 }]) {
      expect(decode(details)).toBeNull();
    }
    for (const origin of [undefined, "workspace", "memory", "skill", "discovery", "tool", "web_search",
      "knowledge", "session", "artifact", "image"]) {
      const row = { ...call, origin, details: { roundIndex: 2, ordinal: 0 } };
      expect(decodeChatDetailResponse({ chat: detailChat({ messages: [{ ...message,
        toolActivity: { calls: [row] } }], usageStats }) })).toBeNull();
    }
    expect(decode(undefined)?.messages[0]?.toolActivity?.calls[0]).not.toHaveProperty("details");
  });

  it("decodes the exact content-free navigation page", () => {
    const page = {
      chats: [{
        activeRun: true,
        assistant: null,
        folderId: "folder-1",
        id: "chat-1",
        title: "Quarterly review",
        updatedAt: "2026-08-13T00:00:00.000Z"
      }],
      folders: [{ id: "folder-1", name: "Work", parentId: null }],
      nextCursor: "opaque_cursor"
    };

    expect(decodeChatNavigationPage(page)).toEqual(page);
    expect(decodeChatNavigationPage({
      ...page,
      chats: [{ ...page.chats[0], messageCount: 10 }]
    })).toBeNull();
    expect(decodeChatNavigationPage({ ...page, nextCursor: "bad!" })).toBeNull();
    const identity = { avatar: { accents: [1], backgroundShape: "circle", foregroundShape: "ring", kind: "generated",
      paletteId: "ember", recipeVersion: 1, rotations: [0, 0] }, name: "Analyst" };
    const withAssistant = { ...page, chats: [{ ...page.chats[0], assistant: identity }] };
    expect(decodeChatNavigationPage(withAssistant)).toEqual(withAssistant);
    const { assistant: _assistant, ...withoutAssistant } = page.chats[0];
    expect(decodeChatNavigationPage({ ...page, chats: [withoutAssistant] })).toBeNull();
    for (const assistant of [{ ...identity, id: "assistant-1" }, { name: "Analyst" }, "Analyst"]) {
      expect(decodeChatNavigationPage({ ...page, chats: [{ ...page.chats[0], assistant }] })).toBeNull();
    }
    expect(decodeChatNavigationPage({
      ...page,
      chats: [...page.chats, page.chats[0]]
    })).toBeNull();
  });

  it("decodes a message match page on its own and keeps it out of title pages", () => {
    const match = {
      chatId: "chat-1",
      createdAt: "2026-08-12T10:00:00.000Z",
      matchCount: 3,
      messageId: "message-7",
      snippet: "…the quarterly budget moved to…",
      title: "Planning"
    };
    const messageMatches = { matches: [match], nextCursor: "opaque_cursor" };

    expect(decodeChatMessageMatchPage(messageMatches)).toEqual(messageMatches);
    expect(decodeChatMessageMatchPage({ matches: [], nextCursor: null })).toEqual({ matches: [], nextCursor: null });
    // The title search response carries no message matches.
    expect(decodeChatNavigationPage({ chats: [], folders: [], messageMatches, nextCursor: null })).toBeNull();
    for (const malformed of [
      { ...match, matchCount: 0 },
      { ...match, matchCount: 1.5 },
      { ...match, createdAt: "yesterday" },
      { ...match, messageId: "" },
      { ...match, title: "" },
      { ...match, snippet: null },
      { ...match, snippet: "x".repeat(CHAT_MESSAGE_MATCH_SNIPPET_MAX_LENGTH + 1) },
      { ...match, snippetHtml: "<mark>budget</mark>" },
      { ...match, content: { blocks: [] } }
    ]) {
      expect(decodeChatMessageMatchPage({ matches: [malformed], nextCursor: null })).toBeNull();
    }
    expect(decodeChatMessageMatchPage({ matches: [match, { ...match, messageId: "message-8" }], nextCursor: null })).toBeNull();
    expect(decodeChatMessageMatchPage({ ...messageMatches, nextCursor: "bad!" })).toBeNull();
    expect(decodeChatMessageMatchPage({ ...messageMatches, chats: [] })).toBeNull();
  });

  it("applies message matching from three characters of the normalized query", () => {
    expect(normalizeChatNavigationQuery("  ＢＵＤＧＥＴ  ")).toBe("budget");
    expect(chatMessageSearchApplies("ab")).toBe(false);
    expect(chatMessageSearchApplies(" ab ")).toBe(false);
    expect(chatMessageSearchApplies("abc")).toBe(true);
    // Characters, not UTF-16 units: two astral characters stay too short.
    expect(chatMessageSearchApplies("😀😀")).toBe(false);
    // Compatibility characters count as they are matched: ㍍ is メートル.
    expect(chatMessageSearchApplies("㍍")).toBe(true);
  });

  it("decodes a scheduled task chat's unread marker and rejects extra or malformed fields", () => {
    const chat = {
      activeRun: false, assistant: null, folderId: null, id: "chat-1", title: "Morning brief",
      updatedAt: "2026-10-04T09:00:00.000Z"
    };
    const page = (row: Record<string, unknown>) => ({ chats: [row], folders: [], nextCursor: null });
    const unread = { ...chat, scheduledTask: { taskId: "task-1", unseen: true } };
    expect(decodeChatNavigationPage(page(unread))?.chats[0]).toEqual(unread);
    expect(decodeChatNavigationPage(page({ ...chat, scheduledTask: null }))?.chats[0]).toEqual(chat);
    expect(decodeChatNavigationPage(page(chat))?.chats[0]).toEqual(chat);
    for (const scheduledTask of [{ taskId: "task-1" }, { taskId: "", unseen: true }, { taskId: "task-1", unseen: "yes" },
      { taskId: "task-1", unseen: true, title: "Morning brief" }, "task-1"]) {
      expect(decodeChatNavigationPage(page({ ...chat, scheduledTask }))).toBeNull();
    }
  });

  it("keeps a scheduled user turn's task marker and rejects a malformed one", () => {
    const decode = (scheduledTask: unknown) => decodeChatDetailResponse({ chat: detailChat({
      messages: [{ ...message, role: "user", scheduledTask }], usageStats
    }) });
    const marker = { taskId: "task-1", taskRunId: "run-1", title: "Morning brief", unseen: true };
    expect(decode(marker)?.messages[0]?.scheduledTask).toEqual(marker);
    expect(decode({ ...marker, unseen: false })?.messages[0]?.scheduledTask).toEqual({ ...marker, unseen: false });
    expect(decode(null)?.messages[0]?.scheduledTask).toBeNull();
    expect(decode(undefined)?.messages[0]).not.toHaveProperty("scheduledTask");
    for (const malformed of [{ taskId: "task-1", title: "Morning brief" }, { ...marker, title: "" }, { ...marker, prompt: "secret" },
      { ...marker, title: "x".repeat(CHAT_TITLE_MAX_LENGTH + 1) }, { ...marker, taskRunId: "" }, { ...marker, unseen: "yes" }]) {
      expect(decode(malformed)).toBeNull();
    }
  });

  it("keeps the cards of one created and five managed tasks with their actions, once per task", () => {
    const card = (taskId: string, action?: string) => ({ taskId, title: "Report reminder", kind: "standard",
      schedule: { kind: "daily", time: "09:00" }, timeZone: "Europe/Moscow", timeZoneFallback: false, toolsEnabled: false,
      workspaceEnabled: false, status: "active", nextRunAt: "2026-10-05T06:00:00.000Z", ...(action ? { action } : {}) });
    const cards = [card("created"), card("task-1", "changed"), card("task-2", "paused"), card("task-3", "resumed"),
      card("task-4", "delete_proposed"), card("task-5", "changed")];
    const decode = (scheduledTasks: unknown[]) => decodeChatDetailResponse({ chat: detailChat({ messages: [{ ...message,
      artifactSummary: { citations: [], reasoningText: [], sources: [], scheduledTasks } }], usageStats }) })
      ?.messages[0]?.artifactSummary?.scheduledTasks;
    expect(decode([...cards, card("task-1", "paused"), card("task-6", "paused")])).toEqual(cards);
    expect(decode([card("task-1", "archived"), card("task-2", "paused")])).toEqual([card("task-2", "paused")]);
  });

  it("keeps a monitoring check's settled outcome on both messages of its turn, with or without the task marker", () => {
    const decode = (entry: Record<string, unknown>) => decodeChatDetailResponse({ chat: detailChat({ messages: [entry], usageStats }) });
    expect(decode({ ...message, role: "user", scheduledOutcome: "no_update" })?.messages[0]?.scheduledOutcome).toBe("no_update");
    expect(decode({ ...message, scheduledOutcome: "goal_reached" })?.messages[0]?.scheduledOutcome).toBe("goal_reached");
    expect(decode(message)?.messages[0]).not.toHaveProperty("scheduledOutcome");
    for (const scheduledOutcome of ["hidden", null, 1]) expect(decode({ ...message, scheduledOutcome })).toBeNull();
  });

  it("decodes workspace summaries without allowing additive thread fields into the result", () => {
    const workspace = decodeWorkspaceChatsResponse({
      chats: [{ ...summary, messages: [message], usageStats }],
      folders: []
    });
    const mutation = decodeChatSummaryResponse({
      chat: { ...summary, messages: [message], usageStats }
    });

    expect(workspace).toEqual({
      chats: [summary],
      folders: []
    });
    expect(mutation).toEqual(summary);
    expect(mutation).not.toHaveProperty("messages");
    expect(mutation).not.toHaveProperty("usageStats");
  });

  it("carries the chat's Assistant id on summaries and rejects a malformed one", () => {
    for (const assistantId of ["assistant-1", null]) {
      const bound = { ...summary, assistantId };
      expect(decodeChatSummaryResponse({ chat: bound })).toEqual(bound);
      expect(decodeWorkspaceChatsResponse({ chats: [bound], folders: [] })?.chats)
        .toEqual([bound]);
      const archived = { ...bound, archived: true, lastMessageAt: null, memoryMode: "NORMAL", sourceRevision: 1 };
      expect(decodeArchivedChatsResponse({ chats: [archived], nextCursor: null })?.chats).toEqual([archived]);
    }
    // Stale caches without the field read as no Assistant.
    expect(decodeChatSummaryResponse({ chat: summary })).not.toHaveProperty("assistantId");
    for (const assistantId of ["", 42, { id: "assistant-1" }]) {
      expect(decodeChatSummaryResponse({ chat: { ...summary, assistantId } })).toBeNull();
    }
  });

  it("gives an imported chat a non-empty bounded title that every chat decoder accepts", () => {
    for (const blank of ["", "   ", "\t\n", " ".repeat(300)]) expect(importedChatTitle(blank)).toBe(DEFAULT_CHAT_TITLE);
    expect(importedChatTitle("  Release plan  ")).toBe("Release plan");
    expect(codePointLength(importedChatTitle(`  ${"я".repeat(200)}`))).toBe(CHAT_TITLE_MAX_LENGTH);
    expect(decodeChatSummaryResponse({ chat: { ...summary, title: importedChatTitle(" ".repeat(300)) } })?.title).toBe(DEFAULT_CHAT_TITLE);
    // An empty title fails the whole response: the reason the import never stores one.
    expect(decodeChatSummaryResponse({ chat: { ...summary, title: "" } })).toBeNull();
  });

  it("carries an imported chat's source on summaries, archived ones included, and rejects a malformed marker", () => {
    const imported = { ...summary, importSource: "CHATGPT", importSourceModel: "gpt-4o" };
    expect(decodeChatSummaryResponse({ chat: imported })).toEqual(imported);
    expect(decodeChatSummaryResponse({ chat: { ...summary, importSource: "AIQSA" } })).toEqual({ ...summary, importSource: "AIQSA" });
    const archived = { ...imported, archived: true, hasContinuationSource: true, lastMessageAt: null, memoryMode: "EXCLUDED", sourceRevision: 1 };
    expect(decodeArchivedChatsResponse({ chats: [archived], nextCursor: null })?.chats).toEqual([archived]);
    for (const marker of [{ importSource: "GEMINI" }, { importSourceModel: "orphan label" }, { importSource: "CLAUDE", importSourceModel: "" },
      { importSource: "CLAUDE", importSourceModel: "m".repeat(129) }]) {
      expect(decodeChatSummaryResponse({ chat: { ...summary, ...marker } })).toBeNull();
    }
  });

  it("keeps a paired absent chat default readable across every chat response", () => {
    expect(
      decodeWorkspaceChatsResponse({
        chats: [summary, nullDefaultSummary],
        folders: []
      })
    ).toEqual({
      chats: [summary, nullDefaultSummary],
      folders: []
    });
    expect(decodeChatSummaryResponse({ chat: nullDefaultSummary })).toEqual(
      nullDefaultSummary
    );
    expect(
      decodeChatDetailResponse({
        chat: detailChat({ ...nullDefaultSummary, messages: [message], usageStats: null })
      })
    ).toEqual(detailChat({ ...nullDefaultSummary, messages: [message], usageStats: null }));
    expect(
      decodeChatUpdateData({
        chat: { ...nullDefaultSummary, contextStats, usageStats: null },
        messages: [message]
      })
    ).toEqual({
      chat: { ...nullDefaultSummary, contextStats, usageStats: null },
      messages: [message]
    });
  });

  it("rejects incomplete or empty chat defaults", () => {
    for (const [defaultModelId, defaultProvider] of [
      ["", ""],
      [null, "openai"],
      ["gpt-5.5", null],
      ["", "openai"],
      ["gpt-5.5", ""],
      ["", null],
      [null, ""]
    ]) {
      expect(
        decodeChatSummaryResponse({
          chat: { ...summary, defaultModelId, defaultProvider }
        })
      ).toBeNull();
    }
  });

  it("decodes bounded chat/folder Knowledge defaults and rejects malformed persisted plans", () => {
    const knowledgePlan = { baseIds: ["base-a", "base-b"] };
    const canonicalKnowledgePlan = {
      baseIds: ["base-a", "base-b"], mode: "explicit", sourceIds: [], version: 1
    };
    const folder = {
      defaultKnowledgePlan: knowledgePlan,
      id: "folder-1",
      name: "Research",
      parentId: null,
      projectMemory: "",
      sortOrder: 0
    };
    expect(decodeWorkspaceChatsResponse({
      chats: [{ ...summary, defaultKnowledgePlan: knowledgePlan }],
      folders: [folder]
    })).toEqual({
      chats: [{ ...summary, defaultKnowledgePlan: canonicalKnowledgePlan }],
      folders: [{ ...folder, defaultKnowledgePlan: canonicalKnowledgePlan }]
    });
    expect(decodeWorkspaceChatsResponse({
      chats: [{ ...summary, defaultKnowledgePlan: { baseIds: ["same", "same"] } }],
      folders: []
    })).toBeNull();
    expect(decodeWorkspaceChatsResponse({
      chats: [summary],
      folders: [{
        ...folder,
        defaultKnowledgePlan: {
          baseIds: Array.from({ length: 129 }, (_, index) => `base-${index}`)
        }
      }]
    })).toBeNull();
  });

  it("rejects missing or malformed required summary fields", () => {
    for (const malformed of [
      { ...summary, activeLeafMessageId: undefined },
      { ...summary, defaultModelId: undefined },
      { ...summary, defaultProvider: undefined },
      { ...summary, folderId: undefined },
      { ...summary, messageCount: -1 },
      { ...summary, messageCount: 0.5 },
      { ...summary, pinned: undefined }
    ]) {
      expect(decodeChatSummaryResponse({ chat: malformed })).toBeNull();
    }
    expect(
      decodeWorkspaceChatsResponse({ chats: [summary] })
    ).toBeNull();
  });

  it("decodes only direct answer outputs and strips retired receipt fields", () => {
    const artifactSummary = {
      citationCount: 3,
      citations: [{
        index: 1,
        privateRoute: "route-secret",
        title: "Direct citation",
        url: "https://example.com/citation"
      }],
      contextTruncation: { approxDroppedTokens: 100, droppedMessages: 2 },
      knowledgeCitations: [{
        baseName: "Policies",
        documentVersionNumber: 3,
        fileName: "handbook.pdf",
        handle: "K1.1",
        knowledgeBaseId: "private-base-id",
        page: 12
      }],
      knowledgeState: {
        answer: "insufficient_evidence",
        privateReason: "private-retrieval-diagnostic",
        scope: "partial_sources_ready"
      },
      knowledgeInvocationCount: 1,
      knowledgeOutcomes: [{ invocationOrdinal: 1, outcome: "complete" }],
      memoryReceipt: { itemCount: 1, summary: "private receipt" },
      reasoningCount: 1,
      reasoningText: ["Checked reasoning"],
      searchActivity: [{ query: "private generated query" }],
      searchCount: 1,
      searchStrategy: "private-route",
      sources: [{
        rank: 1,
        snippet: "Safe summary",
        title: "Evidence",
        url: "https://example.com/evidence"
      }],
      toolCallCount: 1,
      toolCalls: [{ argumentsPreview: { secret: true } }]
    };
    const decoded = decodeChatDetailResponse({
      chat: {
        ...detailChat(),
        messages: [{
          ...message,
          evidenceSummary: { sourceCount: 99 },
          artifactSummary,
          runUsage: { totalTokens: 99 }
        }],
        usageStats
      }
    })?.messages[0];

    expect(decoded).not.toHaveProperty("evidenceSummary");
    expect(decoded).not.toHaveProperty("runUsage");
    expect(decoded?.artifactSummary).toEqual({
      citations: [{
        index: 1,
        title: "Direct citation",
        url: "https://example.com/citation"
      }],
      knowledgeCitations: [{
        handle: "K1.1"
      }],
      knowledgeState: {
        answer: "insufficient_evidence",
        scope: "partial_sources_ready"
      },
      reasoningText: ["Checked reasoning"],
      sources: [{
        rank: 1,
        snippet: "Safe summary",
        title: "Evidence",
        url: "https://example.com/evidence"
      }]
    });
    expect(JSON.stringify(decoded)).not.toMatch(
      /private-base-id|private generated query|private-route|receipt|toolCall|contextTruncation|handbook\.pdf|Policies/
    );
  });

  it("drops malformed direct output fields and duplicate Knowledge handles one by one", () => {
    const artifactSummary = {
      citations: [],
      knowledgeCitations: [{
        baseName: "Policies",
        fileName: "handbook.pdf",
        handle: "K1.1",
        page: 12
      }],
      reasoningText: [],
      sources: []
    };
    const decode = (value: unknown) => decodeChatDetailResponse({
      chat: detailChat({
        messages: [{ ...message, artifactSummary: value }],
        usageStats
      })
    })?.messages[0]?.artifactSummary;

    expect(decode(artifactSummary)).toEqual({ ...artifactSummary, knowledgeCitations: [{ handle: "K1.1" }] });
    expect(decode({ ...artifactSummary, reasoningText: "not-an-array" })?.reasoningText).toEqual([]);
    expect(decode({
      ...artifactSummary,
      sources: [
        { rank: 1, title: "Unsafe", url: "javascript:alert(1)" },
        { rank: 2, title: "Safe", url: "https://example.com/safe" }
      ]
    })?.sources).toEqual([{ rank: 2, title: "Safe", url: "https://example.com/safe" }]);
    expect(decode({
      ...artifactSummary,
      knowledgeCitations: [
        artifactSummary.knowledgeCitations[0],
        artifactSummary.knowledgeCitations[0]
      ]
    })?.knowledgeCitations).toEqual([{ handle: "K1.1" }]);
  });

  it("never lets an optional answer output invalidate its message, page or terminal update", () => {
    const rootMessage = { ...message, id: "message-root", modelRunId: null };
    const answer = (artifactSummary: unknown) => ({ ...message, artifactSummary, id: "message-answer", parentMessageId: rootMessage.id });
    const citation = (index: number) => ({ index: 1, title: `Cited ${index}`, url: `https://example.com/${index}` });
    const corrupted = [
      "not-an-object",
      { citations: "none", reasoningText: [7, " ", "Kept"], sources: null },
      { citations: [citation(1), { index: 1, title: "Long link", url: `https://example.com/${"u".repeat(2_049)}` }],
        reasoningText: [], sources: [] },
      { citations: [], contextCompaction: { state: "unknown" }, memoryStatus: "NEWER_STATUS", reasoningText: [], sources: [],
        generatedImages: [{ attachmentId: "" }], generatedArtifacts: "none", memorySources: [{ memoryRef: "" }],
        memoryAction: { targetId: "private" }, knowledgeState: { answer: "unknown" }, workDurationMs: -1,
        groundingDisplay: { provider: "other" }, skillCatalogOmittedCount: 1.5 }
    ];
    for (const artifactSummary of corrupted) {
      const page = decodeChatMessagesPageResponse({
        messages: [rootMessage, answer(artifactSummary)],
        pageInfo: { activeLeafMessageId: "message-answer", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: summary.updatedAt }
      });
      expect(page?.messages.map(({ id }) => id)).toEqual(["message-root", "message-answer"]);
      expect(JSON.stringify(page)).not.toMatch(/private|NEWER_STATUS|u{2049}/u);
      expect(decodeChatUpdateData({ chat: { ...summary, contextStats, usageStats }, messages: [answer(artifactSummary)] })
        ?.messages).toHaveLength(1);
    }
    const decoded = (value: unknown) => decodeChatMessagesPageResponse({
      messages: [rootMessage, answer(value)],
      pageInfo: { activeLeafMessageId: "message-answer", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: summary.updatedAt }
    })?.messages[1]?.artifactSummary;
    expect(decoded("not-an-object")).toBeNull();
    expect(decoded(corrupted[1])).toEqual({ citations: [], reasoningText: ["Kept"], sources: [] });
    expect(decoded(corrupted[2])?.citations).toEqual([citation(1)]);
    expect(decoded(corrupted[3])).toEqual({ citations: [], generatedImages: [], memorySources: [],
      reasoningText: [], sources: [] });
    // Mandatory message fields still fail closed.
    expect(decodeChatMessagesPageResponse({
      messages: [rootMessage, { ...answer(null), role: "system" }],
      pageInfo: { activeLeafMessageId: "message-answer", beforeCursor: null, hasOlder: false, snapshotUpdatedAt: summary.updatedAt }
    })).toBeNull();
  });

  it("bounds reader portions and keeps their completeness marks", () => {
    const decode = (value: unknown) => decodeChatDetailResponse({
      chat: detailChat({ messages: [{ ...message, artifactSummary: value }], usageStats })
    })?.messages[0]?.artifactSummary;
    const citations = Array.from({ length: THREAD_CITATION_MAX_ITEMS + 1 }, (_, index) => ({
      index: 1, title: `Cited ${index}`, url: `https://example.com/${index}`
    }));
    const sources = Array.from({ length: THREAD_SEARCH_SOURCE_MAX_ITEMS + 1 }, (_, index) => ({
      rank: index + 1, title: `Result ${index}`, url: `https://example.org/${index}`
    }));
    const entries = Array.from({ length: THREAD_REASONING_MAX_ENTRIES + 2 }, (_, index) => `Entry ${index}`);
    const bounded = decode({ citations, reasoningText: entries, sources });
    expect(bounded?.citations).toHaveLength(THREAD_CITATION_MAX_ITEMS);
    expect(bounded?.sources).toHaveLength(THREAD_SEARCH_SOURCE_MAX_ITEMS);
    expect(bounded).toMatchObject({ citationsTruncated: true, sourcesTruncated: true });
    expect(bounded?.reasoningText).toHaveLength(THREAD_REASONING_MAX_ENTRIES);
    expect(bounded?.reasoningText.join("\n\n")).toBe(entries.join("\n\n"));
    expect(bounded).not.toHaveProperty("reasoningTruncated");
    const long = decode({ citations: [], reasoningText: [`${"x".repeat(THREAD_REASONING_MAX_CHARACTERS - 1)}😀`], sources: [] });
    expect(long).toMatchObject({ reasoningText: ["x".repeat(THREAD_REASONING_MAX_CHARACTERS - 1)], reasoningTruncated: true });
    expect(decode({ citations: [], reasoningText: ["Short"], reasoningTruncated: true, sources: [] }))
      .toMatchObject({ reasoningText: ["Short"], reasoningTruncated: true });
    expect(decode({ citations: [], reasoningText: [], reasoningTruncated: "yes", sources: [] }))
      .not.toHaveProperty("reasoningTruncated");
  });

  it("round-trips the snapshot-bound assistant identity and fails closed on malformed identities", () => {
    const assistantIdentity = {
      avatar: {
        accents: [0, 1, 2, 3],
        backgroundShape: "circle",
        foregroundShape: "diamond",
        kind: "generated",
        paletteId: "ocean",
        recipeVersion: 1,
        rotations: [0, 2]
      },
      name: "Docs helper",
    };

    expect(
      decodeChatDetailResponse({
        chat: {
          ...detailChat(),
          messages: [{ ...message, assistantIdentity }],
          usageStats: null
        }
      })?.messages[0]?.assistantIdentity
    ).toEqual(assistantIdentity);
    expect(
      decodeChatDetailResponse({
        chat: {
          ...detailChat(),
          messages: [{ ...message, assistantIdentity: null }],
          usageStats: null
        }
      })?.messages[0]?.assistantIdentity
    ).toBeNull();
    for (const malformedIdentity of [
      { ...assistantIdentity, name: "" },
      { ...assistantIdentity, name: "a".repeat(81) },
      { ...assistantIdentity, avatar: { kind: "uploaded" } }
    ]) {
      expect(
        decodeChatDetailResponse({
          chat: {
            ...detailChat(),
            messages: [{ ...message, assistantIdentity: malformedIdentity }],
            usageStats: null
          }
        })
      ).toBeNull();
    }
  });

  it("decodes terminal updates only when both owners are complete", () => {
    expect(
      decodeChatUpdateData({
        chat: { ...summary, contextStats, usageStats },
        messages: [message]
      })
    ).toEqual({
      chat: { ...summary, contextStats, usageStats },
      messages: [message]
    });
    expect(
      decodeChatUpdateData({ chat: { ...summary, contextStats, usageStats }, messages: {} })
    ).toBeNull();
    expect(
      decodeChatUpdateData({ chat: summary, messages: [message] })
    ).toBeNull();
  });

  it("exact-decodes snapshot-bound forward message pages and enforces the fixed cap", () => {
    const rootMessage = { ...message, id: "message-root", modelRunId: null };
    const childMessage = {
      ...message,
      id: "message-child",
      parentMessageId: rootMessage.id
    };
    const value = {
      messages: [rootMessage, childMessage],
      pageInfo: {
        activeLeafMessageId: "message-leaf",
        beforeCursor: null,
        hasOlder: false,
        snapshotUpdatedAt: summary.updatedAt
      }
    };
    expect(decodeChatMessagesPageResponse(value)).toEqual(value);
    expect(decodeChatMessagesPageResponse({ ...value, extra: true })).toBeNull();
    expect(decodeChatMessagesPageResponse({
      ...value,
      messages: [childMessage, rootMessage]
    })).toBeNull();
    expect(decodeChatMessagesPageResponse({
      ...value,
      messages: Array.from({ length: CHAT_HISTORY_PAGE_SIZE + 1 }, (_, index) => ({
        ...message,
        id: `message-${index}`,
        parentMessageId: index === 0 ? null : `message-${index - 1}`
      }))
    })).toBeNull();
    expect(decodeChatMessagesPageResponse({
      ...value,
      pageInfo: { ...value.pageInfo, unknown: true }
    })).toBeNull();
  });

  it("exact-decodes a bounded-plaintext full branch graph and rejects broken DAGs", () => {
    const value = {
      branchGraph: {
        activeLeafMessageId: "assistant-a",
        nodes: [
          {
            id: "user-root",
            parentMessageId: null,
            preview: "Question",
            role: "user" as const,
            status: "complete" as const
          },
          {
            id: "assistant-a",
            parentMessageId: "user-root",
            preview: "Answer A",
            role: "assistant" as const,
            status: "complete" as const
          },
          {
            id: "assistant-b",
            parentMessageId: "user-root",
            preview: "Answer B",
            role: "assistant" as const,
            status: "error" as const
          }
        ],
        snapshotUpdatedAt: summary.updatedAt
      }
    };
    expect(decodeChatBranchesResponse(value)).toEqual(value);
    expect(decodeChatBranchesResponse({ ...value, extra: true })).toBeNull();
    expect(decodeChatBranchesResponse({
      branchGraph: {
        ...value.branchGraph,
        nodes: [{
          ...value.branchGraph.nodes[0],
          preview: "x".repeat(CHAT_BRANCH_PREVIEW_MAX_LENGTH + 1)
        }]
      }
    })).toBeNull();
    expect(decodeChatBranchesResponse({
      branchGraph: {
        ...value.branchGraph,
        nodes: [
          { ...value.branchGraph.nodes[0], parentMessageId: "assistant-a" },
          value.branchGraph.nodes[1]
        ]
      }
    })).toBeNull();
  });

  it("bounds server-composed chat titles by code points without splitting a surrogate pair", () => {
    const fits = `Continued: ${"😀".repeat(CHAT_TITLE_MAX_LENGTH - 11)}`;
    expect(boundedChatTitle(fits)).toBe(fits);
    expect(boundedChatTitle(`${fits}😀tail`)).toBe(fits);
  });

  it("bounds branch previews by UTF-16 units without splitting a surrogate pair", () => {
    const preview = boundedChatBranchPreview(
      `${"x".repeat(CHAT_BRANCH_PREVIEW_MAX_LENGTH - 1)}😀trailing`
    );

    expect(preview).toBe("x".repeat(CHAT_BRANCH_PREVIEW_MAX_LENGTH - 1));
    expect(preview.length).toBeLessThanOrEqual(CHAT_BRANCH_PREVIEW_MAX_LENGTH);
    expect(preview.charCodeAt(preview.length - 1)).not.toBeGreaterThanOrEqual(0xd800);
  });

  it.each([18, MEMORY_ANSWER_SOURCE_MAX_ITEMS])(
    "preserves a completed Workspace answer with %i Memory sources when reloading",
    (sourceCount) => {
      const memorySources = Array.from({ length: sourceCount }, (_, index) => ({
        actions: ["CORRECT", "FORGET", "NOT_RELEVANT", "OPEN_SOURCE"],
        date: summary.createdAt,
        memoryRef: `opaque-memory-${index}`,
        origin: "Earlier planning chat",
        sourceAvailable: true,
        chatGroup: "chat-1",
        sourceType: "PAST_CHAT",
        text: `Planning note ${index + 1}`
      }));
      const generatedFiles = [{
        attachmentId: "generated-document",
        byteSize: 9323,
        fileName: "application.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        relativePath: "application.docx"
      }];
      const artifactSummary = {
        citations: [], generatedFiles, memorySources, reasoningText: [], sources: []
      };
      const decode = (sources: unknown) => decodeChatDetailResponse({
        chat: detailChat({
          messages: [{ ...message, artifactSummary: { ...artifactSummary, memorySources: sources } }],
          usageStats
        })
      });

      expect(decode(memorySources)?.messages[0]).toMatchObject({
        artifactSummary: { generatedFiles, memorySources },
        content: message.content,
        status: "complete"
      });
      expect(decode([...memorySources, { ...memorySources[0], memoryRef: "" }])?.messages[0]?.artifactSummary)
        .toMatchObject({ generatedFiles, memorySources });
      expect(decode(Array.from(
        { length: MEMORY_ANSWER_SOURCE_MAX_ITEMS + 1 },
        () => memorySources[0]
      ))?.messages[0]?.artifactSummary?.memorySources).toHaveLength(MEMORY_ANSWER_SOURCE_MAX_ITEMS);
    }
  );

  it("keeps committed Memory action feedback and strips retrieval receipts", () => {
    const artifactSummary = {
      citations: [],
      memoryAction: {
        memoryRef: "opaque-memory-ref",
        operation: "UPDATE",
        statement: "I prefer concise answers.",
        status: "COMMITTED"
      },
      memoryReceipt: {
        itemCount: 1,
        items: [{ includedText: "private retrieved content" }],
        outcome: "USED"
      },
      reasoningText: [],
      sources: []
    };
    const decode = (value: unknown) => decodeChatDetailResponse({
      chat: detailChat({
        messages: [{ ...message, artifactSummary: value }],
        usageStats
      })
    });

    expect(decode(artifactSummary)?.messages[0]?.artifactSummary).toEqual({
      citations: [],
      memoryAction: {
        memoryRef: "opaque-memory-ref",
        operation: "UPDATE",
        statement: "I prefer concise answers.",
        status: "COMMITTED"
      },
      reasoningText: [],
      sources: []
    });
    expect(decode({
      citations: [],
      memoryStatus: "UNAVAILABLE",
      reasoningText: [],
      sources: []
    })?.messages[0]?.artifactSummary).toEqual({
      citations: [],
      memoryStatus: "UNAVAILABLE",
      reasoningText: [],
      sources: []
    });
    expect(decode({
      citations: [],
      memoryStatus: "LIMITED",
      reasoningText: [],
      sources: []
    })?.messages[0]?.artifactSummary).toEqual({
      citations: [],
      memoryStatus: "LIMITED",
      reasoningText: [],
      sources: []
    });
    expect(decode({
      citations: [],
      memoryStatus: "INPUT_TOO_LONG",
      reasoningText: [],
      sources: []
    })?.messages[0]?.artifactSummary).toEqual({
      citations: [],
      memoryStatus: "INPUT_TOO_LONG",
      reasoningText: [],
      sources: []
    });
    // An unknown (newer) status or a feedback carrying a private field is left
    // out; the answer and its page stay readable.
    expect(decode({
      citations: [],
      memoryStatus: "FAILED_SAFE",
      reasoningText: [],
      sources: []
    })?.messages[0]?.artifactSummary).toEqual({ citations: [], reasoningText: [], sources: [] });
    const withPrivateField = decode({
      ...artifactSummary,
      memoryAction: { ...artifactSummary.memoryAction, targetId: "private" }
    })?.messages[0]?.artifactSummary;
    expect(withPrivateField).toEqual({ citations: [], reasoningText: [], sources: [] });
    expect(JSON.stringify(withPrivateField)).not.toContain("private");
  });

  it("strictly decodes distinct lifecycle, Archived, and source-resolution wires", () => {
    const lifecycle = {
      chat: {
        archived: true,
        id: summary.id,
        memoryMode: "NORMAL",
        sourceRevision: 7,
        updatedAt: summary.updatedAt
      }
    };
    const archivedSummary = {
      ...summary,
      archived: true,
      lastMessageAt: summary.updatedAt,
      memoryMode: "EXCLUDED",
      sourceRevision: 8
    };
    const archivedDetail = {
      chat: {
        ...detailChat(),
        archived: true,
        memoryMode: "NORMAL",
        messages: [message],
        sourceRevision: 7,
        usageStats
      }
    };
    const source = {
      source: {
        chatId: summary.id,
        location: "ARCHIVED_PREVIEW",
        memoryMode: "NORMAL",
        sourceRevision: 7,
        updatedAt: summary.updatedAt
      }
    };

    expect(decodeChatLifecycleRequest({ expectedChatRevision: 7 })).toEqual({
      expectedChatRevision: 7
    });
    expect(decodeChatLifecycleRequest({ expectedChatRevision: 7, erase: true })).toBeNull();
    expect(decodeChatLifecycleResponse(lifecycle)).toEqual(lifecycle);
    expect(decodeArchivedChatsResponse({ chats: [archivedSummary], nextCursor: "opaque" }))
      .toEqual({ chats: [archivedSummary], nextCursor: "opaque" });
    expect(decodeArchivedChatDetailResponse(archivedDetail)).toEqual(archivedDetail);
    expect(decodeChatSourceResolutionResponse(source)).toEqual(source);
    expect(decodeChatMemoryStateResponse({
      chat: {
        archived: false,
        chatId: summary.id,
        mode: "TEMPORARY",
        sourceRevision: 8,
        temporaryRetentionDeadline: "2026-07-15T08:01:00.000Z",
        temporaryRetentionPolicyVersion: "temporary-24h-v1",
        updatedAt: summary.updatedAt
      }
    })).not.toBeNull();
    expect(decodeChatMemoryStateResponse({
      chat: {
        archived: false,
        chatId: summary.id,
        mode: "TEMPORARY",
        sourceRevision: 8,
        temporaryRetentionDeadline: null,
        temporaryRetentionPolicyVersion: "temporary-24h-v1",
        updatedAt: summary.updatedAt
      }
    })).toBeNull();

    expect(decodeChatLifecycleResponse({
      chat: { ...lifecycle.chat, memoryMode: "TEMPORARY" }
    })).toBeNull();
    expect(decodeArchivedChatsResponse({
      chats: [{ ...archivedSummary, archived: false }],
      nextCursor: null
    })).toBeNull();
    expect(decodeArchivedChatsResponse({
      chats: [{ ...archivedSummary, lastMessageAt: "not-a-timestamp" }],
      nextCursor: null
    })).toBeNull();
    expect(decodeChatSourceResolutionResponse({
      source: { ...source.source, location: "MISSING" }
    })).toBeNull();
  });

});


it("reloads failed answers with same-name immutable checkpoints and retains separate final export", () => {
  const files = Array.from({ length: 128 }, (_, index) => ({
    attachmentId: `draft-${index}`, byteSize: 7, fileName: "result.psd", mimeType: "application/octet-stream", relativePath: "result.psd",
    checkpoint: { id: `cp-${Math.floor(index / 8)}`, description: "Useful intermediate result", createdAt: "2026-09-24T09:00:00.000Z" }
  }));
  const final = { attachmentId: "final", byteSize: 7, fileName: "result.psd", mimeType: "application/octet-stream", relativePath: "result.psd" };
  const decode = (generatedFiles: unknown[]) => decodeChatDetailResponse({ chat: detailChat({
    messages: [{ ...message, status: "error", artifactSummary: { citations: [], reasoningText: [], sources: [], generatedFiles } }], usageStats
  }) });
  expect(decode([...files, final])?.messages[0]).toMatchObject({ status: "error", artifactSummary: { generatedFiles: [...files, final] } });
  // A file that would break the Workspace list rules is dropped on its own;
  // the answer and every other download stay.
  const kept = (generatedFiles: unknown[]) => decode(generatedFiles)?.messages[0]?.artifactSummary?.generatedFiles;
  expect(kept([files[0], files[0]])).toEqual([files[0]]);
  expect(kept([final, { ...final, attachmentId: "another-final" }])).toEqual([final]);
  expect(kept([...files, { ...files[0], attachmentId: "excess", checkpoint: { ...files[0]!.checkpoint, id: "cp-17" } }]))
    .toEqual(files);
});

const assistantAvatar = { accents: [1], backgroundShape: "circle", foregroundShape: "ring", kind: "generated",
  paletteId: "ember", recipeVersion: 1, rotations: [0, 0] };

function chatRow(overrides: Record<string, unknown> = {}) {
  return {
    assistantValue: { mode: "model", modelId: "model-1" },
    deviation: null,
    policy: "adjustable",
    provenance: "assistant",
    value: { mode: "model", modelId: "model-1" },
    ...overrides
  };
}

function boundProjection(rowOverrides: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return {
    availability: { ok: true },
    avatar: assistantAvatar,
    id: "assistant-1",
    name: "Analyst",
    owned: false,
    ownerDisplayName: "Alex",
    rows: {
      controls: chatRow({ assistantValue: {}, provenance: "default", value: { temperature: 0.4 } }),
      knowledge: chatRow({ assistantValue: { mode: "inherit" }, provenance: "default", value: { mode: "all_my_knowledge" } }),
      model: chatRow(),
      search: chatRow({ assistantValue: { hiddenCount: 1, mode: "all_selected", optionIds: [] }, provenance: "chat", value: { mode: "off" } }),
      skills: chatRow({ assistantValue: { links: [], mode: "auto" }, policy: "fixed", value: { links: [], mode: "auto" } }),
      tools: chatRow({ assistantValue: { mode: "exact", serverIds: ["jira"] }, deviation: { reason: "tools_access" },
        provenance: "fallback", value: { mode: "auto" } }),
      ...rowOverrides
    },
    state: "bound",
    ...overrides
  };
}

describe("chat Assistant projection", () => {
  it("decodes a bound Assistant with per-row provenance, the deleted and the unavailable state", () => {
    expect(decodeChatAssistantProjection(boundProjection())).toEqual(boundProjection());
    expect(decodeChatAssistantProjection({ state: "deleted" })).toEqual({ state: "deleted" });
    expect(decodeChatAssistantProjection({ state: "unavailable" })).toEqual({ state: "unavailable" });
    expect(decodeChatAssistantProjection({ name: "Analyst", state: "deleted" })).toBeNull();
    expect(decodeChatAssistantProjection({ id: "assistant-1", state: "unavailable" })).toBeNull();
    // A consumer learns that its owner archived the Assistant, and nothing else.
    expect(decodeChatAssistantProjection({ reason: "archived", state: "unavailable" }))
      .toEqual({ reason: "archived", state: "unavailable" });
    expect(decodeChatAssistantProjection({ reason: "tools_access", state: "unavailable" })).toBeNull();
    expect(decodeChatAssistantProjection({ name: "Analyst", reason: "archived", state: "unavailable" })).toBeNull();
    expect(decodeChatAssistantProjection({ reason: "archived", state: "deleted" })).toBeNull();
    expect(decodeChatDetailResponse({ chat: detailChat({ assistant: boundProjection(), messages: [message], usageStats }) })
      ?.assistant).toEqual(boundProjection());
    expect(decodeChatDetailResponse({ chat: detailChat({ assistant: { state: "detached" }, messages: [message], usageStats }) }))
      .toBeNull();
  });

  it("rejects provenance a row policy cannot produce and values that leak or inherit", () => {
    const invalid: Array<Record<string, unknown>> = [
      { model: chatRow({ policy: "fixed", provenance: "chat" }) },
      { model: chatRow({ policy: "fixed", provenance: "fallback", deviation: { reason: "model_access" } }) },
      { model: chatRow({ provenance: "fallback" }) },
      { model: chatRow({ deviation: { reason: "model_access" } }) },
      { model: chatRow({ provenance: "default" }) },
      { model: chatRow({ assistantValue: { mode: "inherit" } }) },
      { model: chatRow({ value: { mode: "inherit" } }) },
      { model: chatRow({ deviation: { dependencies: [{ kind: "model", name: "Private" }], reason: "model_access" },
        provenance: "fallback" }) },
      { controls: chatRow({ assistantValue: {}, deviation: { reason: "model_access" }, provenance: "fallback", value: {} }) },
      { tools: chatRow({ assistantValue: { mode: "exact", serverIds: ["jira"] }, value: { mode: "load_all", serverIds: [] } }) },
      { model: { ...chatRow(), extra: true } }
    ];
    for (const rows of invalid) {
      expect(decodeChatAssistantProjection(boundProjection(rows)), JSON.stringify(rows)).toBeNull();
    }
    expect(decodeChatAssistantProjection(boundProjection({}, { availability: { dependencies: [{ kind: "mcp", name: "Jira" }],
      ok: false, reason: "tools_access" } }))).toBeNull();
    expect(decodeChatAssistantProjection(boundProjection({
      model: chatRow({ deviation: { dependencies: [{ kind: "model", name: "Gemini" }], reason: "model_access" },
        provenance: "fallback", value: { mode: "model", modelId: "model-2" } })
    }, { owned: true }))).not.toBeNull();
    const { skills: _skills, ...fiveRows } = boundProjection().rows;
    expect(decodeChatAssistantProjection({ ...boundProjection(), rows: fiveRows })).toBeNull();
  });

  it("keeps an archived preview free of Assistant state", () => {
    const archived = {
      chat: { ...detailChat({ messages: [message], usageStats }), archived: true, memoryMode: "NORMAL", sourceRevision: 7 }
    };
    expect(decodeArchivedChatDetailResponse(archived)?.chat.assistant).toBeNull();
    expect(decodeArchivedChatDetailResponse({ chat: { ...archived.chat, assistant: { state: "deleted" } } })).toBeNull();
  });
});

describe("chat Assistant overrides", () => {
  const overrides = {
    controls: { temperature: 0.2 },
    knowledge: { mode: "all_my_knowledge" },
    model: { mode: "model", modelId: "model-2" },
    search: { mode: "off" },
    skills: { mode: "off" },
    tools: { mode: "load_all" }
  };

  it("decodes stored overrides, the deleted marker and an empty column", () => {
    expect(decodeStoredChatAssistantOverrides(null)).toEqual({ kind: "overrides", overrides: {} });
    expect(decodeStoredChatAssistantOverrides(overrides)).toEqual({ kind: "overrides", overrides });
    expect(decodeStoredChatAssistantOverrides({ search: { mode: "all_selected", optionIds: ["web"] } }))
      .toEqual({ kind: "overrides", overrides: { search: { mode: "all_selected", optionIds: ["web"] } } });
    expect(decodeStoredChatAssistantOverrides(JSON.parse(JSON.stringify(CHAT_ASSISTANT_DELETED_MARKER))))
      .toEqual({ kind: "deleted" });
    for (const invalid of [
      { assistantDeleted: true, search: { mode: "off" } },
      { assistantDeleted: false },
      { search: null },
      { search: { mode: "inherit" } },
      { model: { mode: "model", modelId: null } },
      { tools: { mode: "exact", serverIds: ["jira"] } },
      { knowledge: { mode: "inherit" } },
      { skills: { links: [], mode: "auto" } },
      { prompt: "x" },
      ["search"]
    ]) {
      expect(decodeStoredChatAssistantOverrides(invalid), JSON.stringify(invalid)).toBeNull();
    }
    expect(storedChatAssistantOverrides({})).toBeNull();
    expect(storedChatAssistantOverrides({ search: { mode: "off" } })).toEqual({ search: { mode: "off" } });
  });

  it("decodes the chat update fields and applies a patch in which null clears a row", () => {
    expect(decodeChatAssistantUpdate({ title: "ignored" })).toEqual({ ok: true, update: {} });
    expect(decodeChatAssistantUpdate({ assistantId: null })).toEqual({ ok: true, update: { assistantId: null } });
    expect(decodeChatAssistantUpdate({ assistantId: "assistant-1", assistantOverrides: { model: null, search: { mode: "off" } } }))
      .toEqual({ ok: true, update: { assistantId: "assistant-1", assistantOverrides: { model: null, search: { mode: "off" } } } });
    for (const assistantId of ["", 7, "a b", "x".repeat(257)]) {
      expect(decodeChatAssistantUpdate({ assistantId })).toEqual({ code: "assistant_not_available", ok: false });
    }
    expect(decodeChatAssistantUpdate({ assistantOverrides: { search: { mode: "inherit" } } }))
      .toEqual({ code: "assistant_overrides_invalid", ok: false, row: "search" });
    expect(decodeChatAssistantUpdate({ assistantOverrides: { prompt: "x" } }))
      .toEqual({ code: "assistant_overrides_invalid", ok: false });
    expect(decodeChatAssistantUpdate({ assistantOverrides: null }))
      .toEqual({ code: "assistant_overrides_invalid", ok: false });

    expect(applyChatAssistantOverridesPatch(
      { model: { mode: "model", modelId: "model-2" }, search: { mode: "off" } },
      { model: null, tools: { mode: "off" } }
    )).toEqual({ search: { mode: "off" }, tools: { mode: "off" } });
  });
});
