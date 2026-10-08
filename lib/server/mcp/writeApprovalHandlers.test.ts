import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { McpApprovalCard } from "@/lib/contracts/mcpApprovals";
import type { AuthenticatedSession } from "../auth/requestAuth";
import { createMcpApprovalHandlers } from "./writeApprovalHandlers";
import type { McpApprovalDecisionOutcome } from "./writeApprovalRepository";

const session = (status = "active") => ({ userId: "user-1", user: { status } }) as unknown as AuthenticatedSession;
const card: McpApprovalCard = { approvalId: "approval-1", serverName: "Records", source: "model", state: "allowed_once",
  toolName: "delete_record" };

function harness(input: Readonly<{ outcome?: McpApprovalDecisionOutcome; signedIn?: boolean; status?: string }> = {}) {
  const decide = vi.fn(async () => input.outcome ?? { card, continuation: true, kind: "decided" as const });
  const consents = {
    deleteMany: vi.fn(async () => ({ count: 1 })),
    findMany: vi.fn(async () => [{ createdAt: new Date("2026-10-08T00:00:00.000Z"), server: { displayName: "Records" },
      serverId: "server-1" }])
  };
  const handlers = createMcpApprovalHandlers({ decide, prisma: () => ({ mcpToolConsent: consents }) as unknown as PrismaClient,
    resolveAuth: async () => input.signedIn === false ? null : session(input.status) });
  return { consents, decide, handlers };
}

const post = (body: unknown) => new Request("http://app/api", { body: JSON.stringify(body), headers: { "content-type": "application/json" },
  method: "POST" });
const context = (callId = "approval-1", runId = "run-1") => ({ params: { callId, runId } });
const nonce = "nonce-0001";

describe("MCP approval decision route", () => {
  it("records the initiator's decision with its nonce and returns the card", async () => {
    const { decide, handlers } = harness();
    const response = await handlers.POST_DECISION(post({ decision: "allow_once", nonce }), context());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ approval: card });
    expect(decide).toHaveBeenCalledWith({ approvalId: "approval-1", decision: "allow_once", nonce, runId: "run-1", userId: "user-1" });
  });

  it("refuses anonymous, inactive, malformed and unknown requests before deciding", async () => {
    expect((await harness({ signedIn: false }).handlers.POST_DECISION(post({ decision: "deny", nonce }), context())).status).toBe(401);
    const inactive = harness({ status: "suspended" });
    expect((await inactive.handlers.POST_DECISION(post({ decision: "deny", nonce }), context())).status).toBe(403);
    expect(inactive.decide).not.toHaveBeenCalled();
    const { decide, handlers } = harness();
    for (const body of [{ decision: "always", nonce }, { decision: "deny" }, { decision: "deny", nonce: "short" },
      { decision: "deny", extra: true, nonce }, null]) {
      expect((await handlers.POST_DECISION(post(body), context())).status, JSON.stringify(body)).toBe(400);
    }
    expect((await handlers.POST_DECISION(post({ decision: "deny", nonce }), context("../x"))).status).toBe(404);
    expect(decide).not.toHaveBeenCalled();
  });

  it("answers others' cards, settled conflicts and running answers without deciding again", async () => {
    expect((await harness({ outcome: { kind: "not_found" } }).handlers.POST_DECISION(post({ decision: "allow_server", nonce }),
      context())).status).toBe(404);
    const running = await harness({ outcome: { kind: "run_active" } }).handlers.POST_DECISION(post({ decision: "deny", nonce }), context());
    expect(running.status).toBe(409);
    expect(await running.json()).toEqual({ error: "mcp_approval_run_active" });
    const conflict = await harness({ outcome: { card: { ...card, state: "denied" }, kind: "conflict" } }).handlers
      .POST_DECISION(post({ decision: "allow_once", nonce }), context());
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ approval: { ...card, state: "denied" }, error: "mcp_approval_already_decided" });
  });

  it("fails visibly without leaking database errors", async () => {
    const { decide, handlers } = harness();
    decide.mockRejectedValueOnce(new Error("connection refused at 10.0.0.1"));
    const response = await handlers.POST_DECISION(post({ decision: "deny", nonce }), context());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("10.0.0.1");
  });
});

describe("Always allowed consent routes", () => {
  it("lists the user's consents and revokes one", async () => {
    const { consents, handlers } = harness();
    const listed = await handlers.GET_CONSENTS(new Request("http://app/api"));
    expect(await listed.json()).toEqual({ consents: [{ createdAt: "2026-10-08T00:00:00.000Z", serverId: "server-1", serverName: "Records" }] });
    expect(consents.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: "user-1" } }));
    const revoked = await handlers.DELETE_CONSENT(new Request("http://app/api", { method: "DELETE" }), { params: { serverId: "server-1" } });
    expect(await revoked.json()).toEqual({ revoked: true });
    expect(consents.deleteMany).toHaveBeenCalledWith({ where: { serverId: "server-1", userId: "user-1" } });
    consents.deleteMany.mockResolvedValueOnce({ count: 0 });
    expect((await handlers.DELETE_CONSENT(new Request("http://app/api", { method: "DELETE" }), { params: { serverId: "server-2" } })).status)
      .toBe(404);
  });

  it("refuses anonymous and malformed consent requests", async () => {
    const anonymous = harness({ signedIn: false });
    expect((await anonymous.handlers.GET_CONSENTS(new Request("http://app/api"))).status).toBe(401);
    expect((await anonymous.handlers.DELETE_CONSENT(new Request("http://app/api"), { params: { serverId: "server-1" } })).status).toBe(401);
    const { consents, handlers } = harness();
    expect((await handlers.DELETE_CONSENT(new Request("http://app/api"), { params: { serverId: "a/b" } })).status).toBe(404);
    expect(consents.deleteMany).not.toHaveBeenCalled();
  });
});
