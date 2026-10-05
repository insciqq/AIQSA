import { describe, expect, it } from "vitest";
import { decodeChatArchiveManifest, decodeChatExportDocument, isSafeChatArchivePath } from "./chatExport";

const createdAt = "2026-09-01T12:00:00.000Z";

function node(id: string, parentId: string | null, extra: Record<string, unknown> = {}) {
  return { createdAt, id, parentId, role: parentId ? "assistant" : "user", status: "complete", text: `text ${id}`, ...extra };
}

function document(messages: unknown[], chat: Record<string, unknown> = {}, top: Record<string, unknown> = {}) {
  return {
    chat: { activeLeafId: "m2", archived: false, createdAt, messages, pinned: false, title: "Chat", updatedAt: createdAt, ...chat },
    exportedAt: createdAt,
    format: "aiqsa.chat",
    version: 1,
    ...top
  };
}

const code = (value: unknown) => {
  const result = decodeChatExportDocument(value);
  return result.ok ? "ok" : result.code;
};

describe("aiqsa.chat decoder", () => {
  it("accepts a forest with several roots, optional model and attachment metadata", () => {
    const input = document([
      node("m1", null, { attachments: [{ byteSize: 3, mimeType: "text/plain", name: "a.txt" }, { name: "gone.png" }] }),
      node("m2", "m1", { model: { modelId: "model", provider: "provider" } }),
      node("m3", null),
      node("m4", "m3", { createdAt: "2026-09-01T15:00:00+03:00", status: "cancelled", text: "" })
    ], { activeLeafId: "m4" });
    const result = decodeChatExportDocument(input);
    expect(result).toEqual({ ok: true, value: input });
  });

  it("accepts an empty chat without an active leaf", () => {
    expect(code(document([], { activeLeafId: null }))).toBe("ok");
  });

  it("rejects foreign formats and unpublished versions before the shape", () => {
    expect(code(document([], {}, { format: "other" }))).toBe("chat_export_format_unsupported");
    expect(code(document([], {}, { version: 2 }))).toBe("chat_export_version_unsupported");
    expect(code(document([], {}, { version: "1" }))).toBe("chat_export_version_unsupported");
    expect(code(null)).toBe("chat_export_shape_invalid");
    expect(code([])).toBe("chat_export_shape_invalid");
  });

  it.each([
    ["an unknown top-level field", document([node("m1", null), node("m2", "m1")], {}, { extra: true })],
    ["an unknown chat field", document([node("m1", null), node("m2", "m1")], { followups: [] })],
    ["an unknown message field", document([node("m1", null), node("m2", "m1", { followups: [] })])],
    ["a system role", document([node("m1", null, { role: "system" }), node("m2", "m1")])],
    ["an unknown status", document([node("m1", null, { status: "done" }), node("m2", "m1")])],
    ["a non-string text", document([node("m1", null, { text: 1 }), node("m2", "m1")])],
    ["a malformed id", document([node("m 1", null), node("m2", "m 1")])],
    ["an incomplete model", document([node("m1", null), node("m2", "m1", { model: { provider: "p" } })])],
    ["an empty attachment list", document([node("m1", null, { attachments: [] }), node("m2", "m1")])],
    ["a negative attachment size", document([node("m1", null, { attachments: [{ byteSize: -1, name: "a" }] }), node("m2", "m1")])],
    ["a missing messages array", document([], { messages: undefined })]
  ])("rejects %s as a shape error", (_label, input) => {
    expect(code(input)).toBe("chat_export_shape_invalid");
  });

  it("rejects malformed dates", () => {
    expect(code(document([node("m1", null, { createdAt: "yesterday" }), node("m2", "m1")]))).toBe("chat_export_date_invalid");
    expect(code(document([node("m1", null), node("m2", "m1")], { updatedAt: "2026-09-01" }))).toBe("chat_export_date_invalid");
    expect(code(document([], { activeLeafId: null }, { exportedAt: "2026-13-45T99:00:00Z" }))).toBe("chat_export_date_invalid");
  });

  it("rejects duplicate ids, dangling parents, children before parents and cycles", () => {
    expect(code(document([node("m1", null), node("m2", "m1"), node("m2", "m1")]))).toBe("chat_export_message_id_duplicate");
    expect(code(document([node("m1", null), node("m2", "m9")]))).toBe("chat_export_parent_missing");
    expect(code(document([node("m2", "m1"), node("m1", null)]))).toBe("chat_export_parent_order_invalid");
    expect(code(document([node("m1", "m2"), node("m2", "m1")]))).toBe("chat_export_tree_cycle");
    expect(code(document([node("m1", null), node("m2", "m2")]))).toBe("chat_export_tree_cycle");
  });

  it("rejects an active leaf that is not a message", () => {
    expect(code(document([node("m1", null), node("m2", "m1")], { activeLeafId: "m3" }))).toBe("chat_export_active_leaf_missing");
  });
});

describe("aiqsa.chat-archive manifest decoder", () => {
  const entry = { archived: false, markdownPath: "chat-2026-09-01.md", path: "chat-2026-09-01.json", title: "Chat", updatedAt: createdAt };
  const manifest = (chats: unknown[], top: Record<string, unknown> = {}) =>
    ({ chats, exportedAt: createdAt, format: "aiqsa.chat-archive", version: 1, ...top });
  const manifestCode = (value: unknown) => {
    const result = decodeChatArchiveManifest(value);
    return result.ok ? "ok" : result.code;
  };

  it("accepts relative chat paths including the archived folder", () => {
    const input = manifest([entry, { ...entry, archived: true, markdownPath: "archived/chat-2026-09-01.md", path: "archived/chat-2026-09-01.json" }]);
    expect(decodeChatArchiveManifest(input)).toEqual({ ok: true, value: input });
  });

  it("rejects foreign formats, versions, traversal and duplicate paths", () => {
    expect(manifestCode(manifest([], { format: "aiqsa.chat" }))).toBe("chat_archive_format_unsupported");
    expect(manifestCode(manifest([], { version: 2 }))).toBe("chat_archive_version_unsupported");
    expect(manifestCode(manifest([{ ...entry, extra: 1 }]))).toBe("chat_archive_shape_invalid");
    expect(manifestCode(manifest([{ ...entry, updatedAt: "soon" }]))).toBe("chat_archive_date_invalid");
    expect(manifestCode(manifest([{ ...entry, path: "../chat.json" }]))).toBe("chat_archive_path_invalid");
    expect(manifestCode(manifest([{ ...entry, path: "/chat.json" }]))).toBe("chat_archive_path_invalid");
    expect(manifestCode(manifest([{ ...entry, path: "manifest.json" }]))).toBe("chat_archive_path_invalid");
    expect(manifestCode(manifest([{ ...entry, markdownPath: "chat.json" }]))).toBe("chat_archive_path_invalid");
    expect(manifestCode(manifest([entry, entry]))).toBe("chat_archive_path_duplicate");
  });

  it("checks archive path segments", () => {
    expect(isSafeChatArchivePath("archived/a.json", ".json")).toBe(true);
    expect(isSafeChatArchivePath("a//b.json", ".json")).toBe(false);
    expect(isSafeChatArchivePath("a\\b.json", ".json")).toBe(false);
    expect(isSafeChatArchivePath("./a.json", ".json")).toBe(false);
  });
});
