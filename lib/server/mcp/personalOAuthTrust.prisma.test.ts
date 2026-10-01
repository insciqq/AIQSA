import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpDraftConfiguration } from "@/lib/contracts/mcp";
import { prisma } from "../prisma";
import { createPrismaMcpOAuthRepository } from "./oauthRepository";
import { mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import { McpOAuthService } from "./oauthService";
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
const oauthDraft: McpDraftConfiguration = {
  ...draft, auth: { mode: "oauth", allowedAuthorizationServerOrigins: ["https://auth.example.test"], scopes: [] }
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

/** An enabled installation OAuth server with an active revision and a use grant. */
async function installationServer(granteeId: string) {
  const server = await prisma.mcpServer.create({ data: {
    displayName: "Installation OAuth fixture", enabled: true, namespace: `oauth-trust-${randomUUID()}`
  } });
  serverIds.push(server.id);
  const revision = await prisma.mcpRevision.create({ data: {
    configuration: oauthDraft, draftHash: randomUUID(), identityHash: randomUUID(), revisionNumber: 1,
    serverId: server.id, validationEvidence: {}
  } });
  await prisma.mcpServer.update({ data: { activeRevisionId: revision.id }, where: { id: server.id } });
  await prisma.mcpGrant.create({ data: { canUse: true, serverId: server.id, userId: granteeId } });
  return server.id;
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
    const created = await repository.createPersonalServer!({ description: "", draft: oauthDraft, name: "OAuth fixture", userId: ownerId, values: {} });
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
  it("answers wrong-kind and foreign ids with no policy through the real owner filter", async () => {
    const callerId = await user();
    const otherId = await user();
    const installationId = await installationServer(callerId);
    const foreign = await storage().createPersonalServer!({ description: "", draft: oauthDraft, name: "Foreign OAuth fixture", userId: otherId, values: {} });
    if (foreign.kind !== "ok") throw new Error("fixture_create_failed");
    serverIds.push(foreign.value.id);
    // The database fence refuses a stray grant that would expose another user's personal server.
    await expect(prisma.mcpGrant.create({ data: { canUse: true, serverId: foreign.value.id, userId: callerId } })).rejects.toThrow();
    const oauth = createPrismaMcpOAuthRepository({ encryptionKey: () => key, prisma });
    const query = (serverId: string) => ({ purpose: "user" as const, redirectUri: redirectUri(serverId), serverId, userId: callerId });

    await expect(oauth.loadPolicy({ ...query(installationId), sourceKind: "personal" })).resolves.toBeNull();
    const installation = await oauth.loadPolicy({ ...query(installationId), sourceKind: "installation" });
    expect(installation).toMatchObject({ serverId: installationId });
    expect(installation).not.toHaveProperty("personal");
    await expect(oauth.loadPolicy({ ...query(foreign.value.id), sourceKind: "personal" })).resolves.toBeNull();
    await expect(oauth.loadPolicy({ ...query(foreign.value.id), sourceKind: "installation" })).resolves.toBeNull();
    await expect(oauth.loadPolicy(query(foreign.value.id))).resolves.toBeNull();

    // The service maps a missing policy to the privacy-neutral code before any network I/O.
    const fetch = vi.fn();
    const service = new McpOAuthService({ fetchForPolicy: () => fetch, repository: oauth });
    for (const [serverId, sourceKind] of [[installationId, "personal"], [foreign.value.id, "personal"]] as const) {
      await expect(service.startAuthorization({ ...query(serverId), forceReconnect: false, sourceKind, state: "fixture-state" }))
        .rejects.toMatchObject({ code: "mcp_oauth_not_available" });
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
