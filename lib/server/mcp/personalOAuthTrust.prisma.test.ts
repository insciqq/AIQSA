import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { prisma } from "../prisma";
import { createPrismaMcpOAuthRepository } from "./oauthRepository";
import { mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import { createPrismaMcpRepository } from "./prismaRepository";

const key = Buffer.alloc(32, 11);
const userIds: string[] = [];
const serverIds: string[] = [];
const clientIds: string[] = [];
const draft: McpDraftConfiguration = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
  slots: [],
  source: { kind: "remote", url: "https://mcp.example.test/mcp" },
  transport: "streamable_http"
};
const redirectUri = (serverId: string) => `https://app.example.test/api/me/mcp/${serverId}/oauth/callback`;

afterEach(async () => {
  await prisma.mcpRuntimeGeneration.deleteMany({ where: { userServer: { serverId: { in: serverIds } } } });
  await prisma.mcpOAuthConnection.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpUserServer.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpGrant.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds.splice(0) } } });
  await prisma.mcpOAuthClient.deleteMany({ where: { id: { in: clientIds.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

async function user() {
  const created = await prisma.user.create({ data: {
    displayName: "Personal OAuth trust fixture", email: `mcp-oauth-trust-${randomUUID()}@example.test`, status: "active"
  } });
  userIds.push(created.id);
  return created.id;
}

function storage() {
  const validate = vi.fn(async () => ({
    kind: "ok" as const, evidence: { protocol: "fixture" }, resolvedArtifact: null,
    toolInventory: [{ name: "read", description: "Read fixture" }]
  }));
  return createPrismaMcpRepository({
    encryptionKey: () => key, prisma, draftValidator: { validate }, oauthRedirectUri: redirectUri
  });
}

describe("personal MCP OAuth trust persistence", () => {
  it("keeps personal rows off the installation update path", async () => {
    const ownerId = await user();
    const repository = storage();
    const created = await repository.createPersonalServer!({ description: "", draft, name: "Personal fixture", userId: ownerId, values: {} });
    if (created.kind !== "ok") throw new Error("fixture_create_failed");
    serverIds.push(created.value.id);
    await expect(repository.updateUserServer({
      enabled: false, installationOnly: true, serverId: created.value.id, userId: ownerId
    })).resolves.toEqual({ kind: "not_found" });
    await expect(repository.updateUserServer({
      enabled: false, personalOnly: true, serverId: created.value.id, userId: ownerId
    })).resolves.toMatchObject({ kind: "ok", value: { enabled: false } });
  });

  it("loads personal policies only for the personal route, derives the transport rule, and retires a rejected client", async () => {
    const ownerId = await user();
    const repository = storage();
    const created = await repository.createPersonalServer!({ description: "", draft: {
      ...draft, auth: { mode: "oauth", allowedAuthorizationServerOrigins: ["https://auth.example.test"], scopes: [] }
    }, name: "OAuth fixture", userId: ownerId, values: {} });
    if (created.kind !== "ok") throw new Error("fixture_create_failed");
    const serverId = created.value.id;
    serverIds.push(serverId);
    const oauth = createPrismaMcpOAuthRepository({ encryptionKey: () => key, prisma });
    const query = { purpose: "user" as const, redirectUri: redirectUri(serverId), serverId, userId: ownerId };
    await expect(oauth.loadPolicy({ ...query, sourceKind: "installation" })).resolves.toBeNull();
    const policy = await oauth.loadPolicy({ ...query, sourceKind: "personal" });
    expect(policy).toMatchObject({ personal: true });
    if (!policy) throw new Error("fixture_policy_missing");

    const registrationKey = randomUUID();
    const client = await oauth.saveClient({
      clientInformation: { client_id: `fixture-${randomUUID()}` }, clientMetadata: { redirect_uris: [query.redirectUri] },
      registrationKey, discoveryState: { authorizationServerUrl: "https://auth.example.test" }
    });
    clientIds.push(client.id);
    const connection = await oauth.createConnection({ ...query, clientId: client.clientInformation.client_id,
      configurationIdentity: policy.configurationIdentity, externalAccountLabel: null, oauthClientId: client.id,
      policyFingerprint: mcpOAuthPolicyFingerprint(policy, client.clientInformation.client_id), resource: policy.resource,
      tokens: { access_token: "synthetic-trust-access", token_type: "Bearer" }
    });
    if (connection.kind !== "ok") throw new Error("fixture_authorization_failed");
    await expect(oauth.loadConnection(connection.value.id)).resolves.toMatchObject({ policy: { personal: true } });

    await expect(oauth.retireClient({ clientId: client.clientInformation.client_id, id: client.id, registrationKey }))
      .resolves.toBe(true);
    await expect(oauth.findClient(registrationKey)).resolves.toBeNull();
    // Existing connections keep their client for revocation.
    await expect(oauth.loadConnection(connection.value.id)).resolves.toMatchObject({ client: { id: client.id } });
  });
});
