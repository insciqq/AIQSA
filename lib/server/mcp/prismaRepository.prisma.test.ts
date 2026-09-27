import { loadMcpCapabilityCatalog, loadMcpRunPlanRecordsForServers, loadMcpRunPlanRecordsForProjectServers } from "./runPlanRepository";
import { prepareMcpRunPlan } from "./runPlan";
import { filterMcpToolsForUser } from "./toolAccess";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adminMcpAttention, MCP_INVENTORY_EXCLUSION_LIMIT, type AdminMcpServer, type McpDraftConfiguration } from "@/lib/contracts/mcp";
import { prisma } from "../prisma";
import { hashCanonicalMcpValue, mcpPublishedToolDefinitions, mcpToolDefinitionEvidence } from "./definitions";
import { buildMcpOAuthPolicy, mcpOAuthPolicyFingerprint } from "./oauthPolicy";
import type { McpDraftValidationInput, McpDraftValidationOutcome } from "./draftValidator";
import { createPrismaMcpRepository } from "./prismaRepository";
import { createPrismaMcpOAuthRepository } from "./oauthRepository";
import { McpOAuthService } from "./oauthService";
import { createPrismaMcpRuntimeRepository, remoteRuntimeCandidate } from "./runtimeRepository";
import { decryptMcpEnvelope, encryptMcpEnvelope, mcpPersonalConfigEnvelopeContext } from "./encryption";

const userIds: string[] = [];
const groupIds: string[] = [];
const serverIds: string[] = [];
const clientIds: string[] = [];
const valid: Extract<McpDraftValidationOutcome, { kind: "ok" }> = {
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
  await prisma.group.deleteMany({ where: { id: { in: groupIds.splice(0) } } });
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

async function correctionFixture() {
  const base = await fixture();
  const origin = "https://git-tools.example.test";
  const endpoint = `${origin}/api/v4/mcp`;
  const pending: McpDraftConfiguration = {
    ...draft, slots: [], auth: { mode: "oauth", scopes: ["mcp"], allowedAuthorizationServerOrigins: [] },
    source: { kind: "remote", url: `${origin}/`, allowPrivateNetwork: true }
  };
  await base.repository.updateServer({ serverId: base.serverId, draft: pending });
  const oauth = createPrismaMcpOAuthRepository({ prisma, encryptionKey: () => Buffer.alloc(32, 1) });
  const redirectUri = base.redirectUri(base.serverId);
  const policy = await oauth.prepareValidationPolicy({ serverId: base.serverId, userId: base.userId, redirectUri });
  if (!policy) throw new Error("fixture_policy_missing");
  const client = await oauth.saveClient({
    clientInformation: { client_id: `fixture-${randomUUID()}` }, clientMetadata: { redirect_uris: [redirectUri] },
    registrationKey: randomUUID(), discoveryState: {
      authorizationServerUrl: origin,
      resourceMetadata: { resource: endpoint, authorization_servers: [origin], scopes_supported: ["mcp"] }
    }
  });
  clientIds.push(client.id);
  const created = await oauth.createConnection({
    clientId: client.clientInformation.client_id, oauthClientId: client.id,
    configurationIdentity: policy.configurationIdentity, externalAccountLabel: null,
    policyFingerprint: mcpOAuthPolicyFingerprint(policy, client.clientInformation.client_id),
    purpose: "validation", redirectUri, resource: endpoint, serverId: base.serverId, userId: base.userId,
    tokens: { access_token: "fixture-validation-token", token_type: "Bearer", scope: "mcp" }
  });
  if (created.kind !== "ok") throw new Error(created.kind);
  const connection = created.value;
  const outcome: McpDraftValidationOutcome = {
    ...valid, kind: "ok", evidence: { endpointCorrection: { kind: "gitlab", endpoint } },
    endpointCorrection: { kind: "gitlab", fromUrl: `${origin}/`, toUrl: endpoint, oauthBinding: {
      connectionId: connection.id, tokenVersion: connection.tokenVersion, policyFingerprint: connection.policyFingerprint
    } }
  };
  base.validate.mockResolvedValue(outcome);
  const current = await prisma.mcpServer.findUniqueOrThrow({ where: { id: base.serverId } });
  return { ...base, oauth, connection, pending, endpoint, outcome, expectedUpdatedAt: current.updatedAt.toISOString() };
}

describe("atomic MCP endpoint correction", () => {
  it.each(["test_save", "activation"] as const)("publishes the checked URL and validation binding together through %s", async (mode) => {
    const f = await correctionFixture();
    const oldRevision = await prisma.mcpRevision.findUniqueOrThrow({ where: { id: f.server.activeRevision!.id } });
    if (mode === "test_save") {
      expect(await f.repository.testDraft({ serverId: f.serverId, expectedUpdatedAt: f.expectedUpdatedAt, oneTimeValues: {}, publish: true, validationUserId: f.userId })).toMatchObject({ kind: "ok" });
    } else {
      expect(await f.repository.requestActivation({ serverId: f.serverId, validationUserId: f.userId })).toMatchObject({ kind: "ok" });
      const claim = await f.repository.claimActivation({ now: new Date(), staleBefore: new Date(0) });
      if (!claim || claim.serverId !== f.serverId || f.outcome.kind !== "ok") throw new Error("fixture_claim_missing");
      await f.repository.advanceActivation({ id: claim.id, leaseId: claim.leaseId, now: new Date(), stage: "publishing" });
      expect(await f.repository.publishActivation({ claim, now: new Date(), publication: f.outcome })).toEqual({ kind: "published" });
    }
    const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: f.serverId }, include: { activeRevision: true } });
    const corrected = { ...f.pending, source: { ...f.pending.source, url: f.endpoint } };
    expect(stored.draft).toEqual(corrected);
    expect(stored.activeRevision?.configuration).toEqual(corrected);
    expect(stored.testedDraftHash).toBe(hashCanonicalMcpValue(corrected));
    const connection = await f.oauth.loadConnection(f.connection.id);
    expect(connection?.policy).toMatchObject({ serverUrl: f.endpoint, resource: f.endpoint,
      configurationIdentity: hashCanonicalMcpValue(corrected), allowPrivateNetwork: true });
    expect(connection?.tokens).toEqual(f.connection.tokens);
    expect(connection?.scopes).toEqual(f.connection.scopes);
    expect(connection?.client.id).toBe(f.connection.client.id);
    expect(connection?.tokenVersion).not.toBe(f.connection.tokenVersion);
    expect(await new McpOAuthService({ repository: f.oauth }).createValidationProvider({
      serverId: f.serverId, userId: f.userId, redirectUri: f.redirectUri(f.serverId)
    })).not.toBeNull();
    expect(await prisma.mcpRevision.findUniqueOrThrow({ where: { id: oldRevision.id } })).toEqual(oldRevision);
  });

  it.each(["draft", "token", "revocation"] as const)("retains the previous active revision when %s changes during validation", async (change) => {
    const f = await correctionFixture();
    f.validate.mockImplementationOnce(async () => {
      if (change === "draft") await f.repository.updateServer({ serverId: f.serverId,
        draft: { ...f.pending, runtime: { ...f.pending.runtime, callTimeoutMs: 40_000 } } });
      if (change === "token") await f.oauth.rotateTokens({ connectionId: f.connection.id, expectedTokenVersion: f.connection.tokenVersion,
        tokens: { access_token: "fixture-new-token", token_type: "Bearer", scope: "mcp" } });
      if (change === "revocation") await f.oauth.requestDisconnect({ purpose: "validation", serverId: f.serverId, userId: f.userId });
      return f.outcome;
    });
    expect(await f.repository.testDraft({ serverId: f.serverId, expectedUpdatedAt: f.expectedUpdatedAt, oneTimeValues: {}, publish: true, validationUserId: f.userId })).toEqual({ kind: "draft_changed" });
    const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: f.serverId } });
    expect(stored.activeRevisionId).toBe(f.server.activeRevision!.id);
    expect(stored.draft).toMatchObject({ source: f.pending.source });
    const connection = await f.oauth.loadConnection(f.connection.id);
    if (connection) expect(connection.policy.serverUrl).toBe(f.connection.policy.serverUrl);
  });

  it("rolls back activation completion when the checked OAuth token was replaced", async () => {
    const f = await correctionFixture();
    await f.repository.requestActivation({ serverId: f.serverId, validationUserId: f.userId });
    const claim = await f.repository.claimActivation({ now: new Date(), staleBefore: new Date(0) });
    if (!claim || claim.serverId !== f.serverId || f.outcome.kind !== "ok") throw new Error("fixture_claim_missing");
    await f.repository.advanceActivation({ id: claim.id, leaseId: claim.leaseId, now: new Date(), stage: "publishing" });
    await f.oauth.rotateTokens({ connectionId: f.connection.id, expectedTokenVersion: f.connection.tokenVersion,
      tokens: { access_token: "fixture-rotated", token_type: "Bearer", scope: "mcp" } });
    expect(await f.repository.publishActivation({ claim, now: new Date(), publication: f.outcome })).toMatchObject({ kind: "invalid" });
    const stored = await prisma.mcpServer.findUniqueOrThrow({ where: { id: f.serverId }, include: { activationJob: true } });
    expect(stored.activeRevisionId).toBe(f.server.activeRevision!.id);
    expect(stored.draft).toEqual(f.pending);
    expect(stored.activationJob).toMatchObject({ stage: "publishing", leaseId: claim.leaseId });
    expect((await f.oauth.loadConnection(f.connection.id))?.policy).toEqual(f.connection.policy);
  });
});

describe("MCP Test & Save persistence", () => {
  it("keeps an already-requested runtime for recent Hub activity without a browser session", async () => {
    const f = await fixture();
    await f.repository.setGrant({ serverId: f.serverId, userId: f.userId,
      groupId: null, canUse: true, personalSlotKeys: [] });
    expect(await f.repository.updateUserServer({ serverId: f.serverId, userId: f.userId, enabled: true }))
      .toMatchObject({ kind: "ok" });
    const client = await prisma.inboundMcpOAuthClient.create({ data: {
      clientId: `https://client.example/${randomUUID()}`, clientName: "Runtime activity fixture",
      clientOrigin: "https://client.example", redirectUris: ["http://localhost/callback"],
      applicationType: "NATIVE", kind: "CLIENT_ID_METADATA_DOCUMENT", metadataFingerprint: "a".repeat(64)
    } });
    try {
      const now = new Date();
      const grant = await prisma.inboundMcpOAuthGrant.create({ data: {
        oauthClientId: client.id, userId: f.userId, resourcePath: "/mcp/hub", capability: "mcp:hub",
        lastUsedAt: now
      } });
      const runtime = createPrismaMcpRuntimeRepository({ prisma, encryptionKey: () => Buffer.alloc(32, 1) });
      const requested = () => runtime.synchronizeDesired({ now, onDemand: true, serverIds: [f.serverId], userId: f.userId });
      // Recent OAuth use keeps existing demand alive, but never creates it.
      await runtime.synchronizeDesired({ now });
      expect((await prisma.mcpUserServer.findFirstOrThrow({ where: { userId: f.userId, serverId: f.serverId } }))
        .desiredRuntimeGenerationId).toBeNull();
      const launches = await requested();
      expect(launches).toHaveLength(1);
      const launch = launches[0]!;
      const runtimeFailure = { errorCode: "mcp_network_failed", fingerprint: launch.fingerprint, generationId: launch.generationId, now };
      const beforeFailure = await prisma.mcpRuntimeGeneration.findUniqueOrThrow({ where: { id: launch.generationId } });
      expect(await runtime.markFailed({ ...runtimeFailure, fingerprint: "0".repeat(64) })).toEqual({ applied: false, retryAt: null });
      expect(await prisma.mcpRuntimeGeneration.findUniqueOrThrow({ where: { id: launch.generationId } })).toEqual(beforeFailure);
      const failed = await runtime.markFailed(runtimeFailure);
      const persistedFailure = await prisma.mcpRuntimeGeneration.findUniqueOrThrow({ where: { id: launch.generationId } });
      expect(failed).toEqual({ applied: true, retryAt: persistedFailure.retryAt });
      expect(persistedFailure).toMatchObject({ state: "failed", errorCode: "mcp_network_failed" });
      expect(failed.retryAt!.getTime()).toBeGreaterThan(now.getTime());
      const reconcile = async (at = now) => (await runtime.synchronizeDesired({ now: at }))
        .filter((launch) => launch.generationId === launches[0]!.generationId);
      expect(await reconcile()).toHaveLength(1);
      expect(await prisma.authSession.count({ where: { userId: f.userId } })).toBe(0);
      expect(await reconcile(new Date(now.getTime() + 16 * 60_000))).toHaveLength(0);
      await requested();
      await prisma.inboundMcpOAuthGrant.update({ where: { id: grant.id }, data: { state: "REVOKED", revokedAt: now } });
      expect(await reconcile()).toHaveLength(0);
      await requested();
      await prisma.inboundMcpOAuthGrant.create({ data: {
        oauthClientId: client.id, userId: f.userId, lastUsedAt: now,
        resourcePath: "/mcp", capability: "memory:facts"
      } });
      expect(await reconcile()).toHaveLength(0);
    } finally {
      await prisma.mcpUserServer.updateMany({ where: { userId: f.userId }, data: { desiredRuntimeGenerationId: null } });
      await prisma.mcpRuntimeGeneration.deleteMany({ where: { userServer: { userId: f.userId } } });
      await prisma.inboundMcpOAuthClient.delete({ where: { id: client.id } });
    }
  });

  it("applies tool switches without another check, preserving the pending endpoint, keys and immutable revisions", async () => {
    const { repository, server, serverId, validate } = await fixture();
    const original = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    const pending = { ...draft, source: { kind: "remote" as const, url: "https://pending.example.test/mcp" } };
    const staged = await repository.updateServer({ draft: pending, serverId });
    if (staged.kind !== "ok") throw new Error(staged.kind);
    const input = { serverId, expectedUpdatedAt: staged.value.updatedAt, tool: { name: "write", enabled: false } };
    const applied = await repository.updateServer(input);
    if (applied.kind !== "ok") throw new Error(applied.kind);
    expect(applied.value.activeRevision?.disabledToolNames).toEqual(["write"]);
    expect(applied.value.draft).toMatchObject({ ...pending, disabledToolNames: ["write"] });
    expect(applied.value.draftTested).toBe(false);
    const active = await prisma.mcpRevision.findUniqueOrThrow({ where: { id: applied.value.activeRevision!.id } });
    expect(active.configuration).toMatchObject({ ...draft, disabledToolNames: ["write"] });
    const after = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    expect(after.sharedConfigEnvelope).toBe(original.sharedConfigEnvelope);
    expect(after.sharedConfigVersion).toBe(original.sharedConfigVersion);
    expect(after.enabled).toBe(original.enabled);
    expect(await repository.updateServer(input)).toEqual({ kind: "draft_changed" });
    expect(await repository.updateServer({ ...input, expectedUpdatedAt: applied.value.updatedAt, tool: { name: "unknown", enabled: true } }))
      .toMatchObject({ kind: "draft_validation_failed" });
    expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).toEqual(after);
    const restored = await repository.updateServer({ ...input, expectedUpdatedAt: applied.value.updatedAt, tool: { name: "write", enabled: true } });
    if (restored.kind !== "ok") throw new Error(restored.kind);
    expect(restored.value.activeRevision?.disabledToolNames ?? []).toEqual([]);
    expect(restored.value.draft.source).toEqual(pending.source);
    expect(validate).toHaveBeenCalledTimes(1);
    expect((await prisma.mcpRevision.findUniqueOrThrow({ where: { id: server.activeRevision!.id } })).configuration).toEqual(draft);
  });

  it("publishes identity and candidate settings only after their successful check", async () => {
    const { repository, server, serverId, userId, validate } = await fixture();
    const before = await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } });
    const candidate = {
      description: "Candidate description",
      draft: { ...draft, disabledToolNames: ["write"] },
      expectedUpdatedAt: server.updatedAt,
      name: "Candidate name",
      oneTimeValues: {},
      publish: true,
      serverId,
      sharedValues: { api_key: "fixture-candidate-secret" },
      validationUserId: userId
    };
    validate.mockResolvedValueOnce({ kind: "invalid", issues: [{ code: "mcp_list_tools_failed", path: "source" }] });
    expect(await repository.testDraft(candidate)).toMatchObject({ kind: "draft_validation_failed" });
    expect(await prisma.mcpServer.findUniqueOrThrow({ where: { id: serverId } })).toEqual(before);

    const applied = await repository.testDraft(candidate);
    expect(applied.kind).toBe("ok");
    if (applied.kind !== "ok") return;
    expect(applied.value).toMatchObject({ description: candidate.description, name: candidate.name });
    expect(applied.value.activeRevision?.disabledToolNames).toEqual(["write"]);
    expect(validate).toHaveBeenLastCalledWith(expect.objectContaining({
      draft: candidate.draft, values: { api_key: "fixture-candidate-secret" }
    }));
    expect(JSON.stringify(applied.value)).not.toContain("fixture-candidate-secret");
  });

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


describe("MCP tool access persistence", () => {
  it("filters personal/Assistant/Project catalogs by the actor while preserving shared generations and base authority", async () => {
    const f = await fixture();
    const actorId = await admin();
    for (const userId of [f.userId, actorId]) {
      await f.repository.setGrant({ serverId: f.serverId, userId, groupId: null, canUse: true, personalSlotKeys: [] });
      const preference = await prisma.mcpUserServer.create({ data: { serverId: f.serverId, userId, enabled: true } });
      const generation = await prisma.mcpRuntimeGeneration.create({ data: {
        userServerId: preference.id, revisionId: f.server.activeRevision!.id, fingerprint: hashCanonicalMcpValue(randomUUID()),
        state: "ready", credentialSources: ["shared"], inventoryUpdatedAt: new Date(),
        inventory: { version: 1, tools: ["search", "write"].map((name) => ({ name, description: null, inputSchema: { type: "object" }, definitionHash: "a".repeat(64) })) }
      } });
      await prisma.mcpUserServer.update({ where: { id: preference.id }, data: { desiredRuntimeGenerationId: generation.id } });
    }
    const toolsBefore = (await loadMcpCapabilityCatalog(actorId)).servers.find(({ serverId }) => serverId === f.serverId)!.tools;
    const write = toolsBefore.find(({ originalName }) => originalName === "write")!;
    await prisma.mcpToolAccessPolicy.create({ data: { serverId: f.serverId, toolName: "write", restricted: true, users: { create: { userId: f.userId } } } });
    expect((await loadMcpCapabilityCatalog(actorId)).servers.find(({ serverId }) => serverId === f.serverId)!.tools.map(({ originalName }) => originalName)).toEqual(["search"]);
    const records = await loadMcpRunPlanRecordsForServers(actorId, [f.serverId]);
    expect(records[0]!.catalogTools!.map(({ name }) => name)).toEqual(["search"]);
    expect(records[0]!.inventory).toMatchObject({ tools: [{ name: "search" }] });
    const exact = await prepareMcpRunPlan({ allowedServerIds: [f.serverId], allowedToolNames: [write.namespacedName], isGenerationLive: () => true, load: async () => records });
    expect(exact).toMatchObject({ ok: false, code: "mcp_not_ready", issues: [{ errorCode: "mcp_tool_not_available" }] });
    expect((await loadMcpRunPlanRecordsForProjectServers(actorId, [f.serverId]))[0]!.inventory).toMatchObject({ tools: [{ name: "search" }] });
    expect((await loadMcpRunPlanRecordsForProjectServers(f.userId, [f.serverId]))[0]!.catalogTools).toHaveLength(2);
    const generations = await prisma.mcpRuntimeGeneration.findMany({ where: { revisionId: f.server.activeRevision!.id } });
    for (const generation of generations) expect(generation.inventory).toMatchObject({ tools: [{ name: "search" }, { name: "write" }] });
    const ordinary = (await f.repository.listUserServers(actorId)).find(({ id }) => id === f.serverId)!;
    expect(ordinary.tools.map(({ name }) => name)).toEqual(["search"]);
    expect(ordinary.knownToolCount).toBe(1);
    expect(JSON.stringify(ordinary)).not.toContain(f.userId);
    expect(ordinary).not.toHaveProperty("toolAccess");
    await prisma.mcpGrant.deleteMany({ where: { serverId: f.serverId, userId: actorId } });
    expect((await loadMcpRunPlanRecordsForServers(actorId, [f.serverId]))[0]).toMatchObject({ catalogTools: [], inventory: null, errorCode: "mcp_access_revoked" });
    // Project shared authority survives personal server-grant loss.
    expect((await loadMcpRunPlanRecordsForProjectServers(actorId, [f.serverId]))[0]!.catalogTools!.map(({ name }) => name)).toEqual(["search"]);
  });

  it("changes only mutable tool policy, preserves drafts and credentials, and conflicts atomically", async () => {
    const f = await fixture();
    const before = await prisma.mcpServer.findUniqueOrThrow({ where: { id: f.serverId } });
    const toolAccess = { name: "write", restricted: true, userIds: [f.userId], groupIds: [] };
    const input = { serverId: f.serverId, expectedUpdatedAt: f.server.updatedAt, toolAccess };
    const results = await Promise.all([f.repository.updateServer(input), f.repository.updateServer({ ...input, toolAccess: { ...toolAccess, userIds: [] } })]);
    expect(results.map(({ kind }) => kind).sort()).toEqual(["draft_changed", "ok"]);
    expect(f.validate).toHaveBeenCalledTimes(1);
    const after = await prisma.mcpServer.findUniqueOrThrow({ where: { id: f.serverId } });
    expect({ ...after, updatedAt: before.updatedAt }).toEqual(before);
    const saved = await prisma.mcpToolAccessPolicy.findUniqueOrThrow({ where: { serverId_toolName: { serverId: f.serverId, toolName: "write" } }, include: { users: true } });
    expect(saved.restricted).toBe(true);
    const current = { ...input, expectedUpdatedAt: after.updatedAt.toISOString() };
    expect(await f.repository.updateServer({ ...current, toolAccess: { ...toolAccess, userIds: [randomUUID()] } })).toMatchObject({ kind: "draft_validation_failed" });
    expect(await f.repository.updateServer({ ...current, toolAccess: { ...toolAccess, name: "unknown_tool" } })).toMatchObject({ kind: "draft_validation_failed" });
    expect(await prisma.mcpToolAccessPolicy.findUniqueOrThrow({ where: { id: saved.id }, include: { users: true } })).toEqual(saved);
    const validSave = await f.repository.updateServer({ ...current, toolAccess: { ...toolAccess, userIds: [f.userId, f.userId] } });
    expect(validSave.kind).toBe("ok");
    if (validSave.kind !== "ok") throw new Error(validSave.kind);
    expect(validSave.value.toolAccess).toEqual([toolAccess]);
  });

  it("enforces user/group lifecycle and leaves restricted + empty after the last recipient is deleted", async () => {
    const f = await fixture();
    const recipient = await admin();
    const group = await prisma.group.create({ data: { name: `MCP editors ${randomUUID()}` } });
    groupIds.push(group.id);
    await prisma.userGroup.create({ data: { userId: f.userId, groupId: group.id } });
    const policy = await prisma.mcpToolAccessPolicy.create({ data: { serverId: f.serverId, toolName: "write", restricted: true,
      users: { create: { userId: recipient } }, groups: { create: { groupId: group.id } } } });
    const tools = ["search", "write"].map((originalName) => ({ serverId: f.serverId, originalName }));
    const names = async (userId: string) => (await filterMcpToolsForUser(userId, tools, prisma)).map(({ originalName }) => originalName);
    expect(await names(f.userId)).toEqual(["search", "write"]);
    expect(await names(recipient)).toEqual(["search", "write"]);
    await prisma.group.update({ where: { id: group.id }, data: { archivedAt: new Date() } });
    expect(await names(f.userId)).toEqual(["search"]);
    expect(await names(recipient)).toEqual(["search", "write"]);
    await prisma.group.update({ where: { id: group.id }, data: { archivedAt: null } });
    await prisma.userGroup.delete({ where: { userId_groupId: { userId: f.userId, groupId: group.id } } });
    expect(await names(f.userId)).toEqual(["search"]);
    await prisma.user.update({ where: { id: recipient }, data: { status: "disabled" } });
    expect(await names(recipient)).toEqual([]);
    await prisma.user.delete({ where: { id: recipient } });
    await prisma.group.delete({ where: { id: group.id } });
    expect(await prisma.mcpToolAccessPolicy.findUniqueOrThrow({ where: { id: policy.id }, include: { users: true, groups: true } }))
      .toMatchObject({ restricted: true, users: [], groups: [] });
    expect(await names(f.userId)).toEqual(["search"]);
    const full = await prisma.group.findUniqueOrThrow({ where: { systemRole: "full_access" } });
    await prisma.userGroup.upsert({ where: { userId_groupId: { userId: f.userId, groupId: full.id } },
      create: { userId: f.userId, groupId: full.id }, update: {} });
    expect(await names(f.userId)).toEqual(["search"]);
    await prisma.mcpToolGroupGrant.create({ data: { policyId: policy.id, groupId: full.id } });
    expect(await names(f.userId)).toEqual(["search", "write"]);
  });

  it("preserves restrictions through global off/on, disappearance, Test & Save and rollback", async () => {
    const f = await fixture();
    const current = async () => (await f.repository.listAdminServers()).find(({ id }) => id === f.serverId)!;
    const toolAccess = { name: "write", restricted: true, userIds: [f.userId], groupIds: [] };
    expect((await f.repository.updateServer({ serverId: f.serverId, expectedUpdatedAt: f.server.updatedAt, toolAccess })).kind).toBe("ok");
    for (const enabled of [false, true]) {
      expect((await f.repository.updateServer({ serverId: f.serverId, expectedUpdatedAt: (await current()).updatedAt,
        tool: { name: "write", enabled } })).kind).toBe("ok");
      expect((await current()).toolAccess).toEqual([toolAccess]);
    }
    f.validate.mockResolvedValue({ ...valid, toolInventory: valid.toolInventory.filter(({ name }) => name !== "write") });
    expect((await f.save(await current())).kind).toBe("ok");
    expect((await current()).activeRevision!.validationEvidence.toolInventory.map(({ name }) => name)).toEqual(["search"]);
    expect((await current()).toolAccess).toEqual([toolAccess]);
    f.validate.mockResolvedValue(valid);
    expect((await f.save(await current())).kind).toBe("ok");
    expect((await current()).toolAccess).toEqual([toolAccess]);
    expect((await f.repository.rollbackServer({ serverId: f.serverId, revisionId: f.server.activeRevision!.id })).kind).toBe("ok");
    expect((await current()).toolAccess).toEqual([toolAccess]);
    expect((await f.repository.updateServer({ serverId: f.serverId, expectedUpdatedAt: (await current()).updatedAt,
      toolAccess: { ...toolAccess, restricted: false } })).kind).toBe("ok");
    expect((await current()).toolAccess).toEqual([{ ...toolAccess, restricted: false }]);
  });
});

describe("MCP stored values bound to their endpoint origin", () => {
  const personalSlotDraft: McpDraftConfiguration = {
    ...draft,
    slots: [...draft.slots, {
      label: "User token", policy: { kind: "personal", required: true }, sensitive: true,
      slotKey: "user_token", target: { kind: "header", name: "X-User-Token" }, valueType: "secret"
    }]
  };

  it("withholds shared and personal values from a new origin until they are entered again", async () => {
    const userId = await admin();
    const key = Buffer.alloc(32, 1);
    const validate = vi.fn(async (_input: McpDraftValidationInput): Promise<McpDraftValidationOutcome> => valid);
    const repository = createPrismaMcpRepository({ prisma, draftValidator: { validate }, encryptionKey: () => key });
    const created = await repository.createServer({
      description: "Endpoint binding fixture", draft: personalSlotDraft, name: `Bound ${randomUUID()}`,
      sharedValues: { api_key: "canary-shared-origin-a" }
    });
    if (created.kind !== "ok") throw new Error(`fixture_create_${created.kind}`);
    const serverId = created.value.id;
    serverIds.push(serverId);
    expect((await repository.testDraft({ expectedUpdatedAt: created.value.updatedAt, oneTimeValues: { user_token: "one-time-a" },
      publish: true, serverId, validationUserId: userId })).kind).toBe("ok");
    await repository.setGrant({ serverId, userId, groupId: null, canUse: true, personalSlotKeys: ["user_token"] });
    expect(await repository.updateUserServer({ serverId, userId, enabled: true, values: { user_token: "canary-personal-origin-a" } }))
      .toMatchObject({ kind: "ok" });
    // Upgrade scenario: this personal value was stored before bindings existed.
    const preference = await prisma.mcpUserServer.findFirstOrThrow({ where: { serverId, userId } });
    const personalContext = mcpPersonalConfigEnvelopeContext(preference.id, preference.personalConfigVersion);
    const legacy = decryptMcpEnvelope<Record<string, unknown>>(preference.personalConfigEnvelope!, key, personalContext);
    delete legacy.endpoints;
    await prisma.mcpUserServer.update({ where: { id: preference.id },
      data: { personalConfigEnvelope: encryptMcpEnvelope(legacy, key, personalContext) } });
    const launch = async () => remoteRuntimeCandidate({ key, record: await prisma.mcpUserServer.findFirstOrThrow({
      include: {
        server: { include: { activeRevision: true, grants: true, oauthConnections: { include: { oauthClient: { select: { clientId: true } } } } } },
        user: { select: { groups: { select: { groupId: true } }, id: true } }
      },
      where: { serverId, userId }
    }) });
    expect((await launch())?.headers).toMatchObject({ "X-Api-Key": "canary-shared-origin-a", "X-User-Token": "canary-personal-origin-a" });

    const moved: McpDraftConfiguration = { ...personalSlotDraft, source: { kind: "remote", url: "https://moved.example.test/mcp" } };
    const updated = await repository.updateServer({ serverId, draft: moved });
    if (updated.kind !== "ok") throw new Error(updated.kind);
    expect(updated.value.sharedValues.api_key).toEqual({ configured: false, updatedAt: null });
    // The published origin keeps its values until the move is published.
    expect((await launch())?.headers).toMatchObject({ "X-Api-Key": "canary-shared-origin-a", "X-User-Token": "canary-personal-origin-a" });

    validate.mockClear();
    expect(await repository.testDraft({ oneTimeValues: { user_token: "one-time-b" }, publish: false, serverId }))
      .toMatchObject({ kind: "invalid_values", issues: [{ code: "slot_value_required", path: "oneTimeValues.api_key" }] });
    expect(validate).not.toHaveBeenCalled();
    expect((await repository.testDraft({ expectedUpdatedAt: updated.value.updatedAt, oneTimeValues: { user_token: "one-time-b" },
      publish: true, serverId, sharedValues: { api_key: "canary-shared-origin-b" }, validationUserId: userId })).kind).toBe("ok");
    const dispatched = JSON.stringify(validate.mock.calls);
    expect(dispatched).toContain("canary-shared-origin-b");
    expect(dispatched).not.toContain("origin-a");

    // Publication pinned the legacy personal value to the previous origin without a version change.
    const pinned = await prisma.mcpUserServer.findFirstOrThrow({ where: { serverId, userId } });
    expect(pinned.personalConfigVersion).toBe(preference.personalConfigVersion);
    expect(decryptMcpEnvelope(pinned.personalConfigEnvelope!, key, personalContext))
      .toMatchObject({ endpoints: { user_token: { origin: "https://mcp.example.test" } } });
    const listed = (await repository.listUserServers(userId)).find(({ id }) => id === serverId);
    expect(listed?.fields.find(({ slotKey }) => slotKey === "user_token")).toMatchObject({ configured: false });
    expect(await launch()).toBeNull();

    expect(await repository.updateUserServer({ serverId, userId, values: { user_token: "canary-personal-origin-b" } }))
      .toMatchObject({ kind: "ok" });
    const launched = await launch();
    expect(launched).toMatchObject({ url: "https://moved.example.test/mcp",
      headers: { "X-Api-Key": "canary-shared-origin-b", "X-User-Token": "canary-personal-origin-b" } });
    expect(JSON.stringify(launched)).not.toContain("origin-a");
  });

  it("keeps values entered for the same origin across a path change", async () => {
    const f = await fixture();
    const updated = await f.repository.updateServer({ serverId: f.serverId,
      draft: { ...draft, source: { kind: "remote", url: "https://mcp.example.test/v2/mcp" } } });
    if (updated.kind !== "ok") throw new Error(updated.kind);
    expect(updated.value.sharedValues.api_key).toMatchObject({ configured: true });
    f.validate.mockClear();
    expect((await f.repository.testDraft({ expectedUpdatedAt: updated.value.updatedAt, oneTimeValues: {}, publish: true,
      serverId: f.serverId, validationUserId: f.userId })).kind).toBe("ok");
    expect(f.validate.mock.calls[0]![0].values).toEqual({ api_key: "fixture-initial-key" });
  });
});

describe("MCP published tool inventory", () => {
  const checkedTools = [
    { definitionHash: "a".repeat(64), name: "search" },
    { definitionHash: "b".repeat(64), name: "write" }
  ];
  const checked: Extract<McpDraftValidationOutcome, { kind: "ok" }> = {
    ...valid,
    evidence: { ...mcpToolDefinitionEvidence(checkedTools), toolCount: checkedTools.length }
  };

  async function readyGeneration(input: {
    credentialSources?: string[];
    enabled?: boolean;
    exclusions: { name: string; reason: string }[];
    revisionId: string;
    serverId: string;
    state?: "ready" | "starting";
    tools?: string[];
    userId?: string;
  }) {
    const userId = input.userId ?? await admin();
    const preference = await prisma.mcpUserServer.create({
      data: { enabled: input.enabled ?? true, serverId: input.serverId, userId }
    });
    const generation = await prisma.mcpRuntimeGeneration.create({ data: {
      credentialSources: input.credentialSources ?? ["shared"],
      fingerprint: hashCanonicalMcpValue(randomUUID()),
      inventory: {
        exclusions: input.exclusions,
        tools: (input.tools ?? []).map((name) => ({
          definitionHash: "a".repeat(64), description: null, inputSchema: { type: "object" }, name
        })),
        version: 1
      },
      inventoryUpdatedAt: new Date(),
      revisionId: input.revisionId,
      state: input.state ?? "ready",
      userServerId: preference.id
    } });
    await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: generation.id }, where: { id: preference.id } });
    return { generation, preference, userId };
  }

  it("records exact definitions, keeps them through a tool switch and reports older checks as name-only", async () => {
    const f = await fixture();
    expect(f.server.activeRevision?.toolVerification).toBe("names");
    f.validate.mockResolvedValue(checked);
    const saved = await f.save(f.server);
    if (saved.kind !== "ok") throw new Error(saved.kind);
    expect(saved.value.activeRevision?.toolVerification).toBe("definitions");
    expect(adminMcpAttention(saved.value)).toBeNull();

    const switched = await f.repository.updateServer({
      expectedUpdatedAt: saved.value.updatedAt, serverId: f.serverId, tool: { enabled: false, name: "write" }
    });
    if (switched.kind !== "ok") throw new Error(switched.kind);
    expect(switched.value.activeRevision?.id).not.toBe(saved.value.activeRevision?.id);
    expect(switched.value.activeRevision?.toolVerification).toBe("definitions");
    const stored = await prisma.mcpRevision.findUniqueOrThrow({ where: { id: switched.value.activeRevision!.id } });
    expect(mcpPublishedToolDefinitions(stored.validationEvidence)).toEqual({
      hashes: new Map(checkedTools.map(({ definitionHash, name }) => [name, definitionHash])), kind: "definitions"
    });

    // Upgrade: a revision published before definitions were recorded.
    await prisma.mcpRevision.update({ data: {
      validationEvidence: { evidence: {}, testedAt: new Date().toISOString(), toolInventory: valid.toolInventory }
    }, where: { id: stored.id } });
    const legacy = (await f.repository.listAdminServers(f.userId)).find(({ id }) => id === f.serverId)!;
    expect(legacy.activeRevision?.toolVerification).toBe("names");
    expect(adminMcpAttention(legacy)).toMatchObject({ label: "Check again to guard against tool changes" });
  });

  it("launches a revision checked before definitions by name and a checked revision by exact definitions", async () => {
    const f = await fixture();
    await f.repository.setGrant({ canUse: true, groupId: null, personalSlotKeys: [], serverId: f.serverId, userId: f.userId });
    expect(await f.repository.updateUserServer({ enabled: true, serverId: f.serverId, userId: f.userId }))
      .toMatchObject({ kind: "ok" });
    const runtime = createPrismaMcpRuntimeRepository({ encryptionKey: () => Buffer.alloc(32, 1), prisma });
    const launch = async () => {
      const launches = await runtime.synchronizeDesired({ now: new Date(), onDemand: true, serverIds: [f.serverId], userId: f.userId });
      expect(launches).toHaveLength(1);
      return launches[0]!;
    };

    expect((await launch()).publishedTools).toEqual({ kind: "names", names: new Set(["search", "write"]) });

    f.validate.mockResolvedValue(checked);
    const current = (await f.repository.listAdminServers(f.userId)).find(({ id }) => id === f.serverId)!;
    expect((await f.save(current)).kind).toBe("ok");
    const upgraded = await launch();
    expect(upgraded.publishedTools).toEqual({
      hashes: new Map(checkedTools.map(({ definitionHash, name }) => [name, definitionHash])), kind: "definitions"
    });
    const generation = await prisma.mcpRuntimeGeneration.findUniqueOrThrow({ where: { id: upgraded.generationId } });
    expect(generation.revisionId).toBe((await prisma.mcpServer.findUniqueOrThrow({ where: { id: f.serverId } })).activeRevisionId);
  });

  it("lists every held-back and restricted tool in the user's catalog with its reason", async () => {
    const f = await fixture();
    await f.repository.setGrant({ canUse: true, groupId: null, personalSlotKeys: [], serverId: f.serverId, userId: f.userId });
    await readyGeneration({
      exclusions: [
        { name: "delete_repo", reason: "unpublished_addition" },
        { name: "write", reason: "definition_drift" }
      ],
      revisionId: f.server.activeRevision!.id,
      serverId: f.serverId,
      tools: ["search"],
      userId: f.userId
    });
    await prisma.mcpToolAccessPolicy.create({ data: { restricted: true, serverId: f.serverId, toolName: "search" } });

    const listed = (await f.repository.listUserServers(f.userId)).find(({ id }) => id === f.serverId)!;

    expect(listed.readiness).toBe("ready");
    expect(listed.tools).toEqual([]);
    expect(listed.unavailableTools).toEqual([
      { name: "delete_repo", reason: "unpublished_addition" },
      { name: "search", reason: "restricted" },
      { name: "write", reason: "definition_drift" }
    ]);
  });

  it("counts held-back tools per current connection and hides additions seen only through personal accounts", async () => {
    const f = await fixture();
    f.validate.mockResolvedValue(checked);
    const saved = await f.save(f.server);
    if (saved.kind !== "ok") throw new Error(saved.kind);
    const revisionId = saved.value.activeRevision!.id;
    const shared = await readyGeneration({ exclusions: [
      { name: "delete_repo", reason: "unpublished_addition" },
      { name: "write", reason: "definition_drift" }
    ], revisionId, serverId: f.serverId, tools: ["search"] });
    await readyGeneration({ credentialSources: ["personal"], exclusions: [
      { name: "private_export", reason: "unpublished_addition" },
      { name: "search", reason: "disabled_by_policy" },
      { name: "write", reason: "definition_drift" }
    ], revisionId, serverId: f.serverId });
    // A connection mid-refresh reports nothing until its inventory is ready again.
    await readyGeneration({ exclusions: [{ name: "stale_tool", reason: "unpublished_addition" }], revisionId,
      serverId: f.serverId, state: "starting" });
    const idle = await readyGeneration({ exclusions: [{ name: "idle_tool", reason: "missing_upstream" }], revisionId,
      serverId: f.serverId });
    await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: null }, where: { id: idle.preference.id } });

    const listed = (await f.repository.listAdminServers(f.userId)).find(({ id }) => id === f.serverId)!;
    expect(listed.inventoryDifferences).toEqual([
      { connections: 2, name: "write", reason: "definition_drift" },
      { connections: 1, name: "delete_repo", reason: "unpublished_addition" },
      { connections: 1, name: null, reason: "unpublished_addition" }
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/private_export|stale_tool|idle_tool/u);
    expect(adminMcpAttention(listed)).toMatchObject({ label: "Server tools changed since the last check", task: "validation" });

    await prisma.mcpUserServer.update({ data: { enabled: false }, where: { id: shared.preference.id } });
    const single = await f.repository.updateServer({ name: "Renamed tools", serverId: f.serverId });
    if (single.kind !== "ok") throw new Error(single.kind);
    expect(single.value.inventoryDifferences).toEqual([
      { connections: 1, name: "write", reason: "definition_drift" },
      { connections: 1, name: null, reason: "unpublished_addition" }
    ]);
  });

  it("bounds each server's held-back rows to one runtime inventory's exclusions, keeping changed definitions first", async () => {
    const f = await fixture();
    f.validate.mockResolvedValue(checked);
    const saved = await f.save(f.server);
    if (saved.kind !== "ok") throw new Error(saved.kind);
    const revisionId = saved.value.activeRevision!.id;
    const additions = (prefix: string) => Array.from({ length: MCP_INVENTORY_EXCLUSION_LIMIT - 1 }, (_, index) => ({
      name: `${prefix}_${String(index).padStart(4, "0")}`, reason: "unpublished_addition"
    }));
    // Two shared connections disagree about additions: together they name more than one inventory can.
    await readyGeneration({ exclusions: [{ name: "write", reason: "definition_drift" }, ...additions("a")], revisionId, serverId: f.serverId });
    await readyGeneration({ exclusions: [{ name: "write", reason: "definition_drift" }, ...additions("b")], revisionId, serverId: f.serverId });

    const listed = (await f.repository.listAdminServers(f.userId)).find(({ id }) => id === f.serverId)!;
    expect(listed.inventoryDifferences).toHaveLength(MCP_INVENTORY_EXCLUSION_LIMIT);
    expect(listed.inventoryDifferences?.[0]).toEqual({ connections: 2, name: "write", reason: "definition_drift" });
    expect(listed.inventoryDifferences?.[1]).toEqual({ connections: 1, name: "a_0000", reason: "unpublished_addition" });
    // Every name the first connection holds back fits; the overflow is the other connection's divergent additions.
    expect(listed.inventoryDifferences?.at(-1)).toEqual({ connections: 1, name: "a_2046", reason: "unpublished_addition" });
    expect(listed.inventoryDifferences?.some(({ name }) => name?.startsWith("b_"))).toBe(false);
  });
});
