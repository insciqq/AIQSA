// @vitest-environment node

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(async () => ({ byteSize: 3, extractedText: null, fileName: "notes.txt", id: "attachment-1", kind: "text",
    metadata: {}, mimeType: "text/plain", processingErrorCode: null, status: "ready", updatedAt: new Date(0) })),
  kick: vi.fn(),
  resolveProjectAccess: vi.fn(async () => ({ projectId: "project-1", role: "CONTRIBUTOR" })),
  transaction: vi.fn()
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: { $transaction: mocks.transaction, attachment: { findFirst: mocks.findFirst } }
}));
vi.mock("@/lib/server/auth/defaultAuth", () => ({
  resolveRequestAuth: vi.fn(async () => ({ userId: "member-1" }))
}));
vi.mock("@/lib/server/projects/access", () => ({ resolveProjectAccess: mocks.resolveProjectAccess }));
vi.mock("@/lib/server/uploads/defaultProcessing", () => ({ kickDefaultAttachmentProcessing: mocks.kick }));

import { DELETE, GET, POST } from "./route";

const context = { params: Promise.resolve({ attachmentId: "attachment-1", projectId: "project-1" }) };

describe("Project attachment route while Projects are disabled", () => {
  it("refuses retrying or deleting a Project attachment, and still reads it", async () => {
    for (const handler of [POST, DELETE]) {
      const response = await handler(new Request("http://app.local/api/projects/project-1/attachments/attachment-1", { method: "POST" }), context);
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({ error: "projects_disabled" });
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.kick).not.toHaveBeenCalled();

    const read = await GET(new Request("http://app.local/api/projects/project-1/attachments/attachment-1"), context);
    expect(read.status).toBe(200);
    await expect(read.json()).resolves.toMatchObject({ attachment: { id: "attachment-1" } });
  });
});
