import { describe, expect, it } from "vitest";
import { decodeChatExportDocument } from "../contracts/chatExport";
import {
  chatExportActiveBranchMarkdown,
  chatExportAttachmentIds,
  chatExportDocument,
  chatExportDocumentChat,
  type ChatExportSource,
  type ChatExportSourceMessage
} from "./chatExportDocument";

const at = (minute: number) => new Date(Date.UTC(2026, 8, 1, 12, minute));
const text = (value: string) => ({ blocks: [{ text: value, type: "text" }] });

function message(input: Partial<ChatExportSourceMessage> & Pick<ChatExportSourceMessage, "key">): ChatExportSourceMessage {
  return {
    content: text(input.key),
    createdAt: at(0),
    modelId: null,
    parentKey: null,
    provider: null,
    role: "user",
    status: "complete",
    ...input
  };
}

const followup = {
  author: "Owner Name",
  createdAt: at(4).toISOString(),
  delivery: "delivered",
  id: "followup-db-id",
  ordinal: 1,
  precedingText: "Partial draft",
  text: "Also cover rollback"
} as const;

/** An edited first message (two roots) and a regenerated answer with a follow-up. */
function branchedSource(activeLeafKey = "db-answer-regenerated"): ChatExportSource {
  return {
    attachments: new Map([["db-attachment", { byteSize: 2048, mimeType: "image/png", name: "plan.png" }]]),
    chat: {
      activeLeafKey,
      archived: false,
      createdAt: at(0),
      pinned: true,
      title: "Release plan",
      updatedAt: at(9)
    },
    messages: [
      // Deliberately unordered: the serializer owns the order.
      message({ content: text("Plan the release (edited)"), createdAt: at(6), key: "db-question-edited" }),
      message({
        content: { blocks: [{ text: "Here is the edited plan", type: "text" }, { input: { secret: "tool" }, name: "search", type: "tool_use" }] },
        createdAt: at(7),
        key: "db-answer-edited",
        modelId: "model-b",
        parentKey: "db-question-edited",
        provider: "provider-b",
        role: "assistant"
      }),
      message({
        createdAt: at(3),
        followups: { available: false, entries: [followup] },
        content: text("Final plan with rollback"),
        key: "db-answer-regenerated",
        modelId: "model-a",
        parentKey: "db-question",
        provider: "provider-a",
        role: "assistant"
      }),
      message({
        content: { blocks: [{ text: "Plan the release", type: "text" }, { attachmentId: "db-attachment", type: "image" },
          { attachmentId: "db-attachment-removed", fileName: "notes.txt", type: "file" }] },
        createdAt: at(1),
        key: "db-question"
      }),
      message({
        content: text("First plan"),
        createdAt: at(2),
        key: "db-answer-first",
        modelId: "model-a",
        parentKey: "db-question",
        provider: "provider-a",
        role: "assistant",
        status: "cancelled"
      })
    ]
  };
}

describe("aiqsa.chat v1 serializer", () => {
  it("exports every branch and both roots parent-first with export-local ids and flattened follow-ups", () => {
    const chat = chatExportDocumentChat(branchedSource());
    expect(chat).toEqual({
      activeLeafId: "m5",
      archived: false,
      createdAt: "2026-09-01T12:00:00.000Z",
      messages: [
        {
          attachments: [{ byteSize: 2048, mimeType: "image/png", name: "plan.png" }, { name: "notes.txt" }],
          createdAt: "2026-09-01T12:01:00.000Z", id: "m1", parentId: null, role: "user", status: "complete", text: "Plan the release"
        },
        {
          createdAt: "2026-09-01T12:02:00.000Z", id: "m2", model: { modelId: "model-a", provider: "provider-a" },
          parentId: "m1", role: "assistant", status: "cancelled", text: "First plan"
        },
        {
          createdAt: "2026-09-01T12:04:00.000Z", id: "m3", model: { modelId: "model-a", provider: "provider-a" },
          parentId: "m1", role: "assistant", status: "complete", text: "Partial answer before follow-up:\n\nPartial draft"
        },
        {
          createdAt: "2026-09-01T12:04:00.000Z", id: "m4", parentId: "m3", role: "user", status: "complete",
          text: "Follow-up 1:\n\nAlso cover rollback"
        },
        {
          createdAt: "2026-09-01T12:03:00.000Z", id: "m5", model: { modelId: "model-a", provider: "provider-a" },
          parentId: "m4", role: "assistant", status: "complete", text: "Final plan with rollback"
        },
        {
          createdAt: "2026-09-01T12:06:00.000Z", id: "m6", parentId: null, role: "user", status: "complete",
          text: "Plan the release (edited)"
        },
        {
          createdAt: "2026-09-01T12:07:00.000Z", id: "m7", model: { modelId: "model-b", provider: "provider-b" },
          parentId: "m6", role: "assistant", status: "complete", text: "Here is the edited plan"
        }
      ],
      pinned: true,
      title: "Release plan",
      updatedAt: "2026-09-01T12:09:00.000Z"
    });
  });

  it("selects the active leaf on another root and decodes as a valid v1 forest", () => {
    const document = chatExportDocument(branchedSource("db-answer-edited"), at(10));
    expect(document.chat.activeLeafId).toBe("m7");
    expect(document).toMatchObject({ exportedAt: "2026-09-01T12:10:00.000Z", format: "aiqsa.chat", version: 1 });
    expect(decodeChatExportDocument(JSON.parse(JSON.stringify(document)))).toEqual({ ok: true, value: document });
  });

  it("never leaks database ids, follow-up receipts, tool payloads or token fields", () => {
    const serialized = JSON.stringify(chatExportDocument(branchedSource(), at(10)));
    expect(serialized).not.toMatch(/db-|followup-db-id|Owner Name|delivery|ordinal|secret|tool_use|Tokens|attachmentId/u);
  });

  it("keeps an unreachable or missing active leaf as null and an empty chat valid", () => {
    expect(chatExportDocumentChat({ ...branchedSource(), chat: { ...branchedSource().chat, activeLeafKey: "gone" } }).activeLeafId).toBeNull();
    const empty = chatExportDocument({ attachments: new Map(), chat: { ...branchedSource().chat, activeLeafKey: null }, messages: [] }, at(10));
    expect(empty.chat.messages).toEqual([]);
    expect(decodeChatExportDocument(empty).ok).toBe(true);
  });

  it("lists attachment ids referenced by content blocks only", () => {
    expect(chatExportAttachmentIds({ blocks: [{ attachmentId: "a", type: "image" }, { attachmentId: "b", fileName: "b", type: "file" },
      { attachmentId: "c", type: "tool_result" }, { text: "x", type: "text" }] })).toEqual(["a", "b"]);
    expect(chatExportAttachmentIds("plain")).toEqual([]);
  });
});

describe("active-branch Markdown", () => {
  it("renders the visible branch with follow-ups and a stopped empty answer as the chat shows it", () => {
    expect(chatExportActiveBranchMarkdown(branchedSource())).toBe(
      "# Release plan\n\n## User\n\nPlan the release\n\n" +
      "## Assistant\n\nPartial answer before follow-up:\n\nPartial draft\n\n" +
      "## User\n\nFollow-up 1:\n\nAlso cover rollback\n\n## Assistant\n\nFinal plan with rollback\n"
    );
    const stopped = branchedSource("db-answer-first");
    expect(chatExportActiveBranchMarkdown({
      ...stopped,
      messages: stopped.messages.map((row) => row.key === "db-answer-first" ? { ...row, content: { blocks: [] } } : row)
    })).toBe("# Release plan\n\n## User\n\nPlan the release\n\n## Assistant\n\nStopped.\n");
    expect(chatExportActiveBranchMarkdown({ ...stopped, chat: { ...stopped.chat, activeLeafKey: null } })).toBe("# Release plan\n\n\n");
  });
});
