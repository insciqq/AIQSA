// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { runWithContext } from "@/lib/server/observability";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  deleteObject: vi.fn(async () => undefined),
  kick: vi.fn(),
  putObject: vi.fn(async () => undefined),
  transaction: vi.fn()
}));

vi.mock("@/lib/server/prisma", () => ({
  prisma: {
    $transaction: mocks.transaction,
    attachmentDeletionJob: {
      deleteMany: vi.fn(async () => ({ count: 1 })),
      upsert: vi.fn(async () => ({ id: "cleanup-job" }))
    }
  }
}));
vi.mock("@/lib/server/auth/defaultAuth", () => ({
  resolveRequestAuth: vi.fn(async () => ({ userId: "PRIVATE_USER_ID" }))
}));
vi.mock("@/lib/server/uploads/defaultProcessing", () => ({
  getDefaultAttachmentProcessingCoordinator: () => ({ kick: mocks.kick })
}));
vi.mock("@/lib/server/uploads/storage", () => ({
  createS3StorageAdapter: () => ({ deleteObject: mocks.deleteObject, putObject: mocks.putObject })
}));
vi.mock("@/lib/server/uploads/libraryRepository", () => ({ attachmentLibraryRepository: {} }));
vi.mock("@/lib/server/workspace/defaultServices", () => ({
  workspaceAvailabilityService: {
    snapshot: async () => ({ policy: { enabled: true }, runtime: { state: "ready" } })
  }
}));

import { POST } from "./route";

function request(workspace = false): Request {
  const form = new FormData();
  form.set("file", workspace
    ? new File([Buffer.from([0, 1, 2, 3])], "PRIVATE_FILE_NAME.aiqsa-opaque", { type: "application/x-aiqsa-opaque" })
    : new File(["PRIVATE_FILE_CONTENT"], "PRIVATE_FILE_NAME.txt", { type: "text/plain" }));
  if (workspace) form.set("scope", "workspace");
  return new Request("http://app.local/api/uploads", { body: form, method: "POST" });
}

const transactionClient = { attachment: { create: mocks.create } };

describe("upload enqueue correlation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockImplementation(async ({ data }) => ({
      ...data,
      id: "PRIVATE_ATTACHMENT_ID",
      processingJob: data.processingJob ? { id: "processing-job" } : null,
      updatedAt: new Date("2026-09-13T00:00:00Z")
    }));
    mocks.transaction.mockImplementation(async (operation) => operation(transactionClient));
  });

  it("links the committed processing job to the upload trace without exposing private attachment fields", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    let release!: () => void;
    const commit = new Promise<void>((resolve) => { release = resolve; });
    let created!: () => void;
    const recordCreated = new Promise<void>((resolve) => { created = resolve; });
    mocks.transaction.mockImplementation(async (operation) => {
      const record = await operation(transactionClient);
      created();
      await commit;
      return record;
    });
    try {
      const pending = runWithContext({ trace_id: "7".repeat(32) }, () => POST(request()));
      await recordCreated;
      expect(lines).toEqual([]);
      release();
      const response = await pending;
      expect(response.status).toBe(200);
      expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
        include: { processingJob: { select: { id: true } } }
      }));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toMatchObject({
        event: "job_enqueued", job_id: "processing-job", subsystem: "attachments", trace_id: "7".repeat(32)
      });
      expect(lines.join("")).not.toContain("PRIVATE_");
      expect(JSON.stringify(await response.json())).not.toContain("processing-job");
      expect(mocks.kick).toHaveBeenCalledOnce();
    } finally {
      release();
      write.mockRestore();
    }
  });

  it("does not announce an enqueue if the attachment transaction rolls back", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    mocks.transaction.mockImplementation(async (operation) => {
      await operation(transactionClient);
      throw new Error("PRIVATE_DATABASE_FAILURE");
    });
    try {
      await expect(runWithContext({ trace_id: "8".repeat(32) }, () => POST(request())))
        .rejects.toThrow("PRIVATE_DATABASE_FAILURE");
      expect(lines).toEqual([]);
      expect(mocks.kick).not.toHaveBeenCalled();
      expect(mocks.deleteObject).toHaveBeenCalledOnce();
    } finally {
      write.mockRestore();
    }
  });

  it("does not invent a processing job for a ready Workspace upload", async () => {
    const lines: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      const response = await runWithContext({ trace_id: "9".repeat(32) }, () => POST(request(true)));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ attachment: { status: "ready" } });
      expect(lines).toEqual([]);
      expect(mocks.kick).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
    }
  });
});
