// @vitest-environment node
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { textMessageContent } from "@/lib/domain/content";
import { AGENT_GATEWAY_ORIGIN } from "../agents/relay";
import { agentTokenHash } from "../agents/store";
import {
  createPrismaWorkspaceCodeGatewayStore,
  createPrismaWorkspaceCodeGrantRepository,
  workspaceCodeTokenHash,
  WorkspaceCodeAccessError,
  type WorkspaceCodeGatewayGrant
} from "./codeMcpStore";

const PREFIX = "code-mcp-store-";
const users: string[] = [];
const budgets = { version: 1, maxCalls: 3, maxConcurrent: 2, maxPerSecond: 10 };
const catalog = { version: 1, servers: [{ description: "", namespace: "gitlab", revisionId: "revision-1", serverId: "server-gitlab",
  serverName: "GitLab", tools: [{ description: "List commits", namespacedName: "mcp_gitlab_list_commits_0000000000",
    originalName: "list_commits" }] }] };

async function fixture(input: Readonly<{ normalizedRequest?: Record<string, unknown>; project?: boolean }> = {}) {
  const userId = `${PREFIX}${randomUUID()}`;
  users.push(userId);
  const user = await prisma.user.create({ data: { displayName: "Code MCP fixture", id: userId, status: "active" } });
  const project = input.project ? await prisma.project.create({ data: { createdByDisplayName: user.displayName,
    createdByUserId: userId, grants: { create: { role: "OWNER", userId } }, name: "Code MCP project" } }) : null;
  // The run's accepted Project revisions, as admission freezes them (the grant above already moved accessRevision).
  const accepted = project ? await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { accessRevision: true,
    instructionsRevision: true, memoryRevision: true, policyRevision: true } }) : null;
  const chat = await prisma.chat.create({ data: { title: "Code MCP", workspaceEnabled: true,
    ...(project ? { createdByDisplayName: user.displayName, createdByUserId: userId, memoryMode: "EXCLUDED" as const,
      projectId: project.id } : { userId }) } });
  const message = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent("Collect logs"), role: "user",
    ...(project ? { authorDisplayName: user.displayName, authorProjectRole: "OWNER" as const, authorUserId: userId } : {}) } });
  const answer = await prisma.message.create({ data: { chatId: chat.id, content: textMessageContent(""), role: "assistant",
    parentMessageId: message.id } });
  const runId = randomUUID();
  const session = await prisma.workspaceSession.create({ data: { chatId: chat.id, expiresAt: new Date(Date.now() + 600_000),
    imageRef: "aiqsa-workspace:0.1.32", internetEnabled: true, operationOwner: `run:${runId}`, policyRevision: 1,
    runtimeSandboxId: "runtime-fixture", sandboxName: `code-mcp-${randomUUID()}`, state: "RUNNING" } });
  // A Project chat's run must carry its Project binding in the same transaction (owner boundary trigger).
  await prisma.modelRun.create({ data: { assistantMessageId: answer.id, chatId: chat.id, id: runId, modelId: "fake", provider: "fake",
    status: "in_progress", userId, userMessageId: message.id,
    normalizedRequest: (input.normalizedRequest ?? { mcpDiscovery: { catalog, epochs: [], version: 2 },
      workspace: { codeMcp: budgets, enabled: true, internetEnabled: true } }) as Prisma.InputJsonValue,
    ...(project && accepted ? { projectRunBinding: { create: { ...accepted, acceptedRole: "OWNER", initiatorUserId: userId,
      personalMemoryDisabled: true, projectId: project.id } } } : {}) } });
  await prisma.workspaceRunBinding.create({ data: { imageRef: session.imageRef, internetEnabled: true, mcpVersion: "0.6.16",
    modelRunId: runId, outputDirectory: `/workspace/output/${runId}`, policyRevision: 1, runtimeVersion: "0.6.16",
    toolCatalogHash: "a".repeat(64), toolDefinitions: [], workspaceSessionId: session.id } });
  let ordinal = 0;
  const command = async () => (await prisma.modelRunToolCall.create({ data: { arguments: {}, modelRunId: runId,
    ordinal: ordinal++, providerCallId: randomUUID(), roundIndex: 0, toolName: "workspace__sandbox_shell",
    workspaceRunBindingId: runId } })).id;
  const binding = { operationGeneration: session.version, operationOwner: `run:${runId}`, runId, sessionId: session.id, userId };
  return { binding, chat, command, runId, session, userId };
}

const grants = createPrismaWorkspaceCodeGrantRepository(prisma);
const gateway = createPrismaWorkspaceCodeGatewayStore(prisma);

async function grantFor(token: string): Promise<WorkspaceCodeGatewayGrant> {
  const grant = await gateway.load(workspaceCodeTokenHash(token));
  expect(grant).not.toBeNull();
  return grant!;
}

afterEach(async () => {
  const userIds = users.splice(0);
  const chats = await prisma.chat.findMany({ where: { OR: [{ userId: { in: userIds } }, { createdByUserId: { in: userIds } }] },
    select: { id: true } });
  await prisma.modelRun.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.message.deleteMany({ where: { chatId: { in: chats.map((chat) => chat.id) } } });
  await prisma.workspaceSession.deleteMany({ where: { chatId: { in: chats.map((chat) => chat.id) } } });
  await prisma.chat.deleteMany({ where: { id: { in: chats.map((chat) => chat.id) } } });
  await prisma.project.deleteMany({ where: { createdByUserId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});
afterAll(() => prisma.$disconnect());

describe("Workspace code MCP grants", () => {
  it("stores only the bearer hash, rotates it per initialization and never reissues after revocation", async () => {
    const f = await fixture();
    const first = await grants.issueCodeGrant(f.binding);
    expect(first.environment).toEqual({ AIQSA_GATEWAY_URL: AGENT_GATEWAY_ORIGIN, AIQSA_RUN_TOKEN: first.token });
    expect(workspaceCodeTokenHash(first.token!)).toBe(agentTokenHash(first.token!));
    const row = await prisma.workspaceCodeGrant.findUniqueOrThrow({ where: { modelRunId: f.runId } });
    expect(row).toMatchObject({ revokedAt: null, tokenHash: workspaceCodeTokenHash(first.token!), workspaceSessionId: f.session.id });
    expect(JSON.stringify(row)).not.toContain(first.token);
    expect(await grantFor(first.token!)).toMatchObject({ budgets, runId: f.runId, userId: f.userId,
      authority: { kind: "catalog" } });
    // Recovery takeover or guest recreation: the previous bearer dies.
    const second = await grants.issueCodeGrant(f.binding);
    expect(second.token).not.toBe(first.token);
    expect(await gateway.load(workspaceCodeTokenHash(first.token!))).toBeNull();
    await grantFor(second.token!);
    await grants.revokeCodeGrant({ runId: f.runId });
    await grants.revokeCodeGrant({ runId: f.runId });
    expect(await gateway.load(workspaceCodeTokenHash(second.token!))).toBeNull();
    expect(await grants.issueCodeGrant(f.binding)).toEqual({ environment: {} });
    // A terminal run's bearer is refused by status even before revocation.
    const other = await fixture();
    const issued = await grants.issueCodeGrant(other.binding);
    await prisma.modelRun.update({ where: { id: other.runId }, data: { status: "complete" } });
    expect(await gateway.load(workspaceCodeTokenHash(issued.token!))).toBeNull();
  });

  it("issues nothing but a reason to Agent, Internet-Off, gateway-less and MCP-Off runs", async () => {
    const workspace = { codeMcp: budgets, enabled: true, internetEnabled: true };
    const cases: Array<[Record<string, unknown>, Record<string, string>]> = [
      [{ agent: { mcpMode: "auto" }, mcpDiscovery: { catalog, epochs: [], version: 2 }, workspace }, {}],
      [{ mcpDiscovery: { catalog, epochs: [], version: 2 }, workspace: { ...workspace, internetEnabled: false } },
        { AIQSA_MCP_UNAVAILABLE: "internet_off" }],
      [{ mcpDiscovery: { catalog, epochs: [], version: 2 }, workspace: { enabled: true, internetEnabled: true } },
        { AIQSA_MCP_UNAVAILABLE: "gateway_unavailable" }],
      [{ workspace }, { AIQSA_MCP_UNAVAILABLE: "mcp_off" }]
    ];
    for (const [normalizedRequest, environment] of cases) {
      const f = await fixture({ normalizedRequest });
      expect(await grants.issueCodeGrant(f.binding)).toEqual({ environment });
      expect(await prisma.workspaceCodeGrant.count({ where: { modelRunId: f.runId } })).toBe(0);
    }
  });

  it("refuses a stale Workspace operation before minting", async () => {
    const f = await fixture();
    await prisma.workspaceSession.update({ where: { id: f.session.id }, data: { operationOwner: "export:other:lease" } });
    await expect(grants.issueCodeGrant(f.binding)).rejects.toMatchObject({ code: "workspace_operation_stale" });
    expect(await prisma.workspaceCodeGrant.count({ where: { modelRunId: f.runId } })).toBe(0);
  });
});

describe("Workspace code MCP invocations and receipts", () => {
  it("persists content-free receipts before dispatch within the run's call, concurrency and rate budgets", async () => {
    const f = await fixture();
    const issued = await grants.issueCodeGrant(f.binding);
    const grant = await grantFor(issued.token!);
    const invocationId = (await grants.openCodeInvocation({ kind: "command", modelRunToolCallId: await f.command(),
      runId: f.runId, sessionId: f.session.id }))!;
    const claim = (toolName = "mcp_gitlab_list_commits_0000000000") => gateway.claim({ argumentHash: "c".repeat(64), grant,
      invocationId, serverId: "server-gitlab", toolName });
    const first = await claim();
    const second = await claim();
    expect([first.kind, second.kind]).toEqual(["claimed", "claimed"]);
    // Two calls still dispatching fill the concurrency budget.
    expect(await claim()).toEqual({ kind: "refused", code: "code_mcp_busy" });
    await gateway.settle({ durationMs: 12, errorCode: null, id: (first as { id: string }).id, resultBytes: 345, runId: f.runId,
      state: "complete" });
    expect((await claim()).kind).toBe("claimed");
    expect(await claim()).toEqual({ kind: "refused", code: "code_mcp_call_limit" });
    expect((await prisma.workspaceCodeInvocation.findUniqueOrThrow({ where: { id: invocationId } })).refusedCalls).toBe(1);
    const receipts = await prisma.workspaceCodeCall.findMany({ where: { modelRunId: f.runId }, orderBy: { sequence: "asc" } });
    expect(receipts.map((receipt) => [receipt.sequence, receipt.state])).toEqual([[0, "complete"], [1, "dispatching"], [2, "dispatching"]]);
    expect(Object.keys(receipts[0]!).sort()).toEqual(["argumentHash", "createdAt", "durationMs", "errorCode", "id", "invocationId",
      "modelRunId", "resultBytes", "sequence", "serverId", "settledAt", "state", "toolName"]);
    expect(receipts[0]).toMatchObject({ durationMs: 12, resultBytes: 345 });
    // Rate: a fresh run admitting more calls in one second than allowed.
    const rated = await fixture({ normalizedRequest: { mcpDiscovery: { catalog, epochs: [], version: 2 },
      workspace: { codeMcp: { ...budgets, maxCalls: 10, maxConcurrent: 10, maxPerSecond: 2 }, enabled: true, internetEnabled: true } } });
    const ratedGrant = await grantFor((await grants.issueCodeGrant(rated.binding)).token!);
    const ratedInvocation = (await grants.openCodeInvocation({ kind: "command", modelRunToolCallId: await rated.command(),
      runId: rated.runId, sessionId: rated.session.id }))!;
    const ratedClaim = () => gateway.claim({ argumentHash: "c".repeat(64), grant: ratedGrant, invocationId: ratedInvocation,
      serverId: "server-gitlab", toolName: "mcp_gitlab_list_commits_0000000000" });
    expect([(await ratedClaim()).kind, (await ratedClaim()).kind]).toEqual(["claimed", "claimed"]);
    expect(await ratedClaim()).toEqual({ kind: "refused", code: "code_mcp_rate_limited" });
  });

  it("attributes concurrent commands' receipts to their own invocations and closes each with its command", async () => {
    const f = await fixture({ normalizedRequest: { mcpDiscovery: { catalog, epochs: [], version: 2 },
      workspace: { codeMcp: { ...budgets, maxCalls: 20, maxConcurrent: 8 }, enabled: true, internetEnabled: true } } });
    const grant = await grantFor((await grants.issueCodeGrant(f.binding)).token!);
    const [callA, callB] = [await f.command(), await f.command()];
    const [a, b] = await Promise.all([callA, callB].map((modelRunToolCallId) => grants.openCodeInvocation({ kind: "command",
      modelRunToolCallId, runId: f.runId, sessionId: f.session.id })));
    await Promise.all([a, b, a, b, a].map((invocationId) => gateway.claim({ argumentHash: "c".repeat(64), grant,
      invocationId: invocationId!, serverId: "server-gitlab", toolName: "mcp_gitlab_list_commits_0000000000" })));
    const byInvocation = await prisma.workspaceCodeCall.groupBy({ by: ["invocationId"], _count: { _all: true },
      where: { modelRunId: f.runId } });
    expect(Object.fromEntries(byInvocation.map((row) => [row.invocationId, row._count._all]))).toEqual({ [a!]: 3, [b!]: 2 });
    expect(new Set((await prisma.workspaceCodeCall.findMany({ where: { modelRunId: f.runId } })).map((row) => row.sequence)).size).toBe(5);
    expect(await grants.codeCallSummary({ runId: f.runId, toolCallId: callA })).toMatchObject({ calls: 3,
      tools: [{ calls: 3, label: { serverName: "GitLab", toolName: "list_commits" } }] });
    expect(await grants.codeCallSummary({ runId: f.runId, toolCallId: callB })).toMatchObject({ calls: 2 });
    await grants.closeCodeInvocation({ invocationId: a!, runId: f.runId });
    await expect(gateway.assertActive(grant, a!)).rejects.toBeInstanceOf(WorkspaceCodeAccessError);
    expect(await gateway.claim({ argumentHash: "c".repeat(64), grant, invocationId: a!, serverId: "server-gitlab",
      toolName: "mcp_gitlab_list_commits_0000000000" })).toEqual({ kind: "refused", code: "code_invocation_closed" });
    await gateway.assertActive(grant, b!);
  });

  it("marks an earlier incarnation's open invocations and dispatching receipts unknown, and never reopens them", async () => {
    const f = await fixture();
    const grant = await grantFor((await grants.issueCodeGrant(f.binding)).token!);
    const command = (await grants.openCodeInvocation({ kind: "command", modelRunToolCallId: await f.command(), runId: f.runId,
      sessionId: f.session.id }))!;
    await gateway.claim({ argumentHash: "c".repeat(64), grant, invocationId: command, serverId: "server-gitlab",
      toolName: "mcp_gitlab_list_commits_0000000000" });
    // A recovering process initializes the guest again.
    const rotated = await grantFor((await grants.issueCodeGrant(f.binding)).token!);
    expect(await prisma.workspaceCodeInvocation.findUniqueOrThrow({ where: { id: command } })).toMatchObject({ state: "unknown" });
    expect(await prisma.workspaceCodeCall.findFirstOrThrow({ where: { invocationId: command } })).toMatchObject({ state: "unknown" });
    // The stale caller's late settlement cannot overwrite the unknown outcome.
    const receipt = await prisma.workspaceCodeCall.findFirstOrThrow({ where: { invocationId: command } });
    await gateway.settle({ durationMs: 1, errorCode: null, id: receipt.id, resultBytes: 1, runId: f.runId, state: "complete" });
    expect(await prisma.workspaceCodeCall.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({ state: "unknown" });
    // Terminal revocation: an open exec session closes, an open command is unknown.
    const session = (await grants.openCodeInvocation({ kind: "session", modelRunToolCallId: await f.command(), runId: f.runId,
      sessionId: f.session.id }))!;
    const open = (await grants.openCodeInvocation({ kind: "command", modelRunToolCallId: await f.command(), runId: f.runId,
      sessionId: f.session.id }))!;
    await gateway.claim({ argumentHash: "c".repeat(64), grant: rotated, invocationId: open, serverId: "server-gitlab",
      toolName: "mcp_gitlab_list_commits_0000000000" });
    await grants.revokeCodeGrant({ runId: f.runId });
    const states = await prisma.workspaceCodeInvocation.findMany({ where: { id: { in: [session, open] } }, select: { id: true, state: true } });
    expect(Object.fromEntries(states.map((row) => [row.id, row.state]))).toEqual({ [session]: "closed", [open]: "unknown" });
    expect(await prisma.workspaceCodeCall.count({ where: { modelRunId: f.runId, state: "dispatching" } })).toBe(0);
    expect(await grants.openCodeInvocation({ kind: "command", modelRunToolCallId: await f.command(), runId: f.runId,
      sessionId: f.session.id })).toBeNull();
  });

  it("checks the live bearer, the run's own operation and the account on every step", async () => {
    const f = await fixture();
    const grant = await grantFor((await grants.issueCodeGrant(f.binding)).token!);
    const invocationId = (await grants.openCodeInvocation({ kind: "command", modelRunToolCallId: await f.command(),
      runId: f.runId, sessionId: f.session.id }))!;
    await gateway.assertActive(grant, invocationId);
    await expect(gateway.assertActive(grant, "f".repeat(32))).rejects.toMatchObject({ reason: "invocation" });
    await prisma.workspaceSession.update({ where: { id: f.session.id }, data: { operationOwner: `export:${f.runId}:lease` } });
    await expect(gateway.assertActive(grant, invocationId)).rejects.toMatchObject({ reason: "authority" });
    await prisma.workspaceSession.update({ where: { id: f.session.id }, data: { operationOwner: `run:${f.runId}` } });
    await prisma.user.update({ where: { id: f.userId }, data: { status: "disabled" } });
    await expect(gateway.assertActive(grant, invocationId)).rejects.toMatchObject({ reason: "authority" });
  });

  it("gives a Project run no bearer, only the typed reason, since members share its Workspace", async () => {
    const f = await fixture({ project: true });
    expect(await grants.issueCodeGrant(f.binding)).toEqual({ environment: { AIQSA_MCP_UNAVAILABLE: "project_unsupported" } });
    expect(await prisma.workspaceCodeGrant.count({ where: { modelRunId: f.runId } })).toBe(0);
    expect(await grants.openCodeInvocation({ kind: "command", modelRunToolCallId: await f.command(), runId: f.runId,
      sessionId: f.session.id })).toBeNull();
    // The gateway refuses a Project run's bearer on its own as well.
    const token = "p".repeat(43);
    await prisma.workspaceCodeGrant.create({ data: { issuedAt: new Date(), modelRunId: f.runId, tokenHash: workspaceCodeTokenHash(token),
      workspaceSessionId: f.session.id } });
    expect(await gateway.load(workspaceCodeTokenHash(token))).toBeNull();
  });

  it("deletes grants, invocations and receipts with their run", async () => {
    const f = await fixture();
    const grant = await grantFor((await grants.issueCodeGrant(f.binding)).token!);
    const invocationId = (await grants.openCodeInvocation({ kind: "command", modelRunToolCallId: await f.command(),
      runId: f.runId, sessionId: f.session.id }))!;
    await gateway.claim({ argumentHash: "c".repeat(64), grant, invocationId, serverId: "server-gitlab",
      toolName: "mcp_gitlab_list_commits_0000000000" });
    await prisma.modelRun.delete({ where: { id: f.runId } });
    expect(await prisma.workspaceCodeGrant.count({ where: { modelRunId: f.runId } })).toBe(0);
    expect(await prisma.workspaceCodeInvocation.count({ where: { modelRunId: f.runId } })).toBe(0);
    expect(await prisma.workspaceCodeCall.count({ where: { modelRunId: f.runId } })).toBe(0);
  });
});
