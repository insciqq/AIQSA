import type { PrismaClient } from "@prisma/client";
import { expect, it, vi } from "vitest";
import { createChatContinuationHandler, createContinuationSourceHandler } from "./continuationHandlers";
import { continuationSourceHref } from "./continuationRepository";

const access = vi.hoisted(() => ({ resolveChatAccess: vi.fn() }));
vi.mock("../projects/access", () => ({ resolveChatAccess: access.resolveChatAccess }));

const session = { id: "session", userId: "owner", expiresAt: new Date(),
  user: { id: "owner", displayName: "Owner", email: null, role: "user", status: "active" } };
const context = { params: Promise.resolve({ chatId: "source" }) };
const request = (body: unknown) => new Request("http://localhost/api/chats/source/continue", {
  method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }
});
const input = { expectedLeafMessageId: "answer", requestId: "00000000-0000-4000-8000-000000000000" };

it("requires authentication and rejects extra scope, transcript or tool controls", async () => {
  const continueChat = vi.fn();
  expect((await createChatContinuationHandler({ continueChat, resolveAuth: async () => null })(request(input), context)).status).toBe(401);
  const handler = createChatContinuationHandler({ continueChat, resolveAuth: async () => session });
  for (const body of [{ ...input, userId: "someone" }, { ...input, transcript: "injected" }, { ...input, tools: [] }, {}, { ...input, requestId: "bad" }]) {
    expect((await handler(request(body), context)).status).toBe(400);
  }
  expect(continueChat).not.toHaveBeenCalled();
});

it("returns truthful progress and a bounded neutral error", async () => {
  const continueChat = vi.fn().mockResolvedValueOnce({ status: "running" }).mockRejectedValueOnce(new Error("private response"));
  const handler = createChatContinuationHandler({ continueChat, resolveAuth: async () => session });
  const modelSelection = { provider: "provider", modelId: "chosen" };
  const running = await handler(request({ ...input, modelSelection }), context);
  expect(running.status).toBe(202);
  expect(await running.json()).toEqual({ status: "running" });
  expect(continueChat).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", chatId: "source", modelSelection }));
  const failed = await handler(request(input), context);
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "chat_summary_failed" });
});

it("resolves source links through current authorization and never exposes inaccessible IDs", async () => {
  const sourceHref = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("/p/project/c/old");
  const handler = createContinuationSourceHandler({ sourceHref, resolveAuth: async () => session });
  expect((await handler(new Request("http://localhost/api/chats/source/continuation-source"), context)).status).toBe(404);
  const response = await handler(new Request("http://0.0.0.0:3000/api/chats/source/continuation-source"), context);
  expect(response.status).toBe(303);
  // The browser retains its public origin even behind a reverse proxy.
  expect(response.headers.get("location")).toBe("/p/project/c/old");
  expect(response.headers.get("cache-control")).toBe("no-store");
});

it("links a continuation to its source chat address in personal and Project form", async () => {
  const findUnique = vi.fn(async () => ({ sourceChatId: "source chat" }));
  const client = { chatContinuation: { findUnique } } as unknown as PrismaClient;
  access.resolveChatAccess.mockReset()
    .mockResolvedValueOnce({ project: null }).mockResolvedValueOnce({ project: null })
    .mockResolvedValueOnce({ project: null }).mockResolvedValueOnce({ project: { projectId: "project-1" } })
    .mockResolvedValueOnce({ project: null }).mockResolvedValueOnce(null);
  expect(await continuationSourceHref(client, "continued", "owner")).toBe("/c/source%20chat");
  expect(await continuationSourceHref(client, "continued", "owner")).toBe("/p/project-1/c/source%20chat");
  expect(await continuationSourceHref(client, "continued", "member")).toBeNull();
  expect(findUnique).toHaveBeenCalledWith({ where: { newChatId: "continued" }, select: { sourceChatId: true } });
});

it("authenticates explicit cancellation and bounds its authority to the current actor", async () => {
  const { createChatContinuationCancelHandler } = await import("./continuationHandlers");
  const cancel = vi.fn(async () => {});
  const denied = createChatContinuationCancelHandler({ cancel, resolveAuth: async () => null });
  expect((await denied(request(input), context)).status).toBe(401);
  expect(cancel).not.toHaveBeenCalled();
  const handler = createChatContinuationCancelHandler({ cancel, resolveAuth: async () => session });
  expect((await handler(request({ ...input, userId: "another" }), context)).status).toBe(400);
  expect((await handler(request(input), context)).status).toBe(204);
  expect(cancel).toHaveBeenCalledExactlyOnceWith({ chatId: "source", userId: "owner", requestId: input.requestId });
});
