import { afterEach, expect, it, vi } from "vitest";
import { SKILL_DESCRIPTION_MAX_LENGTH, SKILL_MAX_FILES, SKILL_NAME_MAX_LENGTH } from "../../lib/contracts/skills";
import { SKILLS_MCP_LIST_MAX, SKILLS_MCP_TOOL_MAX_BYTES, SKILLS_MCP_TOOL_RESPONSE_MAX_BYTES } from "../../lib/contracts/skillsMcp";
import { StoreSession } from "./auth";
import { callTool } from "./main";

afterEach(() => vi.unstubAllGlobals());

it.each(["unicode", "escaped"])("accepts a full maximum-length %s catalog through the bounded MCP client", async kind => {
  const value = kind === "unicode" ? "🧪" : "\u0001";
  const entry = {
    id: "x".repeat(128), name: value.repeat(SKILL_NAME_MAX_LENGTH), description: value.repeat(SKILL_DESCRIPTION_MAX_LENGTH),
    version: 2_147_483_647, bundleDigest: "f".repeat(64), fileCount: SKILL_MAX_FILES, bundleByteSize: 24 * 1024 * 1024,
    archived: false, enabled: true, updatedAt: new Date(0).toISOString()
  };
  const result = { skills: Array.from({ length: SKILLS_MCP_LIST_MAX }, () => ({ ...entry })), nextCursor: entry.id };
  const envelope = { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", id: 1, result: envelope }));
  expect(bytes).toBeGreaterThan(SKILLS_MCP_TOOL_MAX_BYTES);
  expect(bytes).toBeLessThan(SKILLS_MCP_TOOL_RESPONSE_MAX_BYTES);
  await expect(throughMcp("list_skills", { limit: SKILLS_MCP_LIST_MAX }, envelope)).resolves.toEqual(result);
});

it("accepts a full manifest while still rejecting an oversized response", async () => {
  const result = { id: "owned-skill", version: 1, files: Array.from({ length: SKILL_MAX_FILES + 1 }, (_, index) => ({
    path: index === 0 ? "SKILL.md" : `${"a".repeat(155)}/${String(index).padStart(3, "0")}${"🧪".repeat(24)}`,
    byteSize: 8 * 1024 * 1024, checksum: "f".repeat(64), executable: false
  })) };
  const envelope = { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  await expect(throughMcp("get_skill", { skillId: "owned-skill" }, envelope)).resolves.toEqual(result);
  await expect(throughMcp("get_skill", { skillId: "owned-skill" }, { content: [{ type: "text", text: "x".repeat(SKILLS_MCP_TOOL_RESPONSE_MAX_BYTES) }] })).rejects.toThrow("response_too_large");
});

async function throughMcp(name: string, args: Record<string, unknown>, envelope: object) {
  const origin = "https://aiqsa.example";
  const session = new StoreSession({ origin, scope: "skills:read", expiresAt: Date.now() + 60_000,
    tokens: { access_token: "synthetic-only", token_type: "Bearer" } }, "/unused-test-credentials");
  vi.stubGlobal("fetch", vi.fn(async (_value: unknown, init?: RequestInit) => {
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const request = JSON.parse(String(init?.body));
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (request.method === "initialize") return Response.json({ jsonrpc: "2.0", id: request.id, result: {
      protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "synthetic-skills", version: "1" }
    } });
    expect(request.method).toBe("tools/call");
    return Response.json({ jsonrpc: "2.0", id: request.id, result: envelope });
  }));
  return callTool(session, origin, name, args);
}
