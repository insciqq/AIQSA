import { describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import type { ChatExportDocument } from "../../contracts/chatExport";
import { CHAT_IMPORT_REQUEST_MAX_BYTES, type ChatImportItem } from "../../contracts/chatImport";
import { getAuthConfig } from "../auth/config";
import { chatImportSourceKey, createImportChatsHandler, type ImportChatsHandlerDeps } from "./importChats";

const config = getAuthConfig({ AIQSA_AUTH_SESSION_SECRET: "secret", AIQSA_BOOTSTRAP_AUTH_TOKEN: "token" });
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });
const now = () => new Date("2026-10-05T12:00:00.000Z");

function document(overrides: Partial<ChatExportDocument["chat"]> = {}, exportedAt = "2026-10-01T00:00:00.000Z"): ChatExportDocument {
  return {
    chat: {
      activeLeafId: "m2",
      archived: false,
      createdAt: "2026-09-01T09:59:00.000Z",
      messages: [
        { createdAt: "2026-09-01T10:00:00.000Z", id: "m1", parentId: null, role: "user", status: "complete", text: "Question" },
        { createdAt: "2026-09-01T10:01:00.000Z", id: "m2", parentId: "m1", role: "assistant", status: "complete", text: "Answer" }
      ],
      pinned: false,
      title: "Synthetic import",
      updatedAt: "2026-09-02T10:00:00.000Z",
      ...overrides
    },
    exportedAt,
    format: "aiqsa.chat",
    version: 1
  };
}

function request(body: unknown, init: RequestInit = {}): Request {
  return new Request("http://app.local/api/me/chats/import", {
    body: typeof body === "string" ? body : JSON.stringify(body),
    method: "POST",
    ...init,
    headers: { "content-type": "application/json", cookie: auth.cookie, ...init.headers }
  });
}

function handler(importChat: ImportChatsHandlerDeps["importChat"]) {
  return createImportChatsHandler({ importChat, now, resolveAuth: auth.resolveAuth });
}

describe("chat import handler", () => {
  it("imports each valid chat on its own and reports invalid ones without failing the batch", async () => {
    const importChat = vi.fn<ImportChatsHandlerDeps["importChat"]>()
      .mockResolvedValueOnce({ messages: 2, status: "imported" })
      .mockResolvedValueOnce({ status: "already_imported" })
      .mockRejectedValueOnce(new Error("database unavailable"));
    const response = await handler(importChat)(request({
      chats: [
        { document: document(), source: "AIQSA" },
        { document: { ...document(), version: 9 }, source: "AIQSA" },
        { document: document(), source: "CHATGPT", sourceKey: "conversation-1" },
        { document: document({ messages: [], activeLeafId: null }), source: "AIQSA" },
        { document: document(), source: "CLAUDE", sourceKey: "uuid-2" }
      ]
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    await expect(response.json()).resolves.toEqual({
      results: [
        { messages: 2, status: "imported" },
        { code: "chat_export_version_unsupported", status: "failed" },
        { status: "already_imported" },
        { code: "chat_import_empty", status: "failed" },
        { code: "chat_import_failed", status: "failed" }
      ]
    });
    expect(importChat).toHaveBeenCalledTimes(3);
    expect(importChat.mock.calls[0]).toEqual([config.bootstrapUserId, { document: document(), source: "AIQSA" }]);
  });

  it("refuses before any import: no session, wrong media type, malformed or oversized bodies", async () => {
    const importChat = vi.fn<ImportChatsHandlerDeps["importChat"]>();
    const run = handler(importChat);
    const unauthenticated = await run(new Request("http://app.local/api/me/chats/import", {
      body: JSON.stringify({ chats: [] }), headers: { "content-type": "application/json" }, method: "POST"
    }));
    expect(unauthenticated.status).toBe(401);
    expect((await run(request({ chats: [] }, { headers: { "content-type": "text/plain" } }))).status).toBe(400);
    expect((await run(request("{not json"))).status).toBe(400);
    expect((await run(request({ chats: [] }))).status).toBe(400);
    expect((await run(request({ items: [{ document: document(), source: "AIQSA" }] }))).status).toBe(400);
    const oversized = await run(request("x".repeat(CHAT_IMPORT_REQUEST_MAX_BYTES + 1)));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: "request_body_too_large", limit: CHAT_IMPORT_REQUEST_MAX_BYTES });
    expect(importChat).not.toHaveBeenCalled();
  });

  it("accepts a chat larger than the default 1 MiB JSON limit", async () => {
    const importChat = vi.fn<ImportChatsHandlerDeps["importChat"]>(async () => ({ messages: 2, status: "imported" }));
    const large = document();
    const big = { ...large, chat: { ...large.chat, messages: [
      { ...large.chat.messages[0]!, text: "y".repeat(700_000) },
      { ...large.chat.messages[1]!, text: "z".repeat(700_000) }
    ] } };
    const response = await handler(importChat)(request({ chats: [{ document: big, source: "AIQSA" }] }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ results: [{ messages: 2, status: "imported" }] });
  });
});

describe("chat import source key", () => {
  const aiqsa = (doc: ChatExportDocument): ChatImportItem => ({ document: doc, source: "AIQSA" });

  it("keys an AIQSA document by its conversation, not by export time or chat settings", () => {
    const key = chatImportSourceKey(aiqsa(document()));
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(chatImportSourceKey(aiqsa(document({ archived: true, pinned: true, title: "Renamed", updatedAt: "2026-09-03T00:00:00.000Z" }, "2026-10-04T00:00:00.000Z"))))
      .toBe(key);
    // The same instant written differently is the same conversation.
    expect(chatImportSourceKey(aiqsa(document({ createdAt: "2026-09-01T09:59:00Z" })))).toBe(key);
    const changed = document();
    expect(chatImportSourceKey(aiqsa({ ...changed, chat: { ...changed.chat, messages: [changed.chat.messages[0]!] , activeLeafId: "m1" } })))
      .not.toBe(key);
    expect(chatImportSourceKey(aiqsa(document({ createdAt: "2026-09-01T09:58:00.000Z" })))).not.toBe(key);
  });

  it("keys other sources by their conversation id within the source", () => {
    const chatgpt = chatImportSourceKey({ document: document(), source: "CHATGPT", sourceKey: "conversation-1" });
    expect(chatImportSourceKey({ document: document({ title: "Other" }), source: "CHATGPT", sourceKey: "conversation-1" })).toBe(chatgpt);
    expect(chatImportSourceKey({ document: document(), source: "CLAUDE", sourceKey: "conversation-1" })).not.toBe(chatgpt);
    expect(chatImportSourceKey({ document: document(), source: "CHATGPT", sourceKey: "conversation-2" })).not.toBe(chatgpt);
  });
});
