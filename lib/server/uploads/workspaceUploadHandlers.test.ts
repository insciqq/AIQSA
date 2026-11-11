// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config as proxyConfig } from "@/proxy";
import { createWorkspaceUploadHandlers, type UploadRouteContext } from "./workspaceUploadHandlers";
import { WorkspaceUploadService, decodeWorkspaceUploadCreate } from "./workspaceUploadService";
import { WorkspaceUploadError, type WorkspaceUploadRepository } from "./workspaceUploadRepository";
import { WORKSPACE_UPLOAD_MAX_BYTES } from "@/lib/contracts/workspaceUploads";
import { workspaceUploadMaxBytes } from "./workspaceUploadConfig";

const context = { params: Promise.resolve({ uploadId: "owned-session", partNumber: "1" }) } satisfies UploadRouteContext;
const input = { byteSize: 512 * 1024 * 1024, fileName: "data.bin", mimeType: "application/octet-stream", idempotencyKey: "idempotency-key-123" };

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
    for (const url of ["/api/uploads", "/api/uploads/sessions", "/api/uploads/sessions/owned-session/complete", "/api/uploads/sessions/owned-session/parts/1/extra"]) {
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
    // An older browser names no Project with an explicit null; a Project is never accepted.
    expect(decodeWorkspaceUploadCreate({ ...input, projectId: null })).toEqual(input);
    expect(decodeWorkspaceUploadCreate({ ...input, projectId: "project-1" })).toBeNull();
    await expect(service.create({ ...input, byteSize: WORKSPACE_UPLOAD_MAX_BYTES + 1 }, "owner")).rejects.toMatchObject({ code: "file_too_large", status: 413 });
    expect(available).not.toHaveBeenCalled(); expect(repository.create).not.toHaveBeenCalled();
    expect(workspaceUploadMaxBytes({})).toBe(WORKSPACE_UPLOAD_MAX_BYTES);
    expect(workspaceUploadMaxBytes({ AIQSA_WORKSPACE_UPLOAD_MAX_BYTES: "1024" })).toBe(1024);
    expect(() => workspaceUploadMaxBytes({ AIQSA_WORKSPACE_UPLOAD_MAX_BYTES: "invalid" })).toThrow("workspace_upload_config_invalid");
  });
});

describe("Workspace upload refusal records", () => {
  const PRIVATE_NAME = "PRIVATE-name-canary.bin";
  const env = { AIQSA_APP_BASE_URL: "http://localhost" };
  const owner = () => vi.fn().mockResolvedValue({ userId: "owner" });

  async function refusalRecords(run: () => Promise<Response>) {
    const writer = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const response = await run();
      const lines = writer.mock.calls.map(([chunk]) => String(chunk));
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((record) => record.event === "upload_refused");
      return { lines, records, response };
    } finally {
      writer.mockRestore();
    }
  }

  function createRequest(body: string): Request {
    return new Request("http://localhost/api/uploads/sessions", { body, headers: { origin: "http://localhost" }, method: "POST" });
  }

  function partRequest(headers: Record<string, string> = {}): Request {
    return new Request("http://localhost/api/uploads/sessions/owned-session/parts/1", {
      body: "bytes", headers: { origin: "http://localhost", "content-length": "5", ...headers }, method: "PUT"
    });
  }

  function realService(repository: Partial<WorkspaceUploadRepository> = {}) {
    return new WorkspaceUploadService({ available: async () => true, repository: repository as WorkspaceUploadRepository,
      storage: { getObject: vi.fn(), putObject: vi.fn(), deleteObject: vi.fn() } });
  }

  const cases: Array<{
    label: string; code: string; status: number; operation: string; fields?: Record<string, unknown>; level?: string;
    run: () => Promise<Response>;
  }> = [
    {
      label: "a cross-site mutation", code: "invalid_origin", status: 403, operation: "session_create", fields: { stage: "origin" },
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service: realService() }).create(
        new Request("http://localhost/api/uploads/sessions", { body: "{}", headers: { origin: "https://other.example" }, method: "POST" }))
    },
    {
      label: "an unauthenticated request", code: "unauthorized", status: 401, operation: "session_part", fields: { stage: "auth" },
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: vi.fn().mockResolvedValue(null), service: realService() }).part(partRequest(), context)
    },
    {
      label: "an unreadable create body", code: "upload_invalid", status: 400, operation: "session_create", fields: { stage: "body" },
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service: realService() }).create(createRequest(`{"fileName":"${PRIVATE_NAME}"`))
    },
    {
      label: "an oversized create body", code: "request_body_too_large", status: 413, operation: "session_create", fields: { stage: "body" },
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service: realService() }).create(
        createRequest(JSON.stringify({ ...input, fileName: `${PRIVATE_NAME}${"x".repeat(5000)}` })))
    },
    {
      label: "a declared size over the limit", code: "file_too_large", status: 413, operation: "session_create",
      fields: { mime_family: "application", size_class: "over_512mb" },
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service: realService() }).create(
        createRequest(JSON.stringify({ ...input, byteSize: WORKSPACE_UPLOAD_MAX_BYTES + 1, fileName: PRIVATE_NAME })))
    },
    {
      label: "a part number out of range", code: "upload_invalid_part", status: 400, operation: "session_part",
      fields: { size_class: "to_1mb" },
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service: realService() }).part(partRequest(),
        { params: Promise.resolve({ uploadId: "owned-session", partNumber: "0" }) })
    },
    {
      label: "busy part capacity", code: "upload_busy", status: 429, operation: "session_part",
      run: async () => {
        const service = { part: vi.fn(async () => { throw new WorkspaceUploadError("upload_busy", 429); }) } as unknown as WorkspaceUploadService;
        const response = await createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service }).part(partRequest(), context);
        expect(response.headers.get("retry-after")).toBe("2");
        return response;
      }
    },
    {
      label: "an incomplete session", code: "upload_incomplete", status: 409, operation: "session_complete",
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service: { complete: vi.fn(async () => {
        throw new WorkspaceUploadError("upload_incomplete");
      }) } as unknown as WorkspaceUploadService }).complete(
        new Request("http://localhost/api/uploads/sessions/owned-session/complete", { headers: { origin: "http://localhost" }, method: "POST" }), context)
    },
    {
      label: "an unknown session", code: "upload_not_found", status: 404, operation: "session_status",
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service: realService() }).get(
        new Request("http://localhost/api/uploads/sessions/bad"), { params: Promise.resolve({ uploadId: "bad id" }) })
    },
    {
      label: "an unexpected failure", code: "upload_unavailable", status: 503, operation: "session_cancel", level: "error",
      fields: { error_class: "Error" },
      run: () => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service: { cancel: vi.fn(async () => {
        throw new Error(`PRIVATE failure for ${PRIVATE_NAME}`);
      }) } as unknown as WorkspaceUploadService }).cancel(
        new Request("http://localhost/api/uploads/sessions/owned-session", { headers: { origin: "http://localhost" }, method: "DELETE" }), context)
    }
  ];

  it.each(cases)("logs one content-free record for $label ($code)", async ({ code, fields, level, operation, run, status }) => {
    const { lines, records, response } = await refusalRecords(run);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: code });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ code, event: "upload_refused", httpStatus: status, level: level ?? "warn", operation, ...fields });
    expect(lines.join("")).not.toContain("PRIVATE");
    expect(lines.join("")).not.toContain("application/octet-stream");
    expect(lines.join("")).not.toContain("owned-session");
  });

  it("logs a part the client cancelled at info, without an error projection", async () => {
    const abort = new AbortController();
    const service = { part: vi.fn(async () => { abort.abort(); throw new Error(`PRIVATE aborted ${PRIVATE_NAME}`); }) } as unknown as WorkspaceUploadService;
    const request = new Request(partRequest(), { signal: abort.signal });
    const { lines, records, response } = await refusalRecords(() => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service })
      .part(request, context));

    expect(response.status).toBe(503);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ client_aborted: true, code: "upload_unavailable", level: "info", operation: "session_part" });
    expect(records[0]).not.toHaveProperty("error_class");
    expect(lines.join("")).not.toContain("PRIVATE");
  });

  it("logs nothing for an accepted request", async () => {
    const service = { get: vi.fn(async () => ({ id: "owned-session" })) } as unknown as WorkspaceUploadService;
    const { records, response } = await refusalRecords(() => createWorkspaceUploadHandlers({ env, resolveAuth: owner(), service })
      .get(new Request("http://localhost/api/uploads/sessions/owned-session"), context));

    expect(response.status).toBe(200);
    expect(records).toEqual([]);
  });
});
