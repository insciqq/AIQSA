import { describe, expect, it, vi } from "vitest";
import { createGetMcpCallDetailsHandler } from "./callDetailsHandler";
import type { RequestAuthResolver } from "../auth/requestAuth";
import { mcpDisplaySection } from "./callDetails";

const params = { runId: "run-1", roundIndex: "1", ordinal: "0" };
const resolveAuth = vi.fn(async () => ({ userId: "initiator", user: { id: "initiator", role: "user", status: "active" } })) as unknown as RequestAuthResolver;
const details = { request: mcpDisplaySection('{"input":"private synthetic"}'), requestState: "available" as const,
  response: mcpDisplaySection("synthetic result"), responseState: "available" as const, isError: false, unsupportedContentTypes: [] };
const request = () => new Request("http://localhost/api/model-runs/run-1/mcp-calls/1/0");

describe("authorized MCP detail GET", () => {
  it("requires authentication before loading persisted content", async () => {
    const read = vi.fn();
    const response = await createGetMcpCallDetailsHandler({ resolveAuth: async () => null, read })(request(), { params: Promise.resolve(params) });
    expect(response.status).toBe(401); expect(read).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it.each([{ ...params, ordinal: "-1" }, { ...params, roundIndex: "1.0" }, { ...params, ordinal: "99999999999" }, { ...params, runId: "../private" }])("refuses malformed coordinates neutrally", async value => {
    const read = vi.fn();
    const response = await createGetMcpCallDetailsHandler({ resolveAuth, read })(request(), { params: Promise.resolve(value) });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "chat_not_found" }); expect(read).not.toHaveBeenCalled();
  });
  it("uses only authenticated initiator identity and returns a private noncached projection", async () => {
    const read = vi.fn(async () => details);
    const response = await createGetMcpCallDetailsHandler({ resolveAuth, read })(request(), { params: Promise.resolve(params) });
    expect(read).toHaveBeenCalledWith({ runId: "run-1", roundIndex: 1, ordinal: 0, userId: "initiator" }, expect.any(AbortSignal));
    expect(response.status).toBe(200); expect(await response.json()).toEqual(details);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
  it("uses one privacy-neutral not-found result for every repository refusal", async () => {
    const response = await createGetMcpCallDetailsHandler({ resolveAuth, read: async () => null })(request(), { params: Promise.resolve(params) });
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: "chat_not_found" });
  });
  it("returns a retryable content-free failure without logging bodies or secret exceptions", async () => {
    const log = vi.spyOn(console, "log"), error = vi.spyOn(console, "error");
    try {
      const response = await createGetMcpCallDetailsHandler({ resolveAuth, read: async () => { throw new Error("PRIVATE_RAW_REQUEST_RESPONSE_SECRET"); } })
        (request(), { params: Promise.resolve(params) });
      expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: "mcp_call_details_unavailable" });
      expect(log).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled();
    } finally { log.mockRestore(); error.mockRestore(); }
  });
});
