// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createTestAuth } from "@/tests/support/auth";
import { decodeWorkspaceExportPage } from "../../contracts/workspaceExports";
import { createWorkspaceExportHistoryHandler } from "./exportHistoryHandlers";

const page = { exports: [{ createdAt: "2026-09-05T00:00:00.000Z", messageId: "answer", files: [{
  attachmentId: "file", byteSize: 200, fileName: "report.xlsx", mimeType: "application/octet-stream", relativePath: "report.xlsx"
}] }], nextCursor: null };
const auth = createTestAuth({ user: { id: "history-owner" } });
const context = { params: { chatId: "chat" } };
const authenticatedRequest = (url: string) => new Request(url, { headers: { cookie: auth.cookie } });

describe("Workspace export history read boundary", () => {
  it("authenticates before reading and rejects an unbounded cursor without querying", async () => {
    const list = vi.fn();
    const unauthenticated = createWorkspaceExportHistoryHandler({ repository: { list }, resolveAuth: async () => null });
    expect((await unauthenticated(new Request("http://localhost/api/chats/chat/workspace/exports"), context)).status).toBe(401);
    const GET = createWorkspaceExportHistoryHandler({ repository: { list }, resolveAuth: auth.resolveAuth });
    expect((await GET(authenticatedRequest(`http://localhost/api/chats/chat/workspace/exports?cursor=${"x".repeat(129)}`), context)).status).toBe(400);
    expect(list).not.toHaveBeenCalled();
  });

  it("uses current authenticated ownership, bounds the decoded page and disables caching", async () => {
    const list = vi.fn(async () => page);
    const GET = createWorkspaceExportHistoryHandler({ repository: { list }, resolveAuth: auth.resolveAuth });
    const response = await GET(authenticatedRequest("http://localhost/api/chats/chat/workspace/exports?cursor=older&userId=another-owner"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(list).toHaveBeenCalledWith({ chatId: "chat", cursor: "older", userId: "history-owner" });
    expect(decodeWorkspaceExportPage(await response.json())).toEqual(page);
    expect(decodeWorkspaceExportPage({ ...page, exports: Array.from({ length: 31 }, () => page.exports[0]) })).toBeNull();
    expect(decodeWorkspaceExportPage({ exports: [{ ...page.exports[0], files: [] }], nextCursor: null })).toBeNull();
    expect(decodeWorkspaceExportPage({ ...page, nextCursor: "unsafe\ncursor" })).toBeNull();
  });

  it("does not distinguish an invisible chat from an absent chat", async () => {
    const GET = createWorkspaceExportHistoryHandler({ repository: { list: async () => null }, resolveAuth: auth.resolveAuth });
    const response = await GET(authenticatedRequest("http://localhost/api/chats/chat/workspace/exports"), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "chat_not_found" });
  });
});
