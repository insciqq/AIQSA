import { expect, it, vi } from "vitest";
import { createChatContinuationHandler, createContinuationSourceHandler } from "./continuationHandlers";

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
  const running = await handler(request(input), context);
  expect(running.status).toBe(202);
  expect(await running.json()).toEqual({ status: "running" });
  expect(continueChat).toHaveBeenCalledWith(expect.objectContaining({ userId: "owner", chatId: "source" }));
  const failed = await handler(request(input), context);
  expect(failed.status).toBe(502);
  expect(await failed.json()).toEqual({ error: "chat_summary_failed" });
});

it("resolves source links through current authorization and never exposes inaccessible IDs", async () => {
  const sourceHref = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("/?chat=old&project=project");
  const handler = createContinuationSourceHandler({ sourceHref, resolveAuth: async () => session });
  expect((await handler(new Request("http://localhost/api/chats/source/continuation-source"), context)).status).toBe(404);
  const response = await handler(new Request("http://localhost/api/chats/source/continuation-source"), context);
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("http://localhost/?chat=old&project=project");
});
