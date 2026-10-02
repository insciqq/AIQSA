import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MCP_POLICY_ID } from "@/lib/contracts/mcpPolicy";
import { prisma } from "../prisma";
import { createPrismaMcpPolicyRepository } from "./policyRepository";

const repository = createPrismaMcpPolicyRepository(prisma);
const serverIds: string[] = [];
const userIds: string[] = [];
let original: { personalLocalNetworkEnabled: boolean; version: number } | null = null;

beforeAll(async () => {
  original = await prisma.mcpPolicy.findUniqueOrThrow({
    select: { personalLocalNetworkEnabled: true, version: true },
    where: { id: MCP_POLICY_ID }
  });
});

afterEach(async () => {
  await prisma.mcpUserServer.updateMany({ data: { desiredRuntimeGenerationId: null }, where: { serverId: { in: serverIds } } });
  await prisma.mcpRuntimeGeneration.deleteMany({ where: { userServer: { serverId: { in: serverIds } } } });
  await prisma.mcpUserServer.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpGrant.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpServer.updateMany({ data: { activeRevisionId: null }, where: { id: { in: serverIds } } });
  await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
  await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds.splice(0) } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
});

afterAll(async () => {
  // The singleton is installation state: restore exactly what this file found.
  if (original) {
    await prisma.mcpPolicy.update({ data: original, where: { id: MCP_POLICY_ID } });
  }
});

/** A personal connection with one generation per state/errorCode pair. */
async function connection(generations: readonly Readonly<{ errorCode: string | null; state: "failed" | "ready" }>[]) {
  const user = await prisma.user.create({ data: {
    displayName: "Local network fixture", email: `mcp-local-network-${randomUUID()}@example.test`, status: "active"
  } });
  userIds.push(user.id);
  const server = await prisma.mcpServer.create({ data: {
    displayName: "NAS tools", enabled: true, namespace: `local-network-${randomUUID()}`, ownerUserId: user.id
  } });
  serverIds.push(server.id);
  const revision = await prisma.mcpRevision.create({ data: {
    configuration: {}, draftHash: randomUUID(), identityHash: randomUUID(), revisionNumber: 1, serverId: server.id, validationEvidence: {}
  } });
  const preference = await prisma.mcpUserServer.create({ data: { enabled: true, serverId: server.id, userId: user.id } });
  const retryAt = new Date(Date.now() + 300_000);
  const ids: string[] = [];
  for (const generation of generations) {
    const created = await prisma.mcpRuntimeGeneration.create({ data: {
      errorCode: generation.errorCode, fingerprint: randomUUID(), retryAt, revisionId: revision.id,
      state: generation.state, userServerId: preference.id
    } });
    ids.push(created.id);
  }
  return { ids, retryAt };
}

describe("installation MCP policy persistence", () => {
  it("is versioned and refuses a stale writer", async () => {
    const current = await repository.read();
    expect(current.version).toBeGreaterThanOrEqual(1);
    const off = await repository.update({ expectedVersion: current.version, personalLocalNetworkEnabled: false });
    expect(off).toEqual({ kind: "ok", policy: { personalLocalNetworkEnabled: false, version: current.version + 1 } });
    await expect(repository.update({ expectedVersion: current.version, personalLocalNetworkEnabled: true }))
      .resolves.toEqual({ kind: "stale" });
    await expect(repository.read()).resolves.toEqual({ personalLocalNetworkEnabled: false, version: current.version + 1 });
  });

  it("keeps the singleton and version constraints in the database", async () => {
    await expect(prisma.mcpPolicy.create({ data: { id: "second" } })).rejects.toThrow();
    await expect(prisma.mcpPolicy.update({ data: { version: 0 }, where: { id: MCP_POLICY_ID } })).rejects.toThrow();
  });

  it("lets runtimes refused while the switch was off reconnect at once when it is turned on", async () => {
    const { ids: [refused, otherFailure, ready], retryAt } = await connection([
      { errorCode: "mcp_local_network_disabled", state: "failed" },
      { errorCode: "mcp_connect_failed", state: "failed" },
      { errorCode: null, state: "ready" }
    ]);
    const current = await repository.read();
    const off = await repository.update({ expectedVersion: current.version, personalLocalNetworkEnabled: false });
    if (off.kind !== "ok") throw new Error("fixture_policy_update_failed");
    await expect(prisma.mcpRuntimeGeneration.findUniqueOrThrow({ where: { id: refused! } }))
      .resolves.toMatchObject({ retryAt });
    await repository.update({ expectedVersion: off.policy.version, personalLocalNetworkEnabled: true });
    const after = await prisma.mcpRuntimeGeneration.findMany({ select: { id: true, retryAt: true }, where: { id: { in: [refused!, otherFailure!, ready!] } } });
    expect(Object.fromEntries(after.map((row) => [row.id, row.retryAt]))).toEqual({
      [refused!]: null,
      [otherFailure!]: retryAt,
      [ready!]: retryAt
    });
  });
});
