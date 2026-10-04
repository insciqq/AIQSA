import { describe, expect, it } from "vitest";
import type { ChatExportDocument, ChatExportDocumentMessage } from "./chatExport";
import {
  CHAT_IMPORT_FAILURE_CODES,
  CHAT_IMPORT_MAX_CHATS_PER_REQUEST,
  CHAT_IMPORT_MAX_MESSAGE_TEXT_LENGTH,
  CHAT_IMPORT_MAX_MESSAGES,
  chatImportDocumentFailure,
  decodeChatImportItem,
  decodeChatImportRequestItems,
  decodeChatImportResponse,
  normalizeChatImportSourceModel
} from "./chatImport";

const now = new Date("2026-10-05T12:00:00.000Z");

function message(id: string, parentId: string | null, role: "assistant" | "user", text = `Text ${id}`): ChatExportDocumentMessage {
  return { createdAt: "2026-09-01T10:00:00.000Z", id, parentId, role, status: "complete", text };
}

/** Two roots (an edited first message) and an answer with a flattened follow-up. */
function document(messages: readonly ChatExportDocumentMessage[] = [
  message("m1", null, "user"),
  message("m2", "m1", "assistant"),
  message("m3", "m2", "user"),
  message("m4", "m3", "assistant"),
  message("m5", null, "user")
], activeLeafId: string | null = "m4"): ChatExportDocument {
  return {
    chat: {
      activeLeafId,
      archived: false,
      createdAt: "2026-09-01T09:59:00.000Z",
      messages,
      pinned: false,
      title: "Synthetic import",
      updatedAt: "2026-09-02T10:00:00.000Z"
    },
    exportedAt: "2026-10-01T00:00:00.000Z",
    format: "aiqsa.chat",
    version: 1
  };
}

describe("chat import contract", () => {
  it("accepts a forest of user and assistant messages from every source", () => {
    expect(decodeChatImportItem({ document: document(), source: "AIQSA" }, now)).toEqual({
      ok: true,
      value: { document: document(), source: "AIQSA" }
    });
    expect(decodeChatImportItem({ document: document(), source: "CHATGPT", sourceKey: "conv-1", sourceModel: "gpt-4o" }, now))
      .toMatchObject({ ok: true, value: { source: "CHATGPT", sourceKey: "conv-1", sourceModel: "gpt-4o" } });
  });

  it("refuses an invalid envelope or source identity with chat_import_item_invalid", () => {
    for (const item of [
      null,
      { document: document() },
      { document: document(), source: "GEMINI" },
      { document: document(), extra: true, source: "AIQSA" },
      { document: document(), source: "AIQSA", sourceKey: "not-for-aiqsa" },
      { document: document(), source: "CLAUDE" },
      { document: document(), source: "CLAUDE", sourceKey: "" },
      { document: document(), source: "CLAUDE", sourceKey: "line\nbreak" },
      { document: document(), source: "CLAUDE", sourceKey: "k".repeat(257) },
      { document: document(), source: "CLAUDE", sourceKey: "uuid-1", sourceModel: "   " },
      { document: document(), source: "CLAUDE", sourceKey: "uuid-1", sourceModel: "m".repeat(129) }
    ]) {
      expect(decodeChatImportItem(item, now)).toEqual({ code: "chat_import_item_invalid", ok: false });
    }
  });

  it("passes every structural decoder refusal through by its code", () => {
    const base = document();
    const cases: Array<[unknown, string]> = [
      [{ ...base, format: "other" }, "chat_export_format_unsupported"],
      [{ ...base, version: 2 }, "chat_export_version_unsupported"],
      [{ ...base, chat: { ...base.chat, messages: [{ ...message("m1", null, "user"), role: "system" }] } }, "chat_export_shape_invalid"],
      [{ ...base, chat: { ...base.chat, createdAt: "yesterday" } }, "chat_export_date_invalid"],
      [{ ...base, chat: { ...base.chat, messages: [message("m1", null, "user"), message("m1", null, "user")] } }, "chat_export_message_id_duplicate"],
      [{ ...base, chat: { ...base.chat, activeLeafId: null, messages: [message("m2", "m9", "assistant")] } }, "chat_export_parent_missing"],
      [{ ...base, chat: { ...base.chat, activeLeafId: null, messages: [message("m2", "m1", "assistant"), message("m1", null, "user")] } }, "chat_export_parent_order_invalid"],
      [{ ...base, chat: { ...base.chat, activeLeafId: null, messages: [message("m1", "m2", "user"), message("m2", "m1", "assistant")] } }, "chat_export_tree_cycle"],
      [{ ...base, chat: { ...base.chat, activeLeafId: "m9" } }, "chat_export_active_leaf_missing"]
    ];
    for (const [value, code] of cases) {
      expect(decodeChatImportItem({ document: value, source: "AIQSA" }, now)).toEqual({ code, ok: false });
    }
  });

  it("enforces the import bounds beyond the decoder", () => {
    expect(chatImportDocumentFailure(document([], null), now)).toBe("chat_import_empty");
    const many = Array.from({ length: CHAT_IMPORT_MAX_MESSAGES + 1 }, (_, index) =>
      message(`m${index + 1}`, index === 0 ? null : `m${index}`, index % 2 ? "assistant" : "user", "x"));
    expect(chatImportDocumentFailure(document(many, null), now)).toBe("chat_import_too_many_messages");
    const long = [message("m1", null, "user", "y".repeat(CHAT_IMPORT_MAX_MESSAGE_TEXT_LENGTH + 1))];
    expect(chatImportDocumentFailure(document(long, "m1"), now)).toBe("chat_import_text_too_long");
    const ancient = [{ ...message("m1", null, "user"), createdAt: "1999-12-31T23:59:59.000Z" }];
    expect(chatImportDocumentFailure(document(ancient, "m1"), now)).toBe("chat_import_date_out_of_range");
    const future = { ...document(), chat: { ...document().chat, updatedAt: "2026-10-07T00:00:00.000Z" } };
    expect(chatImportDocumentFailure(future, now)).toBe("chat_import_date_out_of_range");
    expect(chatImportDocumentFailure(document(), now)).toBeNull();
    expect(decodeChatImportItem({ document: document([], null), source: "AIQSA" }, now))
      .toEqual({ code: "chat_import_empty", ok: false });
  });

  it("normalizes a source model label so that it never fails a chat", () => {
    expect(normalizeChatImportSourceModel(undefined)).toBeUndefined();
    expect(normalizeChatImportSourceModel("  gpt-4o\n")).toBe("gpt-4o");
    expect(normalizeChatImportSourceModel(" \t ")).toBeUndefined();
    const long = normalizeChatImportSourceModel(`${"m".repeat(127)}🙂tail`)!;
    expect(long).toBe("m".repeat(127));
    expect(decodeChatImportItem({ document: document(), source: "CLAUDE", sourceKey: "k", sourceModel: long }, now)).toMatchObject({ ok: true });
  });

  it("bounds the request envelope", () => {
    expect(decodeChatImportRequestItems({ chats: [1] })).toEqual([1]);
    expect(decodeChatImportRequestItems({ chats: [] })).toBeNull();
    expect(decodeChatImportRequestItems({ chats: Array(CHAT_IMPORT_MAX_CHATS_PER_REQUEST + 1).fill(1) })).toBeNull();
    expect(decodeChatImportRequestItems({ chats: [1], other: true })).toBeNull();
    expect(decodeChatImportRequestItems([1])).toBeNull();
  });

  it("decodes one result per sent chat and nothing else", () => {
    const results = [
      { messages: 4, status: "imported" },
      { status: "already_imported" },
      { code: "chat_import_empty", status: "failed" }
    ];
    expect(decodeChatImportResponse({ results }, 3)).toEqual({ results });
    expect(decodeChatImportResponse({ results }, 2)).toBeNull();
    expect(decodeChatImportResponse({ results: [{ messages: 0, status: "imported" }] }, 1)).toBeNull();
    expect(decodeChatImportResponse({ results: [{ code: "unknown_code", status: "failed" }] }, 1)).toBeNull();
    expect(decodeChatImportResponse({ results: [{ chatId: "x", messages: 1, status: "imported" }] }, 1)).toBeNull();
    expect(new Set(CHAT_IMPORT_FAILURE_CODES).size).toBe(CHAT_IMPORT_FAILURE_CODES.length);
  });
});
