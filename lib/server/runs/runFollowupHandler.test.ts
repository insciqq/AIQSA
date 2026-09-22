import { describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import { createRunFollowupHandler } from "./runFollowupHandler";
import type { RunFollowupOperations } from "./runFollowups";
import { subscribeRunFollowup } from "./runFollowupRegistry";

const auth = createTestAuth();
const input = { chatId: "chat", assistantMessageId: "answer", nonce: "nonce", text: "Clarification" };
const request = (body: unknown = input, cookie = auth.cookie) => new Request("http://localhost/api/model-runs/run/followups", {
  method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body)
});
const context = { params: Promise.resolve({ runId: "run" }) };
describe("Follow-up acceptance route", () => {
  it("authenticates and validates before calling the store", async () => {
    const accept = vi.fn<RunFollowupOperations["accept"]>();
    const handler = createRunFollowupHandler({ resolveAuth: auth.resolveAuth, followups: { accept } });
    expect((await handler(request(input, ""), context)).status).toBe(401);
    expect((await handler(request({ ...input, tools: "all" }), context)).status).toBe(400);
    expect((await handler(request({ ...input, text: " " }), context)).status).toBe(400);
    expect(accept).not.toHaveBeenCalled();
  });
  it("acknowledges only the durable entry and signals the existing executor", async () => {
    const entry = { id: "f", ordinal: 1, text: "Clarification", author: "Author", createdAt: new Date().toISOString(), delivery: "accepted" as const };
    const accept = vi.fn<RunFollowupOperations["accept"]>(async () => ({ kind: "accepted", entry }));
    const notified = vi.fn(), release = subscribeRunFollowup("run", notified);
    try {
      const response = await createRunFollowupHandler({ resolveAuth: auth.resolveAuth, followups: { accept } })(request(), context);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ followup: entry });
      expect(accept).toHaveBeenCalledWith({ ...input, runId: "run", userId: auth.session.userId });
      expect(notified).toHaveBeenCalledOnce();
    } finally { release(); }
  });
  it.each([ ["not_found", 404], ["closed", 409], ["conflict", 409], ["context_full", 400] ] as const)("returns the stable %s outcome", async (kind, status) => {
    const response = await createRunFollowupHandler({ resolveAuth: auth.resolveAuth, followups: { accept: async () => ({ kind }) } })(request(), context);
    expect(response.status).toBe(status);
  });
  it("reports an unconfirmed acceptance without echoing a database error or input", async () => {
    const response = await createRunFollowupHandler({ resolveAuth: auth.resolveAuth,
      followups: { accept: async () => { throw new Error("sensitive database detail"); } } })(request(), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toMatch(/sensitive|Clarification/);
  });
});
