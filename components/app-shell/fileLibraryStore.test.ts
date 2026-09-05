import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshFileLibrary,
  resetFileLibraryStoreForTest,
  useFileLibraryStore
} from "./fileLibraryStore";

const response = () => Response.json({
  nextCursor: null,
  files: [{
    byteSize: 2_048,
    chatId: "chat-1",
    chatTitle: "Source chat",
    createdAt: "2026-08-22T10:00:00.000Z",
    fileName: "brief.pdf",
    id: "attachment-1",
    messageId: "message-1",
        savedAt: null,
    status: "ready"
  }]
});

describe("fileLibraryStore", () => {
  afterEach(() => {
    resetFileLibraryStoreForTest();
    vi.unstubAllGlobals();
  });

  it("loads durable sent uploads and reuses the ready snapshot", async () => {
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    await refreshFileLibrary();
    await refreshFileLibrary();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/uploads");
    expect(useFileLibraryStore.getState()).toMatchObject({
      data: { files: [expect.objectContaining({ id: "attachment-1" })] },
      error: null,
      loadState: "ready"
    });

    await refreshFileLibrary(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicit retryable error state for malformed responses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nextCursor: null, files: [{ id: "broken" }] })));

    await expect(refreshFileLibrary()).rejects.toThrow("file_library_response_invalid");
    expect(useFileLibraryStore.getState()).toMatchObject({
      data: null,
      error: "file_library_response_invalid",
      loadState: "error"
    });
  });
});
