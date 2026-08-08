// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { getAuthConfig, TEST_AUTH_TOKEN } from "../auth/config";
import { createTestAuth } from "../auth/testRequestAuth";
import {
  createAttachmentRetryHandler,
  createAttachmentStatusHandler,
  type AttachmentLifecycleRecord
} from "./lifecycleHandlers";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: TEST_AUTH_TOKEN,
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({ user: { id: config.bootstrapUserId } });
const context = { params: { attachmentId: "attachment-1" } };
const record: AttachmentLifecycleRecord = {
  byteSize: 10,
  extractedText: null,
  fileName: "report.docx",
  id: "attachment-1",
  kind: "document",
  metadata: {},
  mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  processingErrorCode: "parser_unavailable",
  status: "failed",
  updatedAt: new Date("2026-08-08T00:00:00.000Z")
};

function request(method = "GET", authenticated = true) {
  return new Request("http://app.local/api/uploads/attachment-1", {
    headers: authenticated ? { cookie: auth.cookie } : undefined,
    method
  });
}

describe("attachment lifecycle handlers", () => {
  it("authenticates before loading status and exposes no private storage fields", async () => {
    const load = vi.fn(async () => record);
    const GET = createAttachmentStatusHandler({
      repository: { load, retry: vi.fn() },
      resolveAuth: auth.resolveAuth
    });

    expect((await GET(request("GET", false), context)).status).toBe(401);
    expect(load).not.toHaveBeenCalled();
    const response = await GET(request(), context);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      attachment: {
        byteSize: 10,
        extractedText: null,
        fileName: "report.docx",
        id: "attachment-1",
        kind: "document",
        metadata: {},
        mimeType: record.mimeType,
        processingErrorCode: "parser_unavailable",
        status: "failed",
        updatedAt: "2026-08-08T00:00:00.000Z"
      }
    });
    expect(JSON.stringify(body)).not.toContain("storageKey");
    expect(load).toHaveBeenCalledWith({
      attachmentId: "attachment-1",
      userId: config.bootstrapUserId
    });
  });

  it("requeues an owned failed attachment and kicks processing", async () => {
    const processing = { ...record, processingErrorCode: null, status: "processing" as const };
    const retry = vi.fn(async () => ({ attachment: processing, kind: "retried" as const }));
    const kickProcessing = vi.fn();
    const POST = createAttachmentRetryHandler({
      kickProcessing,
      now: () => new Date("2026-08-08T00:01:00.000Z"),
      repository: { load: vi.fn(), retry },
      resolveAuth: auth.resolveAuth
    });

    const response = await POST(request("POST"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      attachment: {
        id: "attachment-1",
        processingErrorCode: null,
        status: "processing"
      }
    });
    expect(retry).toHaveBeenCalledWith({
      attachmentId: "attachment-1",
      now: new Date("2026-08-08T00:01:00.000Z"),
      userId: config.bootstrapUserId
    });
    expect(kickProcessing).toHaveBeenCalledOnce();
  });

  it("returns the committed retry state when its process-local wake-up fails", async () => {
    const processing = { ...record, processingErrorCode: null, status: "processing" as const };
    const POST = createAttachmentRetryHandler({
      kickProcessing() {
        throw new Error("coordinator_wakeup_failed");
      },
      repository: {
        load: vi.fn(),
        retry: vi.fn(async () => ({ attachment: processing, kind: "retried" as const }))
      },
      resolveAuth: auth.resolveAuth
    });

    const response = await POST(request("POST"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      attachment: { id: "attachment-1", status: "processing" }
    });
  });

  it.each([
    ["not_found", 404, "attachment_not_found"],
    ["not_retryable", 409, "attachment_retry_not_available"]
  ] as const)("maps %s retry outcomes to stable responses", async (kind, status, error) => {
    const POST = createAttachmentRetryHandler({
      repository: {
        load: vi.fn(),
        retry: vi.fn(async () => ({ kind }))
      },
      resolveAuth: auth.resolveAuth
    });

    const response = await POST(request("POST"), context);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({ error });
  });
});
