// @vitest-environment node
import { createTestAuth } from "@/tests/support/auth";
import { describe, expect, it, vi } from "vitest";
import { createRemoveSavedFileHandler, createSaveFileHandler } from "./savedFileHandlers";

const auth = createTestAuth({ user: { id: "library-owner" } });
const context = { params: { attachmentId: "source-file" } };
const request = (method = "POST", authenticated = true) => new Request("http://app.local/api/uploads/source-file/save", {
  method, headers: authenticated ? { cookie: auth.cookie } : {}
});
const record = {
  byteSize: 12, extractedText: null, fileName: "deck.pptx", id: "independent-copy",
  kind: "file", metadata: {}, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  processingErrorCode: null, status: "ready" as const, updatedAt: new Date("2026-09-05T00:00:00Z"),
  storageKey: "must-not-project", checksum: "must-not-project"
};

describe("Library save and reuse", () => {
  it.each([true, false])("authenticates and projects the independent file (save=%s)", async (save) => {
    const repository = { copy: vi.fn(async () => record), remove: vi.fn() };
    const POST = createSaveFileHandler({ repository, resolveAuth: auth.resolveAuth }, save);
    expect((await POST(request("POST", false), context)).status).toBe(401);
    expect(repository.copy).not.toHaveBeenCalled();
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.attachment).toMatchObject({ id: "independent-copy", kind: "file", fileName: "deck.pptx" });
    expect(JSON.stringify(body)).not.toContain("must-not-project");
    expect(repository.copy).toHaveBeenCalledWith({ attachmentId: "source-file", save, userId: "library-owner" });
  });

  it("uses the same unavailable response for forbidden or missing files and bounds identifiers", async () => {
    const repository = { copy: vi.fn(async () => null), remove: vi.fn() };
    const POST = createSaveFileHandler({ repository, resolveAuth: auth.resolveAuth }, true);
    const hidden = await POST(request(), context);
    expect(hidden.status).toBe(404);
    const invalid = await POST(request(), { params: { attachmentId: "x".repeat(129) } });
    expect(invalid.status).toBe(404);
    expect(await invalid.json()).toEqual(await hidden.json());
    expect(repository.copy).toHaveBeenCalledOnce();
  });

  it("keeps a committed processing copy usable when the immediate worker kick fails", async () => {
    const repository = { copy: vi.fn(async () => ({ ...record, status: "processing" as const })), remove: vi.fn() };
    const kickProcessing = vi.fn(() => { throw new Error("worker unavailable"); });
    const POST = createSaveFileHandler({ kickProcessing, repository, resolveAuth: auth.resolveAuth }, false);
    expect((await POST(request(), context)).status).toBe(200);
    expect(kickProcessing).toHaveBeenCalledOnce();
  });

  it("removes only the authenticated owner's Library pin", async () => {
    const repository = { copy: vi.fn(), remove: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    const DELETE = createRemoveSavedFileHandler({ repository, resolveAuth: auth.resolveAuth });
    expect((await DELETE(request("DELETE", false), context)).status).toBe(401);
    expect(repository.remove).not.toHaveBeenCalled();
    expect((await DELETE(request("DELETE"), context)).status).toBe(204);
    expect((await DELETE(request("DELETE"), context)).status).toBe(404);
    expect(repository.remove).toHaveBeenCalledWith({ attachmentId: "source-file", userId: "library-owner" });
  });
});
