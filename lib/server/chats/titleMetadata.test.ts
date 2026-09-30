import type { Prisma, PrismaClient } from "@prisma/client";
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

function clientFor(findFirst: unknown, query = vi.fn()) {
  const tx = { chat: { findFirst }, $queryRaw: query };
  const client = { $transaction: async (run: (client: Prisma.TransactionClient) => Promise<unknown>) => run(tx as unknown as Prisma.TransactionClient) };
  return client as unknown as Pick<PrismaClient, "$transaction">;
}

describe("chat title metadata", () => {
  it("adds terminal aggregate accounting only for an explicit authorized thread refresh", async () => {
    const query = vi.fn().mockResolvedValue([{ hasCompletedAnswer: true, recordCount: 2n,
      knownCostRecordCount: 2n, incompleteRecordCount: 0n, estimatedCostMicros: 7000n, totalTokens: 20n }]);
    const findFirst = vi.fn().mockResolvedValue({ ...chat, updatedAt: new Date("2026-09-27T10:00:00Z"),
      titleGeneration: { ...chat.titleGeneration, status: "settled" } });
    const handler = createGetChatTitleHandler({ client: clientFor(findFirst, query), resolveAuth: async () => auth });
    const context = { params: Promise.resolve({ chatId: "chat" }) };
    expect(await (await handler(new Request("https://app.test/api/chats/chat/title"), context)).json()).not.toHaveProperty("usageStats");
    expect(query).not.toHaveBeenCalled();
    expect(await (await handler(new Request("https://app.test/api/chats/chat/title?usage=1"), context)).json()).toMatchObject({
      pending: false, usagePending: false, usageStats: { hasCompletedAnswer: true, recordCount: 2, estimatedCostMicros: 7000 }
    });
    findFirst.mockResolvedValue(null);
    query.mockClear();
    expect((await handler(new Request("https://app.test/api/chats/chat/title?usage=1"), context)).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps accounting pending after a manual rename while admitted title work is still running", async () => {
    const query = vi.fn();
    const findFirst = vi.fn().mockResolvedValue({ ...chat, title: "Manual title", titleRevision: 1, updatedAt: new Date() });
    const handler = createGetChatTitleHandler({ client: clientFor(findFirst, query), resolveAuth: async () => auth });
    const response = await handler(new Request("https://app.test/api/chats/chat/title?usage=1"), { params: Promise.resolve({ chatId: "chat" }) });
    expect(await response.json()).toMatchObject({ pending: false, usagePending: true, title: "Manual title" });
    expect(query).not.toHaveBeenCalled();
  });
  it("does not treat the short title presentation deadline as settled provider accounting", async () => {
    const query = vi.fn();
    const findFirst = vi.fn().mockResolvedValue({ ...chat, updatedAt: new Date(),
      titleGeneration: { ...chat.titleGeneration, status: "dispatched", dispatchedAt: new Date(Date.now() - 90_000) } });
    const handler = createGetChatTitleHandler({ client: clientFor(findFirst, query), resolveAuth: async () => auth });
    const response = await handler(new Request("https://app.test/api/chats/chat/title?usage=1"), { params: Promise.resolve({ chatId: "chat" }) });
    expect(await response.json()).toMatchObject({ pending: false, usagePending: true });
    expect(query).not.toHaveBeenCalled();
  });
  it("exposes pending only while the admitted title still applies and the work has time to finish", () => {
    expect(chatTitlePending(chat)).toBe(true);
    expect(chatTitlePending({ ...chat, titleRevision: 1 })).toBe(false);
    expect(chatTitlePending({ ...chat, archived: true })).toBe(false);
    expect(chatTitlePending({ ...chat, titleGeneration: { ...chat.titleGeneration, status: "ambiguous" } })).toBe(false);
    expect(chatTitlePending({ ...chat, titleGeneration: { ...chat.titleGeneration, expiresAt: new Date(0) } })).toBe(false);
    expect(chatTitlePending({ ...chat, titleGeneration: { ...chat.titleGeneration, status: "dispatched", expiresAt: new Date(0), dispatchedAt: new Date() } })).toBe(true);
  });

  it("returns only an authorized personal title, pending flag and chat revision with no cached or internal projection", async () => {
    const findFirst = vi.fn(async () => ({ ...chat, updatedAt: new Date("2026-09-27T10:00:00.000Z") }));
    const handler = createGetChatTitleHandler({
      client: clientFor(findFirst),
      resolveAuth: async () => auth
    });
    const response = await handler(new Request("https://app.test/api/chats/chat/title"), { params: Promise.resolve({ chatId: "chat" }) });
    expect(await response.json()).toEqual({ pending: true, title: "Question", updatedAt: "2026-09-27T10:00:00.000Z" });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { archived: false, id: "chat", permanentDeletionAt: null, projectId: null, userId: "owner" }
    }));
  });

  it("rejects unauthenticated reads and gives the same response for invisible and missing chats", async () => {
    const findFirst = vi.fn(async () => null);
    const client = clientFor(findFirst);
    const request = new Request("https://app.test/api/chats/chat/title");
    const context = { params: Promise.resolve({ chatId: "chat" }) };
    expect((await createGetChatTitleHandler({ client, resolveAuth: async () => null })(request, context)).status).toBe(401);
    expect(findFirst).not.toHaveBeenCalled();
    const response = await createGetChatTitleHandler({ client, resolveAuth: async () => auth })(request, context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "chat_not_found" });
  });
});
