import { describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import { createRunFollowupHandler } from "./runFollowupHandler";
import { subscribeRunFollowups } from "./runFollowupRegistry";
import type { RunFollowupOperations } from "./runFollowups";

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
  // A waiting browser handoff ends on the user's new message (operator decision 2026-11-20); a retried submission of one
  // the agent may already have read wakes nothing (review 2026-11-20).
  it("wakes the run's listeners only for a message this request wrote", async () => {
    const heard: number[] = [];
    const stop = subscribeRunFollowups("run", (revision) => heard.push(revision));
    const entry = { author: "User", createdAt: "2026-11-20T10:00:00.000Z", delivery: "delivered" as const, id: "f1", ordinal: 1,
      text: "Clarification" };
    try {
      const retried = createRunFollowupHandler({ resolveAuth: auth.resolveAuth, followups: { accept: async () => ({ kind: "accepted", entry }) } });
      expect((await retried(request(), context)).status).toBe(200);
      expect(heard).toEqual([]);
      const created = createRunFollowupHandler({ resolveAuth: auth.resolveAuth,
        followups: { accept: async () => ({ created: true, kind: "accepted", entry: { ...entry, delivery: "accepted", ordinal: 2 } }) } });
      expect((await created(request(), context)).status).toBe(200);
      expect(heard).toEqual([2]);
    } finally {
      stop();
    }
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
