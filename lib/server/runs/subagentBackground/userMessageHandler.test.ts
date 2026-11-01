import { describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "../../auth/config";
import { subagentThread, subagentView } from "@/tests/support/subagentViewFixtures";
import type { SubagentThreadView } from "../../../contracts/subagentViews";
import type { SubagentBackgroundOperations } from "./control";
import { SubagentMailboxFullError } from "./control";
import { createSubagentUserMessageHandler } from "./userMessageHandler";

const params = { chatId: "chat-a", threadId: "thread-a" };
const input = { nonce: "nonce-1", text: "Please place the order.", turnId: "turn-thread-a" };
function setup(userId: string | null = "owner") {
  const deliverUser = vi.fn<SubagentBackgroundOperations["deliverUser"]>(async () => ({ kind: "delivered", state: "running" }));
  const threadView = vi.fn(async (scope: { chatId: string; threadId: string; userId: string }): Promise<SubagentThreadView | null> =>
    scope.userId === "owner" && scope.chatId === params.chatId && scope.threadId === params.threadId
      ? subagentView("chat-a", subagentThread("thread-a")) : null);
  const handler = createSubagentUserMessageHandler({ control: { deliverUser }, views: { threadView },
    getConfig: () => ({ appBaseUrl: "https://aiqsa.test", configured: true }) as unknown as AuthConfig,
    resolveAuth: async () => userId ? { expiresAt: new Date(), id: "session", userId,
      user: { displayName: "Owner", email: null, id: userId, role: "admin", status: "active" } } : null });
  const send = (body: unknown = input, target = params, headers: HeadersInit = {}) => handler(new Request("https://aiqsa.test/api/messages", {
    method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body)
  }), { params: Promise.resolve(target) });
  return { deliverUser, handler, send, threadView };
}

describe("direct user messages to sub-agents", () => {
  it("authenticates and delivers bounded user speech to the visible active turn", async () => {
    const f = setup();
    const response = await f.send();
    expect([response.status, await response.json()]).toEqual([202, { accepted: true }]);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(f.deliverUser).toHaveBeenCalledWith({ ...input, ...params, userId: "owner" });
    expect((await setup(null).send()).status).toBe(401);
  });

  it("refuses another user's and missing threads identically, including for administrators", async () => {
    for (const [actor, target] of [["other", params], ["owner", { ...params, threadId: "missing" }],
      ["owner", { ...params, chatId: "wrong-chat" }]] as const) {
      const f = setup(actor), response = await f.send(input, target);
      expect([response.status, await response.json()]).toEqual([404, { error: "subagent_not_found" }]);
      expect(f.deliverUser).not.toHaveBeenCalled();
    }
  });

  it.each([{}, { ...input, text: " " }, { ...input, text: "a".repeat(16_001) }, { ...input, text: "x\0" },
    { ...input, origin: "main_agent" }, { ...input, nonce: "n".repeat(124) }, { ...input, nonce: "../x" }])("bounds and decodes input before accessing the thread: %j", async (body) => {
    const f = setup();
    expect((await f.send(body)).status).toBe(400);
    expect(f.threadView).not.toHaveBeenCalled();
    expect(f.deliverUser).not.toHaveBeenCalled();
  });

  it("enforces same-origin and byte limits before delivery", async () => {
    const f = setup();
    expect((await f.send(input, params, { origin: "https://other.test" })).status).toBe(403);
    expect((await f.send(input, params, { "content-length": "999999999" })).status).toBe(413);
    expect(f.deliverUser).not.toHaveBeenCalled();
  });

  it("refuses finished and superseded turns, never starting another", async () => {
    const f = setup();
    expect((await f.send({ ...input, turnId: "old-turn" })).status).toBe(409);
    f.threadView.mockResolvedValue(subagentView("chat-a", subagentThread("thread-a", "done")));
    const response = await f.send();
    expect([response.status, await response.json()]).toEqual([409, { error: "subagent_not_active" }]);
    expect(f.deliverUser).not.toHaveBeenCalled();
  });

  it("visibly refuses a full mailbox and keeps a branch race indistinguishable from missing", async () => {
    const f = setup();
    f.deliverUser.mockRejectedValueOnce(new SubagentMailboxFullError());
    const full = await f.send();
    expect([full.status, await full.json()]).toEqual([409, { error: "subagent_message_limit_reached" }]);
    f.deliverUser.mockResolvedValueOnce({ kind: "not_found" });
    expect((await f.send()).status).toBe(404);
  });

  it("accepts while waiting without claiming that the wait ended", async () => {
    const f = setup();
    f.threadView.mockResolvedValue(subagentView("chat-a", subagentThread("thread-a", "waiting", { reason: "waiting_for_answer" })));
    f.deliverUser.mockResolvedValue({ kind: "delivered", state: "waiting" });
    expect(await (await f.send()).json()).toEqual({ accepted: true });
  });
});
