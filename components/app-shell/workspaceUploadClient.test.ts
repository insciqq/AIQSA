import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetComposerSessionStoreForTest } from "@/tests/support/appShellStores";
import { useComposerSessionStore } from "./composerSessionStore";
import { cancelWorkspaceUpload, retryWorkspaceUpload, uploadWorkspaceFile, useWorkspaceUploadProgress } from "./workspaceUploadClient";
import { shellFetch } from "./shellApi";

vi.mock("./shellApi", () => ({ shellFetch: vi.fn() }));
vi.mock("@/lib/browser/sha256", () => ({ sha256: async () => "0".repeat(64) }));

class PartRequest {
  static requests: PartRequest[] = [];
  upload = { onprogress: null as ((event: { loaded: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0; timeout = 0; responseText = "";
  open() {} setRequestHeader() {}
  send() { PartRequest.requests.push(this); }
  abort() { this.onabort?.(); }
}
const wire = { id: "owned-upload", byteSize: 3, partBytes: 8 * 1024 * 1024,
  completedParts: [], state: "uploading", expiresAt: "2026-09-24T00:00:00Z", errorCode: null, attachment: null };
const attachment = { id: "original", fileName: "original.bin", mimeType: "application/octet-stream", byteSize: 3,
  kind: "file", status: "ready", extractedText: null, updatedAt: "2026-09-23T00:00:00Z" };
function begin() {
  const sourceKey = "chat:source" as const;
  useComposerSessionStore.getState().activateSession(sourceKey);
  const generation = useComposerSessionStore.getState().beginUpload(sourceKey)!;
  const file = new File(["abc"], "original.bin");
  const slice = file.slice.bind(file);
  // jsdom's Blob lacks arrayBuffer; use its browser FileReader implementation.
  vi.spyOn(file, "slice").mockImplementation((...args) => {
    const part = slice(...args);
    part.arrayBuffer = () => new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(part);
    });
    return part;
  });
  const result = uploadWorkspaceFile({ file, projectId: null, sourceKey, generation });
  return { sourceKey, generation, result };
}

describe("Workspace file upload lifecycle", () => {
  beforeEach(() => {
    resetComposerSessionStoreForTest(); PartRequest.requests = [];
    vi.stubGlobal("XMLHttpRequest", PartRequest);
  });
  afterEach(async () => {
    for (const item of useWorkspaceUploadProgress.getState().items) cancelWorkspaceUpload(item.id);
    await vi.waitFor(() => expect(useWorkspaceUploadProgress.getState().items).toHaveLength(0));
    vi.unstubAllGlobals(); vi.clearAllMocks(); resetComposerSessionStoreForTest();
  });
  it("resumes a confirmed part after a lost response and keeps the source chat when navigating", async () => {
    vi.mocked(shellFetch)
      .mockResolvedValueOnce(Response.json(wire))
      .mockResolvedValueOnce(Response.json({ ...wire, completedParts: [1] }))
      .mockResolvedValueOnce(Response.json({ ...wire, completedParts: [1], state: "completed", attachment }));
    const { result, sourceKey } = begin();
    await vi.waitFor(() => expect(PartRequest.requests).toHaveLength(1));
    PartRequest.requests[0]!.upload.onprogress?.({ loaded: 2 });
    expect(useWorkspaceUploadProgress.getState().items[0]).toMatchObject({ sourceKey, sentBytes: 2 });
    useComposerSessionStore.getState().activateSession("chat:other");
    PartRequest.requests[0]!.onerror?.();
    await vi.waitFor(() => expect(useWorkspaceUploadProgress.getState().items[0]?.state).toBe("failed"));
    expect(retryWorkspaceUpload(useWorkspaceUploadProgress.getState().items[0]!.id)).toBe(true);
    await expect(result).resolves.toEqual(attachment);
    expect(PartRequest.requests).toHaveLength(1);
    expect(useComposerSessionStore.getState().activeSessionKey).toBe("chat:other");
    expect(useComposerSessionStore.getState().sessionsByKey["chat:other"]?.attachments).toHaveLength(0);
  });
  it.each(["remove", "logout"])("aborts transfer and schedules deletion on %s", async action => {
    vi.mocked(shellFetch).mockResolvedValue(Response.json(wire));
    const { result } = begin();
    await vi.waitFor(() => expect(PartRequest.requests).toHaveLength(1));
    if (action === "remove") cancelWorkspaceUpload(useWorkspaceUploadProgress.getState().items[0]!.id);
    else resetComposerSessionStoreForTest();
    await expect(result).resolves.toBeNull();
    expect(shellFetch).toHaveBeenLastCalledWith("/api/uploads/sessions/owned-upload", expect.objectContaining({ method: "DELETE" }));
  });
});
