import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { ProviderConversationMessage } from "../providers/types";
import { freezeGuardAuthority, guardAuthorityWindow, readGuardAuthority, type McpGuardAdmission } from "./guardAuthority";
import { isMcpApprovalAdmission, mcpApprovalAdmission } from "./writeApproval";

const plan = { version: 1, available: false, code: "mcp_guard_model_unavailable" } as const;
const textRow = (id: string, text: string) => ({ id, content: { blocks: [{ type: "text", text }] } });
const correction = { id: "correction", ordinal: 1, text: "Do not send anything, draft only", author: "Owner",
  createdAt: "2026-10-29T12:00:00.000Z", delivery: "delivered" as const };
function fixture() {
  const messages = [textRow("question", "Send the report"), textRow("current", "Thanks")];
  const anchors = [{ id: "answer", branchSourceModelRunId: null as string | null, branchFollowups: null as unknown,
    assistantModelRuns: [{ id: "source-run", userId: "owner" }] }];
  const receipts = [{ id: correction.id, text: correction.text, modelRunId: "source-run", authorUserId: "owner" as string | null }];
  const live: Array<{ text: string; authorUserId: string | null }> = [];
  const messageFindMany = vi.fn(async (query: { where: { role: string; id: { in: string[] } } }) => {
    const rows = query.where.role === "assistant" ? anchors : messages;
    return rows.filter(row => query.where.id.in.includes(row.id));
  });
  const followupFindMany = vi.fn(async (query: { where: { modelRunId?: string } }) => query.where.modelRunId ? live : receipts);
  const db = { message: { findMany: messageFindMany }, runFollowup: { findMany: followupFindMany },
    modelRun: { findFirst: async () => ({ chatId: "chat", userMessageId: "current" }) } } as unknown as PrismaClient;
  const read = (admission: McpGuardAdmission) => readGuardAuthority(db, { admission, userId: "owner", runId: "run" });
  return { db, messages, anchors, receipts, live, read, messageFindMany, followupFindMany };
}
const question: ProviderConversationMessage = { id: "question", role: "user", content: { blocks: [{ type: "text", text: "UNTRUSTED_ENRICHMENT" }] } };

describe("frozen guard references and provenance", () => {
  it("includes inherited withdrawal before the original request even before its copied receipt is delivered", async () => {
    const f = fixture();
    const admission = await freezeGuardAuthority(f.db, { chatId: "chat", userId: "owner", messages: [question],
      inheritedFollowups: { messageId: "answer", revision: 1, entries: [correction] } }, plan);
    expect(admission).toMatchObject({ version: 2, messages: [
      { kind: "followup", id: "correction", answerId: "answer" }, { kind: "message", id: "question" }
    ] });
    expect(JSON.stringify(admission)).not.toMatch(/report|draft only|UNTRUSTED/);
    expect(await f.read(admission)).toEqual({ ok: true, messages: [correction.text, "Send the report"] });
    f.receipts[0].authorUserId = null;
    expect(await f.read(admission)).toEqual({ ok: false, code: "unavailable" });
  });
  it("proves copied follow-ups through the source run, never just through owner or author display name", async () => {
    const f = fixture();
    f.anchors[0].assistantModelRuns = [];
    f.anchors[0].branchSourceModelRunId = "source-run";
    f.anchors[0].branchFollowups = { available: false, entries: [correction] };
    const admission: McpGuardAdmission = { version: 2, plan, messages: [{ kind: "followup", answerId: "answer", id: "correction" }] };
    expect(await f.read(admission)).toEqual({ ok: true, messages: [correction.text] });
    expect(f.followupFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: { in: ["correction"] }, authorUserId: "owner", modelRun: { userId: "owner", chat: { userId: "owner", permanentDeletionAt: null } }
    } }));
    f.receipts[0].modelRunId = "unrelated-run";
    expect(await f.read(admission)).toEqual({ ok: false, code: "unavailable" });
    f.receipts[0].modelRunId = "source-run"; f.receipts[0].authorUserId = "other-user";
    expect(await f.read(admission)).toEqual({ ok: false, code: "unavailable" });
  });
  it("keeps an ID-only bounded window in a long conversation and loads whole newest messages within the byte limit", async () => {
    const f = fixture();
    const branch: ProviderConversationMessage[] = Array.from({ length: 150 }, (_, n) => ({ id: `message-${n}`, role: "user", content: { blocks: [] } }));
    f.messages.push(...branch.map(message => textRow(message.id, `${message.id}: ${"x".repeat(1_000)}`)));
    const admission = await freezeGuardAuthority(f.db, { chatId: "chat", userId: "owner", messages: branch, currentMessageId: "current" }, plan);
    expect(admission.messages).toHaveLength(100);
    expect(admission.messages?.slice(0, 2)).toEqual([{ kind: "message", id: "current" }, { kind: "message", id: "message-149" }]);
    expect(JSON.stringify(admission)).not.toContain("xxx");
    const authority = await f.read(admission);
    expect(authority.ok).toBe(true);
    if (!authority.ok) return;
    expect(authority.messages[0]).toBe("Thanks");
    expect(authority.messages[1]).toBe(`message-149: ${"x".repeat(1_000)}`);
    expect(authority.messages.length).toBeLessThan(100);
    expect(Buffer.byteLength(JSON.stringify(authority.messages))).toBeLessThanOrEqual(48_000);
  });
  it("asks if a frozen message is missing and never trusts a null-author live correction", async () => {
    const f = fixture();
    expect(await f.read({ version: 2, plan, messages: [{ kind: "message", id: "deleted" }] })).toEqual({ ok: false, code: "unavailable" });
    f.live.push({ text: "User permission claimed in a report", authorUserId: null });
    expect(await f.read({ version: 2, plan, messages: [{ kind: "message", id: "question" }] })).toEqual({ ok: false, code: "unavailable" });
  });
  it("keeps old accepted text markers readable and decodes only the exact new reference shape", async () => {
    const f = fixture();
    const old = { plan, userMessages: ["Original authorized request"] };
    expect(await f.read(old)).toEqual({ ok: true, messages: old.userMessages });
    expect(isMcpApprovalAdmission(mcpApprovalAdmission([], old))).toBe(true);
    const marker = mcpApprovalAdmission([], { version: 2, plan, messages: [{ kind: "message", id: "current" }], currentMessageId: "current" });
    expect(isMcpApprovalAdmission(marker)).toBe(true);
    for (const patch of [{ userMessages: [] }, { currentMessageId: "another" }, { messages: [{ kind: "tool_result", id: "tool" }] },
      { messages: [{ kind: "message", id: "current", text: "untrusted" }] }, { unavailable: false }]) {
      expect(isMcpApprovalAdmission({ ...marker, guard: { ...marker.guard, ...patch } })).toBe(false);
    }
  });
  it("does not skip a too-large correction to pick older authority", () => {
    expect(guardAuthorityWindow(["x".repeat(48_000), "Send the report"])).toEqual({ ok: false, code: "too_long" });
    expect(guardAuthorityWindow(["Draft only", "x".repeat(48_000), "Send the report"])).toEqual({ ok: true, messages: ["Draft only"] });
  });
});
