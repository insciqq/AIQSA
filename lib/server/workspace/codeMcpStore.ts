import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { AGENT_GATEWAY_ORIGIN } from "../agents/relay";
import type { McpCapabilityCatalog, McpRunPlanSnapshot } from "../mcp/runPlan";
import { toolActivityDescriptors } from "../tools/activityDescriptors";
import {
  WORKSPACE_CODE_GATEWAY_ENV,
  WORKSPACE_CODE_TOKEN_ENV,
  WORKSPACE_CODE_UNAVAILABLE_ENV,
  isWorkspaceCodeInvocationId,
  workspaceCodeMcpEligibility,
  type NormalizedWorkspaceCodeMcp,
  type WorkspaceRunEnvironment
} from "./codeMcp";
import { summarizeWorkspaceCodeCalls, type WorkspaceCodeCallSummary, type WorkspaceCodeToolLabel } from "./codeMcpSummary";
import { WorkspaceRuntimeError } from "./runtime";
import { lockWorkspaceSession, workspaceRunOperationOwner } from "./sessionOperation";

const ACTIVE_RUN_STATUSES = ["queued", "in_progress", "streaming"] as const;

/** Same digest as Agent run bearers: the gateway hashes every bearer once. */
export function workspaceCodeTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type WorkspaceCodeGrantIssue = Readonly<{
  /** Delivered with the run's managed environment file to every command. */
  environment: WorkspaceRunEnvironment;
  /** Raw bearer, only for exact output masking in this process. */
  token?: string;
}>;

export type WorkspaceCodeInvocationKind = "command" | "session";

export type WorkspaceCodeRunIdentity = Readonly<{
  operationGeneration: number;
  operationOwner: string | null;
  runId: string;
  sessionId: string;
  userId: string;
}>;

type FrozenRow = {
  agent: boolean;
  catalogTools: boolean;
  planTools: boolean;
  project: boolean;
  workspace: Prisma.JsonValue | null;
};

/** Coordinator side: mint, rotate and revoke the run grant; open and close invocations; summarize. */
export function createPrismaWorkspaceCodeGrantRepository(prisma: PrismaClient) {
  return {
    /**
     * Rotates the run's bearer for a guest (re)initialization and fences the
     * previous one: its open invocations and dispatching receipts become
     * unknown, since no live caller of this run can observe them any more.
     * A revoked grant is never issued again.
     */
    async issueCodeGrant(binding: WorkspaceCodeRunIdentity): Promise<WorkspaceCodeGrantIssue> {
      const [frozen] = await prisma.$queryRaw<FrozenRow[]>(Prisma.sql`
        SELECT (run."normalizedRequest" -> 'agent') IS NOT NULL AND jsonb_typeof(run."normalizedRequest" -> 'agent') <> 'null' AS "agent",
          run."normalizedRequest" -> 'workspace' AS "workspace",
          COALESCE((
            SELECT bool_or(CASE WHEN jsonb_typeof(server -> 'tools') = 'array'
              THEN jsonb_array_length(server -> 'tools') > 0 ELSE false END)
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(run."normalizedRequest" #> '{mcpDiscovery,catalog,servers}') = 'array'
              THEN run."normalizedRequest" #> '{mcpDiscovery,catalog,servers}' ELSE '[]'::jsonb END) AS server
          ), false) AS "catalogTools",
          CASE WHEN jsonb_typeof(run."normalizedRequest" #> '{mcp,tools}') = 'array'
            THEN jsonb_array_length(run."normalizedRequest" #> '{mcp,tools}') > 0 ELSE false END AS "planTools",
          chat."projectId" IS NOT NULL AS "project"
        FROM "ModelRun" AS run
        JOIN "Chat" AS chat ON chat."id" = run."chatId"
        WHERE run."id" = ${binding.runId} AND run."userId" = ${binding.userId}
          AND run."status" IN ('queued'::"ModelRunStatus", 'in_progress'::"ModelRunStatus", 'streaming'::"ModelRunStatus")
      `);
      if (!frozen) return { environment: {} };
      const eligibility = workspaceCodeMcpEligibility({
        ...(frozen.agent ? { agent: true } : {}),
        project: frozen.project,
        workspace: frozen.workspace && typeof frozen.workspace === "object" && !Array.isArray(frozen.workspace)
          ? frozen.workspace as Record<string, unknown> : null,
        mcp: { tools: frozen.planTools ? [true] : [] },
        mcpDiscovery: { catalog: { servers: frozen.catalogTools ? [{ tools: [true] }] : [] } }
      });
      if (eligibility.kind === "agent") return { environment: {} };
      if (eligibility.kind === "unavailable") return { environment: { [WORKSPACE_CODE_UNAVAILABLE_ENV]: eligibility.reason } };
      const token = randomBytes(32).toString("base64url");
      const issued = await prisma.$transaction(async (tx) => {
        const session = await lockWorkspaceSession(tx, binding.sessionId);
        if (!session || session.state === "DELETING" || binding.operationOwner !== workspaceRunOperationOwner(binding.runId) ||
          session.operationOwner !== binding.operationOwner || session.version !== binding.operationGeneration) {
          throw new WorkspaceRuntimeError("workspace_operation_stale");
        }
        await tx.$queryRaw`SELECT "modelRunId" FROM "WorkspaceCodeGrant" WHERE "modelRunId" = ${binding.runId} FOR UPDATE`;
        const current = await tx.workspaceCodeGrant.findUnique({ where: { modelRunId: binding.runId },
          select: { revokedAt: true } });
        if (current?.revokedAt) return false;
        const now = new Date();
        await tx.workspaceCodeGrant.upsert({ where: { modelRunId: binding.runId },
          create: { modelRunId: binding.runId, workspaceSessionId: binding.sessionId,
            tokenHash: workspaceCodeTokenHash(token), issuedAt: now },
          update: { tokenHash: workspaceCodeTokenHash(token), issuedAt: now } });
        await tx.workspaceCodeInvocation.updateMany({ where: { modelRunId: binding.runId, state: "open" },
          data: { state: "unknown", closedAt: now } });
        await tx.workspaceCodeCall.updateMany({ where: { modelRunId: binding.runId, state: "dispatching" },
          data: { state: "unknown", settledAt: now } });
        return true;
      });
      return issued
        ? { environment: { [WORKSPACE_CODE_TOKEN_ENV]: token, [WORKSPACE_CODE_GATEWAY_ENV]: AGENT_GATEWAY_ORIGIN }, token }
        : { environment: {} };
    },

    /**
     * Every terminal path: the bearer stops working at once. A still open
     * exec session is fenced as closed; a still open command never reported
     * back, so its outcome is unknown; so is every receipt still dispatching.
     * Idempotent.
     */
    async revokeCodeGrant(input: Readonly<{ runId: string }>): Promise<void> {
      await prisma.$transaction(async (tx) => {
        const now = new Date();
        const revoked = await tx.workspaceCodeGrant.updateMany({ where: { modelRunId: input.runId, revokedAt: null },
          data: { revokedAt: now, tokenHash: null } });
        if (revoked.count === 0) return;
        await tx.workspaceCodeInvocation.updateMany({ where: { modelRunId: input.runId, state: "open", kind: "session" },
          data: { state: "closed", closedAt: now } });
        await tx.workspaceCodeInvocation.updateMany({ where: { modelRunId: input.runId, state: "open" },
          data: { state: "unknown", closedAt: now } });
        await tx.workspaceCodeCall.updateMany({ where: { modelRunId: input.runId, state: "dispatching" },
          data: { state: "unknown", settledAt: now } });
      });
    },

    /** Persisted before the command is dispatched; null when the run has no live grant. */
    async openCodeInvocation(input: Readonly<{
      kind: WorkspaceCodeInvocationKind;
      modelRunToolCallId: string;
      runId: string;
      sessionId: string;
    }>): Promise<string | null> {
      const id = randomBytes(16).toString("hex");
      return prisma.$transaction(async (tx) => {
        const [grant] = await tx.$queryRaw<Array<{ revokedAt: Date | null; tokenHash: string | null; workspaceSessionId: string }>>`
          SELECT "revokedAt", "tokenHash", "workspaceSessionId" FROM "WorkspaceCodeGrant"
          WHERE "modelRunId" = ${input.runId} FOR UPDATE`;
        if (!grant || grant.revokedAt || !grant.tokenHash || grant.workspaceSessionId !== input.sessionId) return null;
        await tx.workspaceCodeInvocation.create({ data: { id, kind: input.kind, modelRunId: input.runId,
          toolCallId: input.modelRunToolCallId } });
        return id;
      });
    },

    async closeCodeInvocation(input: Readonly<{ invocationId: string; runId: string }>): Promise<void> {
      if (!isWorkspaceCodeInvocationId(input.invocationId)) return;
      await prisma.workspaceCodeInvocation.updateMany({ where: { id: input.invocationId, modelRunId: input.runId, state: "open" },
        data: { state: "closed", closedAt: new Date() } });
    },

    /** Every code call of one accepted sandbox tool call (all its dispatch attempts). */
    async codeCallSummary(input: Readonly<{ runId: string; toolCallId: string }>): Promise<WorkspaceCodeCallSummary | null> {
      const [groups, refused] = await Promise.all([
        prisma.workspaceCodeCall.groupBy({ by: ["toolName", "state", "errorCode"], _count: { _all: true },
          where: { modelRunId: input.runId, invocation: { toolCallId: input.toolCallId } } }),
        prisma.workspaceCodeInvocation.aggregate({ _sum: { refusedCalls: true },
          where: { modelRunId: input.runId, toolCallId: input.toolCallId } })
      ]);
      if (groups.length === 0 && !refused._sum.refusedCalls) return null;
      return summarizeWorkspaceCodeCalls(groups.map((group) => ({ count: group._count._all, errorCode: group.errorCode,
        state: group.state, toolName: group.toolName })), refused._sum.refusedCalls ?? 0,
      await codeToolLabels(prisma, input.runId));
    }
  };
}

/** Display names from the run's frozen MCP authority; never the current catalog. */
async function codeToolLabels(prisma: PrismaClient, runId: string): Promise<ReadonlyMap<string, WorkspaceCodeToolLabel>> {
  const [row] = await prisma.$queryRaw<Array<{ mcp: Prisma.JsonValue | null; mcpDiscovery: Prisma.JsonValue | null }>>`
    SELECT "normalizedRequest" -> 'mcp' AS "mcp", "normalizedRequest" -> 'mcpDiscovery' AS "mcpDiscovery"
    FROM "ModelRun" WHERE "id" = ${runId}`;
  const labels = new Map<string, WorkspaceCodeToolLabel>();
  for (const [name, descriptor] of toolActivityDescriptors({ mcp: row?.mcp ?? undefined, mcpDiscovery: row?.mcpDiscovery ?? undefined })) {
    if (descriptor.origin === "mcp") labels.set(name, { toolName: descriptor.toolName,
      ...(descriptor.serverName ? { serverName: descriptor.serverName } : {}) });
  }
  return labels;
}

/** The run's frozen MCP authority as its guest code sees it. */
export type WorkspaceCodeAuthority =
  | Readonly<{ kind: "catalog"; catalog: McpCapabilityCatalog }>
  | Readonly<{ kind: "plan"; snapshot: McpRunPlanSnapshot }>;

/** A personal run's code authority: Project runs never hold a code bearer. */
export type WorkspaceCodeGatewayGrant = Readonly<{
  authority: WorkspaceCodeAuthority;
  budgets: NormalizedWorkspaceCodeMcp;
  runId: string;
  sessionId: string;
  tokenHash: string;
  /** The persisted run initiator: tool access policies apply to this user. */
  userId: string;
}>;

/** A refused gateway request; `invocation` refusals keep their own status. */
export class WorkspaceCodeAccessError extends Error {
  constructor(readonly reason: "authority" | "invocation") {
    super(`workspace_code_${reason}_refused`);
    this.name = "WorkspaceCodeAccessError";
  }
}

export type WorkspaceCodeClaim =
  | Readonly<{ kind: "claimed"; id: string; sequence: number }>
  | Readonly<{ kind: "refused"; code: "code_invocation_closed" | "code_mcp_busy" | "code_mcp_call_limit" | "code_mcp_rate_limited" | "code_token_revoked" }>;

export type WorkspaceCodeGatewayStore = Readonly<{
  load(tokenHash: string): Promise<WorkspaceCodeGatewayGrant | null>;
  /** Cheap per-step check: live bearer, active run owning its session, open invocation, active account. */
  assertActive(grant: WorkspaceCodeGatewayGrant, invocationId: string): Promise<void>;
  /** Budgets and the content-free receipt in one serialized transaction, before any preparation or dispatch. */
  claim(input: Readonly<{
    argumentHash: string;
    grant: WorkspaceCodeGatewayGrant;
    invocationId: string;
    serverId: string;
    toolName: string;
  }>): Promise<WorkspaceCodeClaim>;
  settle(input: Readonly<{
    durationMs: number;
    errorCode: string | null;
    id: string;
    resultBytes: number | null;
    runId: string;
    state: "complete" | "error" | "unknown";
  }>): Promise<void>;
}>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function decodeAuthority(snapshotValue: unknown, catalogValue: unknown): WorkspaceCodeAuthority | null {
  const catalog = record(catalogValue);
  if (catalog && catalog.version === 1 && Array.isArray(catalog.servers)) {
    return { kind: "catalog", catalog: catalog as unknown as McpCapabilityCatalog };
  }
  const snapshot = record(snapshotValue);
  if (snapshot && snapshot.version === 1 && Array.isArray(snapshot.servers) && Array.isArray(snapshot.tools)) {
    return { kind: "plan", snapshot: snapshot as unknown as McpRunPlanSnapshot };
  }
  return null;
}

export function createPrismaWorkspaceCodeGatewayStore(prisma: PrismaClient): WorkspaceCodeGatewayStore {
  return {
    async load(tokenHash) {
      const [row] = await prisma.$queryRaw<Array<{
        agent: boolean;
        catalog: Prisma.JsonValue | null;
        mcp: Prisma.JsonValue | null;
        project: boolean;
        runId: string;
        sessionId: string;
        status: string;
        userId: string;
        workspace: Prisma.JsonValue | null;
      }>>(Prisma.sql`
        SELECT code_grant."modelRunId" AS "runId", code_grant."workspaceSessionId" AS "sessionId",
          run."userId", run."status"::text AS "status", chat."projectId" IS NOT NULL AS "project",
          (run."normalizedRequest" -> 'agent') IS NOT NULL AND jsonb_typeof(run."normalizedRequest" -> 'agent') <> 'null' AS "agent",
          run."normalizedRequest" -> 'workspace' AS "workspace",
          run."normalizedRequest" -> 'mcp' AS "mcp",
          run."normalizedRequest" #> '{mcpDiscovery,catalog}' AS "catalog"
        FROM "WorkspaceCodeGrant" AS code_grant
        JOIN "ModelRun" AS run ON run."id" = code_grant."modelRunId"
        JOIN "Chat" AS chat ON chat."id" = run."chatId"
        WHERE code_grant."tokenHash" = ${tokenHash} AND code_grant."revokedAt" IS NULL
      `);
      if (!row || !(ACTIVE_RUN_STATUSES as readonly string[]).includes(row.status)) return null;
      const workspace = record(row.workspace);
      const authority = decodeAuthority(row.mcp, row.catalog);
      const eligibility = workspaceCodeMcpEligibility({ ...(row.agent ? { agent: true } : {}), project: row.project, workspace,
        mcp: authority?.kind === "plan" ? authority.snapshot : null,
        mcpDiscovery: authority?.kind === "catalog" ? { catalog: authority.catalog } : null });
      if (eligibility.kind !== "eligible" || !authority) return null;
      return { authority, budgets: eligibility.budgets, runId: row.runId, sessionId: row.sessionId, tokenHash, userId: row.userId };
    },

    async assertActive(grant, invocationId) {
      const live = await prisma.workspaceCodeGrant.findFirst({
        where: { modelRunId: grant.runId, tokenHash: grant.tokenHash, revokedAt: null,
          binding: {
            workspaceSessionId: grant.sessionId,
            workspaceSession: { operationOwner: workspaceRunOperationOwner(grant.runId), state: { not: "DELETING" } },
            modelRun: { userId: grant.userId, status: { in: [...ACTIVE_RUN_STATUSES] },
              chat: { userId: grant.userId, user: { status: "active" } } }
          } },
        select: { invocations: { where: { id: invocationId }, select: { state: true } } }
      });
      if (!live) throw new WorkspaceCodeAccessError("authority");
      if (live.invocations[0]?.state !== "open") throw new WorkspaceCodeAccessError("invocation");
    },

    async claim(input) {
      return prisma.$transaction(async (tx) => {
        const [grant] = await tx.$queryRaw<Array<{ callCount: number; revokedAt: Date | null; tokenHash: string | null }>>`
          SELECT "callCount", "revokedAt", "tokenHash" FROM "WorkspaceCodeGrant"
          WHERE "modelRunId" = ${input.grant.runId} FOR UPDATE`;
        if (!grant || grant.revokedAt || grant.tokenHash !== input.grant.tokenHash) {
          return { kind: "refused" as const, code: "code_token_revoked" as const };
        }
        const invocation = await tx.workspaceCodeInvocation.findFirst({
          where: { id: input.invocationId, modelRunId: input.grant.runId }, select: { state: true } });
        if (invocation?.state !== "open") return { kind: "refused" as const, code: "code_invocation_closed" as const };
        const { budgets } = input.grant;
        if (grant.callCount >= budgets.maxCalls) {
          await tx.workspaceCodeInvocation.update({ where: { id: input.invocationId }, data: { refusedCalls: { increment: 1 } } });
          return { kind: "refused" as const, code: "code_mcp_call_limit" as const };
        }
        const now = new Date();
        const dispatching = await tx.workspaceCodeCall.count({ where: { modelRunId: input.grant.runId, state: "dispatching" } });
        if (dispatching >= budgets.maxConcurrent) return { kind: "refused" as const, code: "code_mcp_busy" as const };
        const recent = await tx.workspaceCodeCall.count({ where: { modelRunId: input.grant.runId,
          createdAt: { gt: new Date(now.getTime() - 1_000) } } });
        if (recent >= budgets.maxPerSecond) return { kind: "refused" as const, code: "code_mcp_rate_limited" as const };
        const id = randomUUID();
        await tx.workspaceCodeCall.create({ data: { argumentHash: input.argumentHash, createdAt: now, id,
          invocationId: input.invocationId, modelRunId: input.grant.runId, sequence: grant.callCount,
          serverId: input.serverId, toolName: input.toolName } });
        await tx.workspaceCodeGrant.update({ where: { modelRunId: input.grant.runId }, data: { callCount: { increment: 1 } } });
        return { kind: "claimed" as const, id, sequence: grant.callCount };
      });
    },

    async settle(input) {
      // The first terminal writer wins: a revocation may already have made it unknown.
      await prisma.workspaceCodeCall.updateMany({ where: { id: input.id, modelRunId: input.runId, state: "dispatching" },
        data: { durationMs: Math.max(0, Math.round(input.durationMs)), errorCode: input.errorCode?.slice(0, 64) ?? null,
          resultBytes: input.resultBytes, settledAt: new Date(), state: input.state } });
    }
  };
}
