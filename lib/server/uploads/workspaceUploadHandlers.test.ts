// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config as proxyConfig } from "@/proxy";
import { createWorkspaceUploadHandlers, type UploadRouteContext } from "./workspaceUploadHandlers";
import { WorkspaceUploadService, decodeWorkspaceUploadCreate } from "./workspaceUploadService";
import type { WorkspaceUploadRepository } from "./workspaceUploadRepository";
import { WORKSPACE_UPLOAD_MAX_BYTES } from "@/lib/contracts/workspaceUploads";
import { workspaceUploadMaxBytes } from "./workspaceUploadConfig";

const context = { params: Promise.resolve({ uploadId: "owned-session", partNumber: "1" }) } satisfies UploadRouteContext;
const input = { byteSize: 512 * 1024 * 1024, fileName: "data.bin", mimeType: "application/octet-stream", projectId: null, idempotencyKey: "idempotency-key-123" };

describe("Workspace upload HTTP admission", () => {
  it("preserves safe error codes across the instrumentation and route bundles", async () => {
    vi.resetModules();
    const { WorkspaceUploadError: OtherBundleError } = await import("./workspaceUploadRepository");
    const service = { config: async () => { throw new OtherBundleError("upload_busy", 429); } } as unknown as WorkspaceUploadService;
    const handlers = createWorkspaceUploadHandlers({ resolveAuth: vi.fn().mockResolvedValue({ userId: "owner" }), service });
    const response = await handlers.config(new Request("http://localhost/api/uploads/sessions"));
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: "upload_busy" });
  });
  it("bypasses cloning only for part routes and keeps adjacent routes under Proxy", () => {
    expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url: "/api/uploads/sessions/owned-session/parts/1" })).toBe(false);
    for (const url of ["/api/uploads", "/api/uploads/sessions", "/api/uploads/sessions/owned-session/complete", "/api/uploads/sessions/owned-session/parts/1/extra", "/api/me/knowledge-uploads/base/batch/item/content"]) {
      expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url })).toBe(true);
    }
  });
  it.each(["origin", "auth"])("rejects %s before requesting any upload bytes or storage", async reason => {
    let reads = 0;
    const service = { part: vi.fn() } as unknown as WorkspaceUploadService;
    const resolveAuth = vi.fn().mockResolvedValue(null);
    const handlers = createWorkspaceUploadHandlers({ resolveAuth, service, env: { AIQSA_APP_BASE_URL: "http://localhost" } });
    const request = new Request("http://localhost/api/uploads/sessions/owned-session/parts/1", {
      method: "PUT", headers: { origin: reason === "origin" ? "https://other.example" : "http://localhost" },
      body: new ReadableStream({ pull() { reads += 1; } }, { highWaterMark: 0 }), duplex: "half"
    } as RequestInit);
    const result = await handlers.part(request, context);
    expect(result.status).toBe(reason === "origin" ? 403 : 401);
    expect(reads).toBe(0); expect(service.part).not.toHaveBeenCalled();
    expect(result.headers.get("x-content-type-options")).toBe("nosniff");
    expect(result.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects 512 MiB + 1 before runtime/storage and validates metadata", async () => {
    const repository = { create: vi.fn() } as unknown as WorkspaceUploadRepository;
    const available = vi.fn();
    const service = new WorkspaceUploadService({ repository, available, storage: { getObject: vi.fn(), putObject: vi.fn(), deleteObject: vi.fn() } });
    expect(decodeWorkspaceUploadCreate(input)).toEqual(input);
    expect(decodeWorkspaceUploadCreate({ ...input, secret: true })).toBeNull();
    await expect(service.create({ ...input, byteSize: WORKSPACE_UPLOAD_MAX_BYTES + 1 }, "owner")).rejects.toMatchObject({ code: "file_too_large", status: 413 });
    expect(available).not.toHaveBeenCalled(); expect(repository.create).not.toHaveBeenCalled();
    expect(workspaceUploadMaxBytes({})).toBe(WORKSPACE_UPLOAD_MAX_BYTES);
    expect(workspaceUploadMaxBytes({ AIQSA_WORKSPACE_UPLOAD_MAX_BYTES: "1024" })).toBe(1024);
    expect(() => workspaceUploadMaxBytes({ AIQSA_WORKSPACE_UPLOAD_MAX_BYTES: "invalid" })).toThrow("workspace_upload_config_invalid");
  });
});
