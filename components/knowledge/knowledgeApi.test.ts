import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  uploadKnowledgeMultipartPart,
  uploadKnowledgeProxyContent
} from "./knowledgeApi";

const completedBatch = {
  createdAt: "2026-08-18T10:00:00.000Z",
  id: "batch-1",
  items: [{
    attemptNumber: 1,
    byteSize: 5,
    clientFileId: "file-1",
    failureCode: null,
    fileName: "notes.md",
    id: "item-1",
    sourceId: null,
    state: "upload_complete",
    transport: null,
    updatedAt: "2026-08-18T10:00:00.000Z",
    uploadedBytes: 5
  }],
  updatedAt: "2026-08-18T10:00:00.000Z"
};

class FakeXMLHttpRequest extends EventTarget {
  static body: Blob | null = null;
  static etag: string | null = null;
  static responseText = "";
  static sendCount = 0;
  static status = 200;

  readonly upload = new EventTarget();
  responseText = "";
  status = 0;
  timeout = 0;

  abort() {
    this.dispatchEvent(new Event("abort"));
  }

  getResponseHeader(name: string): string | null {
    return name.toLowerCase() === "etag" ? FakeXMLHttpRequest.etag : null;
  }

  open() {}

  send(body: Blob) {
    FakeXMLHttpRequest.body = body;
    FakeXMLHttpRequest.sendCount += 1;
    queueMicrotask(() => {
      this.upload.dispatchEvent(new ProgressEvent("progress", { loaded: body.size }));
      this.status = FakeXMLHttpRequest.status;
      this.responseText = FakeXMLHttpRequest.responseText;
      this.dispatchEvent(new Event("load"));
    });
  }
}

beforeEach(() => {
  FakeXMLHttpRequest.body = null;
  FakeXMLHttpRequest.etag = null;
  FakeXMLHttpRequest.responseText = "";
  FakeXMLHttpRequest.sendCount = 0;
  FakeXMLHttpRequest.status = 200;
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Knowledge upload browser transport", () => {
  it("reports proxy progress and decodes only the safe durable batch", async () => {
    FakeXMLHttpRequest.responseText = JSON.stringify({ batch: completedBatch });
    const progress = vi.fn();
    const file = new File(["hello"], "notes.md", { type: "text/markdown" });

    await expect(uploadKnowledgeProxyContent("/api/upload/item-1", file, {
      onProgress: progress,
      signal: new AbortController().signal
    })).resolves.toEqual({ data: completedBatch, ok: true });

    expect(FakeXMLHttpRequest.body).toBe(file);
    expect(progress).toHaveBeenLastCalledWith(5);
  });

  it("requires an exposed multipart ETag checkpoint", async () => {
    const body = new Blob(["hello"]);
    const signal = new AbortController().signal;

    await expect(uploadKnowledgeMultipartPart("https://storage.test/part", body, { signal }))
      .resolves.toMatchObject({ code: "knowledge_upload_etag_unavailable", ok: false });

    FakeXMLHttpRequest.etag = '"etag-1"';
    await expect(uploadKnowledgeMultipartPart("https://storage.test/part", body, { signal }))
      .resolves.toEqual({ data: '"etag-1"', ok: true });
  });

  it("settles an already-aborted request without sending bytes", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(uploadKnowledgeMultipartPart(
      "https://storage.test/part",
      new Blob(["hello"]),
      { signal: controller.signal }
    )).resolves.toMatchObject({ code: "knowledge_upload_cancelled", ok: false });
    expect(FakeXMLHttpRequest.sendCount).toBe(0);
  });
});
