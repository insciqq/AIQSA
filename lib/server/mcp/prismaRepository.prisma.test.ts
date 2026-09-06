import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdminMcpServer, McpDraftConfiguration } from "@/lib/contracts/mcp";
import { prisma } from "../prisma";
import { hashCanonicalMcpValue } from "./definitions";
import { buildMcpOAuthPolicy, mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import type { McpDraftValidationInput, McpDraftValidationOutcome } from "./draftValidator";
import { createPrismaMcpRepository } from "./prismaRepository";

const userIds: string[] = [];
const serverIds: string[] = [];
const clientIds: string[] = [];
const valid: McpDraftValidationOutcome = {
  evidence: { protocol: "fixture" }, kind: "ok", resolvedArtifact: null,
  toolInventory: [{ name: "search", description: "Search records" }, { name: "write", description: "Write records" }]
};
const draft: McpDraftConfiguration = {
  auth: { mode: "static" },
  runtime: { callTimeoutMs: 60000, startupTimeoutMs: 60000 },
  slots: [{
    label: "API key", policy: { kind: "shared", allowPersonalOverride: false }, sensitive: true,
    slotKey: "api_key", target: { kind: "header", name: "X-Api-Key" }, valueType: "secret"
  }],
  source: { kind: "remote", url: "https://mcp.example.test/mcp" }, transport: "streamable_http"
};

afterEach(async () => {
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds.splice(0) } } });
  await prisma.mcpOAuthClient.deleteMany({ where: { id: { in: clientIds.splice(0) } } });
});

async function admin() {
  const user = await prisma.user.create({ data: {
    displayName: "MCP fixture admin", email: `mcp-${randomUUID()}@example.test`, role: "admin", status: "active"
  } });
  userIds.push(user.id);
  return user.id;
}

async function fixture() {
  const userId = await admin();
  const validate = vi.fn(async (_input: McpDraftValidationInput): Promise<McpDraftValidationOutcome> => valid);
  const redirectUri = (id: string) => `https://app.example.test/api/admin/mcp/${id}/oauth/validation/callback`;
  const repository = createPrismaMcpRepository({
    prisma, draftValidator: { validate }, encryptionKey: () => Buffer.alloc(32, 1), oauthValidationRedirectUri: redirectUri
  });
  const created = await repository.createServer({
    description: "Test & Save fixture", draft, name: `Tools ${randomUUID()}`, sharedValues: { api_key: "fixture-initial-key" }
  });
  if (created.kind !== "ok") throw new Error(`fixture_create_${created.kind}`);
  const serverId = created.value.id;
  serverIds.push(serverId);
  const save = (server: AdminMcpServer, sharedValues?: Record<string, string>) => repository.testDraft({
    expectedUpdatedAt: server.updatedAt, oneTimeValues: {}, publish: true, serverId, sharedValues, validationUserId: userId
  });
  const activated = await save(created.value);
  if (activated.kind !== "ok") throw new Error(`fixture_publish_${activated.kind}`);
  return { redirectUri, repository, save, server: activated.value, serverId, userId, validate };
}

describe("MCP Test & Save persistence", () => {
  it("publishes the validated tool selection and shared values together, preserving disabled availability", async () => {
    const { repository, save, server, serverId, validate } = await fixture();
    const staged = await repository.updateServer({
      draft: { ...draft, disabledToolNames: ["write"] }, enabled: false,
      expectedUpdatedAt: server.updatedAt, serverId
    });
    if (staged.kind !== "ok") throw new Error(staged.kind);
    expect(staged.value.activeRevision?.id).toBe(server.activeRevision?.id);
    const published = await save(staged.value, { api_key: "fixture-replacement-key" });
    expect(published.kind).toBe("ok");
    if (published.kind !== "ok") return;
    expect(published.value.enabled).toBe(false);
    expect(published.value.activeRevision?.disabledToolNames).toEqual(["write"]);
    expect(published.value.activeRevision?.id).not.toBe(server.activeRevision?.id);
    expect(published.value.revisions).toHaveLength(2);
    expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({ values: { api_key: "fixture-replacement-key" } }));
    const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(stored.sharedConfigVersion).toBe(2);
    expect(JSON.stringify(published.value)).not.toContain("fixture-replacement-key");
    expect(stored.sharedConfigEnvelope).not.toContain("fixture-replacement-key");
  });

  it("keeps the active revision and shared credentials when validation fails", async () => {
    const { repository, save, server, serverId, validate } = await fixture();
    const before = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    const staged = await repository.updateServer({ draft: { ...draft, disabledToolNames: ["write"] }, serverId });
    if (staged.kind !== "ok") throw new Error(staged.kind);
    validate.mockResolvedValueOnce({ kind: "invalid", issues: [{ code: "mcp_oauth_validation_deferred", path: "auth.mode" }] });
    expect(await save(staged.value, { api_key: "fixture-rejected-key" })).toMatchObject({ kind: "draft_validation_failed" });
    const after = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(after.activeRevisionId).toBe(server.activeRevision?.id);
    expect(after.sharedConfigEnvelope).toBe(before.sharedConfigEnvelope);
    expect(after.sharedConfigVersion).toBe(before.sharedConfigVersion);
    expect(after.draft).toMatchObject({ disabledToolNames: ["write"] });
    expect(await prisma.mcpRevision.count({ where: { serverId } })).toBe(1);
  });

  it.each(["draft", "credentials", "admin"] as const)("rejects publication after %s changes during validation", async (change) => {
    const { repository, save, server, serverId, userId, validate } = await fixture();
    const before = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    validate.mockImplementationOnce(async () => {
      if (change === "admin") await prisma.user.update({ data: { role: "user" }, where: { id: userId } });
      else await repository.updateServer({
        serverId, ...(change === "draft" ? { draft: { ...draft, disabledToolNames: ["search"] } } : { sharedValues: { api_key: "fixture-concurrent-key" } })
      });
      return valid;
    });
    expect(await save(server, { api_key: "fixture-stale-key" })).toMatchObject({ kind: change === "admin" ? "invalid_values" : "draft_changed" });
    const after = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(after.activeRevisionId).toBe(before.activeRevisionId);
    expect(after.sharedConfigVersion).toBe(before.sharedConfigVersion + (change === "credentials" ? 1 : 0));
    expect(await prisma.mcpRevision.count({ where: { serverId } })).toBe(1);
  });

  it("rejects an obsolete editor before replacing the candidate or contacting MCP", async () => {
    const { repository, save, server, serverId, validate } = await fixture();
    await repository.updateServer({ name: "Newer name", serverId });
    expect(await repository.updateServer({ name: "Old editor", expectedUpdatedAt: server.updatedAt, serverId })).toEqual({ kind: "draft_changed" });
    expect(await save(server)).toEqual({ kind: "draft_changed" });
    expect(validate).toHaveBeenCalledTimes(1);
    expect((await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).displayName).toBe("Newer name");
  });

  it("projects only the current administrator's matching validation connection", async () => {
    const { repository, redirectUri, serverId, userId } = await fixture();
    const otherId = await admin();
    const oauthDraft: McpDraftConfiguration = {
      ...draft, slots: [], auth: { mode: "oauth", allowedAuthorizationServerOrigins: ["https://auth.example.test"], scopes: [] }
    };
    await repository.updateServer({ draft: oauthDraft, serverId });
    const client = await prisma.mcpOAuthClient.create({ data: {
      clientId: "fixture-client", clientMetadata: {}, registrationKey: randomUUID()
    } });
    clientIds.push(client.id);
    for (const id of [userId, otherId]) {
      const policy = buildMcpOAuthPolicy({
        configurationIdentity: hashCanonicalMcpValue(oauthDraft), draft: oauthDraft,
        purpose: "validation", redirectUri: redirectUri(serverId), serverId, userId: id
      });
      await prisma.mcpOAuthConnection.create({ data: {
        externalAccountLabel: id === userId ? "Current admin" : "Other admin",
        oauthClientId: client.id, policyFingerprint: mcpOAuthPolicyFingerprint(policy, client.clientId),
        purpose: "validation", serverId, userId: id, state: id === userId ? "reauthorization_required" : "ready"
      } });
    }
    const own = (await repository.listAdminServers(userId)).find((row) => row.id === serverId)!;
    expect(own.validationOAuth).toMatchObject({ accountLabel: "Current admin", state: "reauthorization_required" });
    expect(JSON.stringify(own)).not.toContain("Other admin");
    expect((await repository.listAdminServers(otherId)).find((row) => row.id === serverId)?.validationOAuth?.state).toBe("ready");
    expect((await repository.listAdminServers()).find((row) => row.id === serverId)?.validationOAuth).toBeNull();
  });

  it("reports current failed runtimes and ignores failures that are no longer desired", async () => {
    const { repository, server, serverId, userId } = await fixture();
    const preference = await prisma.mcpUserServer.create({ data: { serverId, userId, enabled: true } });
    const runtime = await prisma.mcpRuntimeGeneration.create({ data: {
      fingerprint: randomUUID(), revisionId: server.activeRevision!.id, userServerId: preference.id,
      state: "failed", errorCode: "mcp_oauth_reauthorization_required"
    } });
    await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: runtime.id }, where: { id: preference.id } });
    expect((await repository.listAdminServers(userId)).find((row) => row.id === serverId)?.runtimeProblem).toBe("reauthorization_required");
    await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: null }, where: { id: preference.id } });
    expect((await repository.listAdminServers(userId)).find((row) => row.id === serverId)?.runtimeProblem).toBeNull();
  });
});
