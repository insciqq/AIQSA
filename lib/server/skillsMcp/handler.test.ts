import { Client, StreamableHTTPClientTransport, type FetchLike } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAuthConfig } from "../auth/config";
import { createFixedWindowLoginRateLimiter } from "../auth/rateLimit";
import { SKILLS_MCP_TOOL_MAX_BYTES } from "../../contracts/skillsMcp";
import { createSkillsMcpHandler } from "./handler";
import type { SkillsStoreService } from "./service";

const endpoint = new URL("http://localhost:3000/mcp/skills");
const token = "fixture-skills-access-token";
const clients: Client[] = [];
function fixture(write = true) {
  let active = true;
  const service: SkillsStoreService = {
    list: vi.fn(async (authority) => { await authority.assertActive("read"); return { skills: [], nextCursor: null }; }),
    get: vi.fn(), download: vi.fn(), archive: vi.fn(),
    write: vi.fn(async (authority): Promise<Awaited<ReturnType<SkillsStoreService["write"]>>> => { await authority.assertActive("write"); return { outcome: "created", skillId: "fixture-skill", version: 1, bundleDigest: "a".repeat(64), libraryPath: "/?library=skills" }; }),
    delete: vi.fn(async (authority): Promise<Awaited<ReturnType<SkillsStoreService["delete"]>>> => { await authority.assertActive("write"); return { outcome: "deleted", skillId: "fixture-skill", version: 2, bundleDigest: null, libraryPath: "/?library=skills" }; })
  };
  const resolveAccessToken = vi.fn(async (candidate: string, resource?: string) =>
    active && candidate === token && resource === endpoint.href ? {
      capability: "skills:store" as const, resource, clientId: "fixture-client", userId: "fixture-owner",
      grantId: "fixture-grant", grantRevision: 1, tokenId: "fixture-token", familyId: "fixture-family",
      scopes: write ? ["skills:read", "skills:write"] : ["skills:read"], expiresAt: new Date(Date.now() + 60_000)
    } : null);
  const handler = createSkillsMcpHandler({ issuer: endpoint.origin, service, oauthService: { resolveAccessToken },
    limiter: createFixedWindowLoginRateLimiter({ maxAttempts: 1_000 }),
    getConfig: () => getAuthConfig({ AIQSA_APP_BASE_URL: endpoint.origin, AIQSA_AUTH_SESSION_SECRET: "fixture-skills-session-secret", NODE_ENV: "test" }) });
  return { service, handler, revoke() { active = false; } };
}
function request(path: string, body: unknown, authorization = true) {
  return new Request(new URL(path, endpoint), { method: "POST", headers: {
    host: endpoint.host, "content-type": "application/json", accept: "application/json, text/event-stream",
    ...(authorization ? { authorization: `Bearer ${token}` } : {})
  }, body: JSON.stringify(body) });
}
function downloadRequest(signal?: AbortSignal) {
  return new Request(new URL("/mcp/skills/bundle?skillId=fixture-skill&version=1", endpoint), {
    headers: { host: endpoint.host, authorization: `Bearer ${token}` }, signal
  });
}
const archiveResult = {
  bytes: Buffer.from("fixture archive"),
  descriptor: {
    id: "fixture-skill", version: 1, name: "fixture", description: "Fixture package",
    bundleDigest: "a".repeat(64), bundleByteSize: 15, fileCount: 0, archived: false,
    enabled: true, updatedAt: "2026-09-29T00:00:00.000Z", files: [],
    archive: { path: "/mcp/skills/bundle?skillId=fixture-skill&version=1", sha256: "b".repeat(64), byteSize: 15 }
  }
};
async function connect(handler: ReturnType<typeof createSkillsMcpHandler>, legacy: boolean) {
  const fetch: FetchLike = async (url, init) => {
    const req = new Request(url, init); const headers = new Headers(req.headers); headers.set("host", endpoint.host);
    return handler.POST(new Request(req, { headers }));
  };
  const client = new Client({ name: "skills-fixture", version: "1.0.0" }, {
    versionNegotiation: legacy ? { mode: "legacy" } : { mode: { pin: "2026-07-28" } }
  });
  await client.connect(new StreamableHTTPClientTransport(endpoint, { authProvider: { token: async () => token }, fetch }));
  clients.push(client); return client;
}
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });
describe("Skill store protocol and transfer boundary", () => {
  it.each([true, false])("exposes independent package operations and authenticated descriptors (legacy=%s)", async (legacy) => {
    const f = fixture(); const client = await connect(f.handler, legacy);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "list_skills", "get_skill", "download_skill", "create_skill", "update_skill", "delete_skill"
    ]);
    expect((await client.callTool({ name: "list_skills", arguments: {} })).structuredContent).toEqual({ skills: [], nextCursor: null });
    const descriptor = await client.callTool({ name: "create_skill", arguments: { operationKey: "fixture-operation-1" } });
    expect(descriptor.structuredContent).toMatchObject({ transfer: { path: "/mcp/skills/bundle", body: { operation: "create" } } });
    expect(JSON.stringify(descriptor)).not.toContain(token);
    expect(f.service.write).not.toHaveBeenCalled();
    const created = await client.callTool({ name: "create_skill", arguments: {
      operationKey: "fixture-operation-2", markdown: "---\nname: fixture\ndescription: Fixture package\n---\nDo fixture work.\n"
    } });
    expect(created.structuredContent).toMatchObject({ outcome: "created", version: 1 });
    expect(f.service.write).toHaveBeenCalledOnce();
  });
  it("denies writes for read-only grants and rejects revoked calls", async () => {
    const f = fixture(false); const client = await connect(f.handler, false);
    const rejected = await client.callTool({ name: "delete_skill", arguments: { operationKey: "fixture-delete-key", skillId: "skill", expectedVersion: 1 } });
    expect(rejected).toMatchObject({ isError: true, structuredContent: { code: "insufficient_scope" } });
    const upload = await f.handler.upload(request("/mcp/skills/bundle", {}));
    expect(upload.status).toBe(403);
    f.revoke();
    const revoked = await f.handler.POST(request("/mcp/skills", {})); expect(revoked.status).toBe(401);
  });
  it("authenticates before consuming package input and challenges the correct resource", async () => {
    const f = fixture();
    const response = await f.handler.upload(request("/mcp/skills/bundle", { private: "fixture" }, false));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource/mcp/skills");
    expect(f.service.write).not.toHaveBeenCalled();
  });
  it("rejects batches, oversize envelopes and hidden package settings", async () => {
    const f = fixture();
    expect((await f.handler.POST(request("/mcp/skills", []))).status).toBe(400);
    expect((await f.handler.POST(request("/mcp/skills", "x".repeat(SKILLS_MCP_TOOL_MAX_BYTES)))).status).toBe(413);
    const invalid = await f.handler.upload(request("/mcp/skills/bundle", { operation: "create", operationKey: "fixture-operation-1", enabled: false, files: [] }));
    expect(invalid.status).toBe(400); expect(f.service.write).not.toHaveBeenCalled();
  });
  it.each(["consume", "cancel", "abort"] as const)("holds download admission until the response ends by %s", async (terminal) => {
    const f = fixture();
    vi.mocked(f.service.archive).mockResolvedValue(archiveResult);
    const controller = new AbortController();
    const response = await f.handler.download(downloadRequest(controller.signal));
    try {
      expect(response.status).toBe(200);
      const denied = await f.handler.download(downloadRequest());
      expect(denied.status).toBe(429);
      expect(f.service.archive).toHaveBeenCalledOnce();
      if (terminal === "consume") expect(await response.text()).toBe("fixture archive");
      else if (terminal === "cancel") await response.body!.cancel();
      else controller.abort();
      const next = await f.handler.download(downloadRequest());
      try { expect(next.status).toBe(200); } finally { await next.body?.cancel(); }
    } finally { if (!response.bodyUsed) await response.body?.cancel(); }
  });
  it("releases download admission when archive preparation fails", async () => {
    const f = fixture();
    vi.mocked(f.service.archive).mockRejectedValueOnce(new Error("fixture storage unavailable")).mockResolvedValue(archiveResult);
    expect((await f.handler.download(downloadRequest())).status).toBe(503);
    const next = await f.handler.download(downloadRequest());
    try { expect(next.status).toBe(200); } finally { await next.body?.cancel(); }
  });
});
