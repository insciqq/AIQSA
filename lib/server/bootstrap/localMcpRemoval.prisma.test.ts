// @vitest-environment node
import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { createPrismaMcpRepository } from "../mcp/prismaRepository";
import { prisma } from "../prisma";
import {
  applyLocalMcpRemovalGate,
  inspectLocalMcpLeftovers,
  localMcpLeftoverCount,
  type LocalMcpLeftovers
} from "./localMcpRemoval";

// Synthetic rows only. The gate scans the whole disposable database, so the
// test first proves that no other local MCP row exists there.
const key = Buffer.alloc(32, 23);
const owned = {
  chats: [] as string[], oauthClients: [] as string[], projects: [] as string[], servers: [] as string[], users: [] as string[]
};
const remoteDraft = {
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
  slots: [],
  source: { kind: "remote", url: "https://mcp.example.test/mcp" },
  transport: "streamable_http"
};
const otherRemoteDraft = { ...remoteDraft, source: { kind: "remote", url: "https://mcp.example.test/other" } };
const localDraft = (kind: "npm" | "pypi" | "oci") => ({
  auth: { mode: "none" },
  runtime: { callTimeoutMs: 30_000, startupTimeoutMs: 15_000 },
  slots: [],
  source: kind === "oci"
    ? { image: "registry.example.test/mcp", kind, tag: "1.0.0" }
    : { kind, package: "example-local-mcp", version: "1.0.0" },
  transport: "stdio"
});
const fingerprint = () => createHash("sha256").update(randomUUID()).digest("hex");
const refuse = (count: number) => new Error(`local_mcp_refused:${count}`);
const gate = (acknowledged: boolean) => prisma.$transaction(
  (tx) => applyLocalMcpRemovalGate(tx, { acknowledged, refuse }),
  { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
);
const inspect = () => prisma.$transaction((tx) => inspectLocalMcpLeftovers(tx));

afterAll(() => prisma.$disconnect());

afterEach(async () => {
  const serverIds = owned.servers.splice(0);
  const chatIds = owned.chats.splice(0);
  const userIds = owned.users.splice(0);
  await prisma.modelRun.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.chat.updateMany({ data: { activeLeafMessageId: null }, where: { id: { in: chatIds } } });
  await prisma.message.deleteMany({ where: { chatId: { in: chatIds } } });
  await prisma.chat.deleteMany({ where: { id: { in: chatIds } } });
  await prisma.memoryDeletionOutbox.deleteMany({ where: { targetId: { in: chatIds }, userId: { in: userIds } } });
  await prisma.mcpRuntimeGeneration.deleteMany({ where: { OR: [
    { revision: { serverId: { in: serverIds } } },
    { userServer: { serverId: { in: serverIds } } },
    { sharedServerId: { in: serverIds } }
  ] } });
  await prisma.projectMcpBinding.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds } } });
  await prisma.mcpOAuthClient.deleteMany({ where: { id: { in: owned.oauthClients.splice(0) } } });
  await prisma.project.deleteMany({ where: { id: { in: owned.projects.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

async function user(role: "admin" | "user"): Promise<string> {
  const created = await prisma.user.create({ data: {
    displayName: "Local MCP removal fixture",
    email: `local-mcp-removal-${randomUUID()}@example.test`,
    role,
    status: "active"
  } });
  owned.users.push(created.id);
  return created.id;
}

async function server(input: Readonly<{
  archived?: boolean;
  draft: object;
  ownerUserId?: string;
  revisions?: readonly object[];
  activeRevision?: number;
  tested?: boolean;
}>): Promise<{ id: string; revisionIds: string[] }> {
  const created = await prisma.mcpServer.create({
    data: {
      ...(input.archived ? { archivedAt: new Date() } : {}),
      displayName: "Local MCP removal fixture",
      draft: input.draft as Prisma.InputJsonValue,
      enabled: true,
      namespace: `local_removal_${randomUUID().replaceAll("-", "")}`,
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      ...(input.tested ? { draftTestEvidence: { synthetic: true }, testedDraftHash: "c".repeat(64) } : {})
    },
    select: { id: true }
  });
  owned.servers.push(created.id);
  const revisionIds: string[] = [];
  for (const [index, configuration] of (input.revisions ?? []).entries()) {
    const revision = await prisma.mcpRevision.create({ data: {
      configuration: configuration as Prisma.InputJsonValue,
      draftHash: String(index).repeat(64),
      identityHash: `identity-${index}`,
      revisionNumber: index + 1,
      serverId: created.id,
      validationEvidence: { evidence: {}, testedAt: new Date(0).toISOString(), toolInventory: [] }
    } });
    revisionIds.push(revision.id);
  }
  if (input.activeRevision !== undefined) {
    await prisma.mcpServer.update({ data: { activeRevisionId: revisionIds[input.activeRevision]! }, where: { id: created.id } });
  }
  return { id: created.id, revisionIds };
}

/** Member preference, grant, tool policy, Project binding and a runtime generation. */
async function children(input: Readonly<{
  oauth?: boolean;
  projectId?: string;
  revisionId: string;
  serverId: string;
  shared?: boolean;
  userId: string;
}>): Promise<{ generationId: string; fingerprint: string; oauthClientId?: string }> {
  const preference = await prisma.mcpUserServer.create({ data: { enabled: true, serverId: input.serverId, userId: input.userId } });
  await prisma.mcpGrant.create({ data: { canUse: true, serverId: input.serverId, userId: input.userId } });
  await prisma.mcpToolAccessPolicy.create({ data: {
    restricted: true, serverId: input.serverId, toolName: "read", users: { create: { userId: input.userId } }
  } });
  if (input.projectId) await prisma.projectMcpBinding.create({ data: { projectId: input.projectId, serverId: input.serverId } });
  const oauthClient = input.oauth
    ? await prisma.mcpOAuthClient.create({ data: {
      clientId: "local-removal-client", clientMetadata: {}, registrationKey: `local-removal-${randomUUID()}`
    } })
    : null;
  if (oauthClient) owned.oauthClients.push(oauthClient.id);
  const connection = oauthClient
    ? await prisma.mcpOAuthConnection.create({ data: {
      oauthClientId: oauthClient.id, policyFingerprint: "local-removal", purpose: "user", serverId: input.serverId, userId: input.userId
    } })
    : null;
  if (input.shared) {
    await prisma.mcpSharedRuntime.create({ data: { serverId: input.serverId } });
    await prisma.mcpRuntimeGeneration.create({ data: {
      fingerprint: fingerprint(), revisionId: input.revisionId, sharedServerId: input.serverId, state: "ready"
    } });
  }
  const generation = await prisma.mcpRuntimeGeneration.create({ data: {
    fingerprint: fingerprint(),
    ...(connection ? { oauthConnectionId: connection.id } : {}),
    revisionId: input.revisionId,
    state: "ready",
    userServerId: preference.id
  } });
  await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: generation.id }, where: { id: preference.id } });
  return {
    fingerprint: generation.fingerprint,
    generationId: generation.id,
    ...(oauthClient ? { oauthClientId: oauthClient.id } : {})
  };
}

/** Every row a server owns, as stored. */
async function snapshot(serverIds: readonly string[]): Promise<unknown> {
  const ids = [...serverIds];
  const rows = await prisma.$queryRaw<Array<{ snapshot: unknown }>>`
    WITH generation AS (
      SELECT generation.* FROM "McpRuntimeGeneration" AS generation
      JOIN "McpRevision" AS revision ON revision."id" = generation."revisionId"
      WHERE revision."serverId" = ANY(${ids}::text[])
    )
    SELECT jsonb_build_object(
      'servers', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM "McpServer" AS row_value WHERE "id" = ANY(${ids}::text[])),
      'revisions', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM "McpRevision" AS row_value WHERE "serverId" = ANY(${ids}::text[])),
      'generations', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM generation AS row_value),
      'runBindings', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM "McpRunBinding" AS row_value
        WHERE "runtimeGenerationId" IN (SELECT "id" FROM generation)),
      'grants', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM "McpGrant" AS row_value WHERE "serverId" = ANY(${ids}::text[])),
      'toolPolicies', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM "McpToolAccessPolicy" AS row_value WHERE "serverId" = ANY(${ids}::text[])),
      'toolUsers', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "policyId", "userId") FROM "McpToolUserGrant" AS row_value
        WHERE "policyId" IN (SELECT "id" FROM "McpToolAccessPolicy" WHERE "serverId" = ANY(${ids}::text[]))),
      'userServers', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM "McpUserServer" AS row_value WHERE "serverId" = ANY(${ids}::text[])),
      'sharedRuntimes', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "serverId") FROM "McpSharedRuntime" AS row_value WHERE "serverId" = ANY(${ids}::text[])),
      'projectBindings', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "projectId") FROM "ProjectMcpBinding" AS row_value WHERE "serverId" = ANY(${ids}::text[])),
      'activationJobs', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM "McpActivationJob" AS row_value WHERE "serverId" = ANY(${ids}::text[])),
      'oauthConnections', (SELECT jsonb_agg(to_jsonb(row_value) ORDER BY "id") FROM "McpOAuthConnection" AS row_value WHERE "serverId" = ANY(${ids}::text[]))
    ) AS "snapshot"
  `;
  return rows[0]!.snapshot;
}

describe("local MCP removal bootstrap gate", () => {
  it("refuses without consent, then deletes exactly the local set in foreign-key order", async () => {
    expect(localMcpLeftoverCount(await inspect()), "the disposable database already holds local MCP rows").toBe(0);

    const adminId = await user("admin");
    const memberId = await user("user");
    const project = await prisma.project.create({ data: {
      createdByDisplayName: "Local MCP removal fixture",
      createdByUserId: adminId,
      grants: { create: { role: "OWNER", userId: adminId } },
      name: "Local MCP removal fixture"
    }, select: { id: true } });
    owned.projects.push(project.id);

    // Untouched: remote servers with and without an active revision.
    const remote = await server({ activeRevision: 0, draft: remoteDraft, revisions: [remoteDraft] });
    const remoteBinding = await children({
      projectId: project.id, revisionId: remote.revisionIds[0]!, serverId: remote.id, shared: true, userId: memberId
    });
    await prisma.mcpActivationJob.create({ data: {
      draftHash: "d".repeat(64), serverId: remote.id, sharedConfigVersion: 0, stage: "connecting"
    } });
    const unpublished = await server({ draft: remoteDraft });

    // Local servers: local active revision over remote history (OAuth-bound
    // generation and a Project binding), local draft without a revision,
    // archived, and personal.
    const localActive = await server({ activeRevision: 1, draft: localDraft("npm"), revisions: [remoteDraft, localDraft("npm")] });
    const localActiveGeneration = await children({
      oauth: true, projectId: project.id, revisionId: localActive.revisionIds[1]!, serverId: localActive.id, shared: true, userId: memberId
    });
    const localHistoryGeneration = await prisma.mcpRuntimeGeneration.create({ data: {
      fingerprint: fingerprint(), revisionId: localActive.revisionIds[0]!, sharedServerId: localActive.id, state: "idle"
    } });
    const localDraftOnly = await server({ draft: localDraft("pypi") });
    const archivedLocal = await server({ archived: true, draft: localDraft("oci") });
    const personalLocal = await server({
      activeRevision: 0, draft: localDraft("npm"), ownerUserId: memberId, revisions: [localDraft("npm")]
    });

    // Not local: a remote active revision over local history, and a remote
    // active revision under a local draft.
    const localHistory = await server({ activeRevision: 1, draft: otherRemoteDraft, revisions: [localDraft("oci"), otherRemoteDraft] });
    const localHistoryBinding = await children({
      revisionId: localHistory.revisionIds[0]!, serverId: localHistory.id, userId: memberId
    });
    const resetDraft = await server({
      activeRevision: 0, draft: localDraft("npm"), revisions: [otherRemoteDraft], tested: true
    });
    await prisma.mcpActivationJob.create({ data: {
      draftHash: "e".repeat(64), serverId: resetDraft.id, sharedConfigVersion: 0, stage: "publishing"
    } });

    // One accepted run bound to an untouched, a local and a local-history generation.
    const chat = await prisma.chat.create({ data: { title: "Local MCP removal fixture", userId: memberId } });
    owned.chats.push(chat.id);
    const question = await prisma.message.create({ data: {
      chatId: chat.id, content: textMessageContent("Synthetic question"), role: "user", status: "complete"
    } });
    const answer = await prisma.message.create({ data: {
      chatId: chat.id, content: textMessageContent(""), parentMessageId: question.id, role: "assistant", status: "streaming"
    } });
    const run = await prisma.modelRun.create({ data: {
      assistantMessageId: answer.id, chatId: chat.id, modelId: "fake-qsa", normalizedRequest: {}, provider: "fake",
      status: "in_progress", userId: memberId, userMessageId: question.id
    } });
    for (const bound of [remoteBinding, localActiveGeneration, localHistoryBinding]) {
      await prisma.mcpRunBinding.create({ data: {
        modelRunId: run.id, runtimeGenerationFingerprint: bound.fingerprint, runtimeGenerationId: bound.generationId
      } });
    }

    const expected: LocalMcpLeftovers = {
      localDraftServerIds: [resetDraft.id],
      localServerIds: [localActive.id, localDraftOnly.id, archivedLocal.id, personalLocal.id].sort(),
      otherLocalRevisionIds: [localHistory.revisionIds[0]!]
    };
    expect(await inspect()).toEqual(expected);

    const untouched = [remote.id, unpublished.id];
    const everything = owned.servers.slice();
    const untouchedBefore = await snapshot(untouched);
    const everythingBefore = await snapshot(everything);

    await expect(gate(false)).rejects.toThrow("local_mcp_refused:6");
    expect(await snapshot(everything)).toEqual(everythingBefore);

    await expect(gate(true)).resolves.toEqual({ removedCount: 6 });

    expect(await snapshot(untouched)).toEqual(untouchedBefore);
    const remaining = await prisma.mcpServer.findMany({ select: { id: true }, where: { id: { in: everything } } });
    expect(remaining.map(({ id }) => id).sort()).toEqual([remote.id, unpublished.id, localHistory.id, resetDraft.id].sort());
    for (const serverId of expected.localServerIds) {
      const where = { serverId };
      expect(await prisma.mcpRevision.count({ where })).toBe(0);
      expect(await prisma.mcpGrant.count({ where })).toBe(0);
      expect(await prisma.mcpToolAccessPolicy.count({ where })).toBe(0);
      expect(await prisma.mcpUserServer.count({ where })).toBe(0);
      expect(await prisma.mcpOAuthConnection.count({ where })).toBe(0);
      expect(await prisma.projectMcpBinding.count({ where })).toBe(0);
      expect(await prisma.mcpSharedRuntime.count({ where })).toBe(0);
    }
    // The OAuth client of the removed connection goes with it.
    expect(await prisma.mcpOAuthClient.count({ where: { id: localActiveGeneration.oauthClientId! } })).toBe(0);
    expect(await prisma.mcpRuntimeGeneration.count({ where: { id: { in: [
      localActiveGeneration.generationId, localHistoryGeneration.id, localHistoryBinding.generationId
    ] } } })).toBe(0);

    // The local-history server keeps its remote revision and member state.
    const history = await prisma.mcpServer.findUniqueOrThrow({
      select: { activeRevisionId: true, draft: true, revisions: { select: { id: true } } },
      where: { id: localHistory.id }
    });
    expect(history).toEqual({
      activeRevisionId: localHistory.revisionIds[1], draft: otherRemoteDraft, revisions: [{ id: localHistory.revisionIds[1] }]
    });
    expect(await prisma.mcpUserServer.findFirstOrThrow({ where: { serverId: localHistory.id } }))
      .toMatchObject({ desiredRuntimeGenerationId: null, enabled: true });

    // The local draft returns to the active configuration, untested, without its job.
    const reset = await prisma.mcpServer.findUniqueOrThrow({ where: { id: resetDraft.id } });
    expect(reset).toMatchObject({
      activeRevisionId: resetDraft.revisionIds[0], draft: otherRemoteDraft, draftTestEvidence: null, testedDraftHash: null
    });
    expect(await prisma.mcpActivationJob.count({ where: { serverId: resetDraft.id } })).toBe(0);

    // Accepted runs keep their exact fingerprints.
    const bindings = await prisma.mcpRunBinding.findMany({
      orderBy: { runtimeGenerationFingerprint: "asc" },
      select: { runtimeGenerationFingerprint: true, runtimeGenerationId: true },
      where: { modelRunId: run.id }
    });
    expect(bindings).toEqual([
      { runtimeGenerationFingerprint: remoteBinding.fingerprint, runtimeGenerationId: remoteBinding.generationId },
      { runtimeGenerationFingerprint: localActiveGeneration.fingerprint, runtimeGenerationId: null },
      { runtimeGenerationFingerprint: localHistoryBinding.fingerprint, runtimeGenerationId: null }
    ].sort((left, right) => left.runtimeGenerationFingerprint.localeCompare(right.runtimeGenerationFingerprint)));

    // The admin catalog lists every remaining installation server.
    const catalog = await createPrismaMcpRepository({ encryptionKey: () => key, prisma }).listAdminServers(adminId);
    expect(catalog.map(({ id }) => id).filter((id) => everything.includes(id)).sort())
      .toEqual([remote.id, unpublished.id, localHistory.id, resetDraft.id].sort());

    // A second start is a no-op with or without the acknowledgement.
    const afterRemoval = await snapshot(everything);
    await expect(gate(true)).resolves.toEqual({ removedCount: 0 });
    await expect(gate(false)).resolves.toEqual({ removedCount: 0 });
    expect(await snapshot(everything)).toEqual(afterRemoval);
  });
});
