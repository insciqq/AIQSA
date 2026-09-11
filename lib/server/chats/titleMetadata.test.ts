import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { chatTitlePending, createGetChatTitleHandler } from "./titleMetadata";

const auth: AuthenticatedSession = {
  expiresAt: new Date("2099-01-01"), id: "session", userId: "owner",
  user: { displayName: "Owner", email: null, id: "owner", role: "user", status: "active" }
};
const chat = {
  title: "Question", titleRevision: 0,
  titleGeneration: { dispatchedAt: null, expectedTitle: "Question", expiresAt: new Date("2099-01-01"), status: "pending", titleRevision: 0 }
};

describe("chat title metadata", () => {
  it("exposes pending only while the admitted title still applies and the work has time to finish", () => {
    expect(chatTitlePending(chat)).toBe(true);
    expect(chatTitlePending({ ...chat, titleRevision: 1 })).toBe(false);
    expect(chatTitlePending({ ...chat, archived: true })).toBe(false);
    expect(chatTitlePending({ ...chat, titleGeneration: { ...chat.titleGeneration, status: "ambiguous" } })).toBe(false);
    expect(chatTitlePending({ ...chat, titleGeneration: { ...chat.titleGeneration, expiresAt: new Date(0) } })).toBe(false);
    expect(chatTitlePending({ ...chat, titleGeneration: { ...chat.titleGeneration, status: "dispatched", expiresAt: new Date(0), dispatchedAt: new Date() } })).toBe(true);
  });

  it("returns only an authorized personal title and pending flag with no cached or internal projection", async () => {
    const findFirst = vi.fn(async () => chat);
    const handler = createGetChatTitleHandler({
      client: { chat: { findFirst } } as unknown as Pick<PrismaClient, "chat">,
      resolveAuth: async () => auth
    });
    const response = await handler(new Request("https://app.test/api/chats/chat/title"), { params: Promise.resolve({ chatId: "chat" }) });
    expect(await response.json()).toEqual({ pending: true, title: "Question" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { archived: false, id: "chat", permanentDeletionAt: null, projectId: null, userId: "owner" }
    }));
  });

  it("rejects unauthenticated reads and gives the same response for invisible and missing chats", async () => {
    const findFirst = vi.fn(async () => null);
    const client = { chat: { findFirst } } as unknown as Pick<PrismaClient, "chat">;
    const request = new Request("https://app.test/api/chats/chat/title");
    const context = { params: Promise.resolve({ chatId: "chat" }) };
    expect((await createGetChatTitleHandler({ client, resolveAuth: async () => null })(request, context)).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
    const response = await createGetChatTitleHandler({ client, resolveAuth: async () => auth })(request, context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "chat_not_found" });
  });
});
