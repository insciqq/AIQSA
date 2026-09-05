// @vitest-environment node

import { createTestAuth } from "@/tests/support/auth";
import { describe, expect, it, vi } from "vitest";
import { getAuthConfig, TEST_AUTH_TOKEN } from "../auth/config";
import { createAttachmentLibraryHandler } from "./libraryHandlers";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: TEST_AUTH_TOKEN,
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });

describe("attachment library handler", () => {
  it("authenticates before listing and projects only source-navigation fields", async () => {
    const listSent = vi.fn(async () => [{
      byteSize: 4_096,
      chatId: "chat-1",
      chatTitle: "Quarterly review",
      createdAt: new Date("2026-08-22T09:30:00.000Z"),
      fileName: "report.pdf",
      id: "attachment-1",
      messageId: "message-1",
        savedAt: null,
      status: "ready" as const
    }]);
    const GET = createAttachmentLibraryHandler({
      repository: { listSent },
      resolveAuth: auth.resolveAuth
    });

    const unauthorized = await GET(new Request("http://app.local/api/uploads"));
    expect(unauthorized.status).toBe(401);
    expect(listSent).not.toHaveBeenCalled();

    const response = await GET(new Request("http://app.local/api/uploads", {
      headers: { cookie: auth.cookie }
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      nextCursor: null,
      files: [{
        byteSize: 4_096,
        chatId: "chat-1",
        chatTitle: "Quarterly review",
        createdAt: "2026-08-22T09:30:00.000Z",
        fileName: "report.pdf",
        id: "attachment-1",
        messageId: "message-1",
        savedAt: null,
        status: "ready"
      }]
    });
    expect(JSON.stringify(body)).not.toContain("storageKey");
    expect(listSent).toHaveBeenCalledWith({ cursor: null, limit: 201, userId: config.bootstrapUserId });
  });
});
