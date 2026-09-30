import {
  Prisma,
  type MessageStatus,
  type ModelRunStatus
} from "@prisma/client";
import { decodeSearchPlan } from "../../domain/search";
import {
  ActiveRunConflictError,
  type DurableRunControlRecord
} from "./runRepositoryContract";
import type { ProjectRunRecoveryAuthority } from "./toolLoopPersistence";

export function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A rollback-safe PostgreSQL serialization failure (40001) or deadlock
 * (40P01) in any form Prisma surfaces it; the whole transaction may retry. */
export function isPrismaSerializationConflict(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2034" ||
      (error.code === "P2010" &&
        isRecord(error.meta) &&
        (error.meta.code === "40001" || error.meta.code === "40P01"));
  }
  // Prisma createMany can surface rollback-safe PostgreSQL conflicts as an
  // UnknownRequestError instead of P2010. Match the structured connector code,
  // never arbitrary query text, so unrelated database failures still escape.
  return error instanceof Prisma.PrismaClientUnknownRequestError &&
    /PostgresError\s*\{\s*code:\s*"(?:40001|40P01)"/u.test(error.message);
}

/** A successor can now be admitted during predecessor cleanup. Match its
 * Project/owner -> chat -> run order before any terminal writer locks a run. */
export async function lockRunSettlementScope(tx: Prisma.TransactionClient, runId: string): Promise<void> {
  const [scope] = await tx.$queryRaw<Array<{ chatId: string; projectId: string | null; userId: string }>>(Prisma.sql`
    SELECT r."chatId", r."userId", c."projectId" FROM "ModelRun" r
    JOIN "Chat" c ON c."id" = r."chatId" WHERE r."id" = ${runId}
  `);
  if (!scope) return;
  if (scope.projectId) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${scope.projectId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${scope.userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${scope.chatId} FOR UPDATE`;
}

export const dispatchableModelRunStatuses: ModelRunStatus[] = [
  "streaming",
  "queued",
  "in_progress"
];

export function isRecoveredRunTerminalPayload(value: unknown): boolean {
  return isRecord(value) && value.recoveryTerminal === true;
}

export function activeToolLoopRun(run: Readonly<{ status: ModelRunStatus; errorPayload: unknown }>): boolean {
  return dispatchableModelRunStatuses.includes(run.status) ||
    (run.status === "error" && !isRecoveredRunTerminalPayload(run.errorPayload));
}

/** The same predicate as activeToolLoopRun for set-based SQL guards. `alias`
 * names a "ModelRun" row in the enclosing query; statuses are enum literals. */
export function activeToolLoopRunSql(alias: string): Prisma.Sql {
  if (!/^[a-z][a-z_]*$/u.test(alias)) throw new Error("tool_loop_run_alias_invalid");
  const statuses = dispatchableModelRunStatuses.map((status) => `'${status}'`).join(", ");
  return Prisma.raw(`("${alias}"."status" IN (${statuses}) OR ("${alias}"."status" = 'error' AND NOT COALESCE(` +
    `jsonb_typeof("${alias}"."errorPayload") = 'object' AND "${alias}"."errorPayload" -> 'recoveryTerminal' = 'true'::jsonb, false)))`);
}

export const activeModelRunStatuses: ModelRunStatus[] = [
  "preparing",
  ...dispatchableModelRunStatuses
];

export const activeMessageStatuses: MessageStatus[] = ["streaming", "queued"];

export function acceptedRunStatus(status: ModelRunStatus): DurableRunControlRecord["status"] {
  if (status === "preparing") {
    throw new Error("memory_preparing_run_not_finalized");
  }
  return status;
}

export function projectRunRecoveryAuthority(binding: Readonly<{
  accessRevision: number;
  instructionsRevision: number;
  memoryRevision: number;
  policyRevision: number;
  projectId: string;
  providerAdmissionFingerprint: string | null;
  providerConnectionId: string | null;
  providerModelId: string | null;
  providerRequiresClientTools: boolean;
  providerSearchPlan: unknown;
}> | null): ProjectRunRecoveryAuthority | undefined {
  if (!binding) return undefined;
  const searchPlan = decodeSearchPlan(binding.providerSearchPlan);
  const revisions = [
    binding.accessRevision,
    binding.instructionsRevision,
    binding.memoryRevision,
    binding.policyRevision
  ];
  if (
    revisions.some((revision) => !Number.isSafeInteger(revision) || revision < 0) ||
    !binding.projectId ||
    !binding.providerAdmissionFingerprint ||
    !binding.providerConnectionId ||
    !binding.providerModelId ||
    !searchPlan.ok
  ) {
    throw new Error("project_run_binding_invalid");
  }
  return {
    accessRevision: binding.accessRevision,
    instructionsRevision: binding.instructionsRevision,
    memoryRevision: binding.memoryRevision,
    policyRevision: binding.policyRevision,
    projectId: binding.projectId,
    providerAdmissionFingerprint: binding.providerAdmissionFingerprint,
    providerConnectionId: binding.providerConnectionId,
    providerModelId: binding.providerModelId,
    providerRequiresClientTools: binding.providerRequiresClientTools,
    providerSearchPlan: searchPlan.plan
  };
}

export function runControlRecord(run: {
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  provider: string;
  providerResponseId: string | null;
  status: ModelRunStatus;
}): DurableRunControlRecord {
  return {
    assistantMessageId: run.assistantMessageId,
    chatId: run.chatId,
    id: run.id,
    modelId: run.modelId,
    provider: run.provider,
    providerResponseId: run.providerResponseId,
    status: acceptedRunStatus(run.status)
  };
}

const activeRunIndexes = new Set([
  "ModelRun_one_active_per_chat_idx",
  "ModelRun_one_workspace_wait_per_chat_idx"
]);

function namesActiveRunIndex(value: unknown): boolean {
  return typeof value === "string" && activeRunIndexes.has(value);
}

function isPrismaActiveRunUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const meta = isRecord(error.meta) ? error.meta : null;
    if (meta?.modelName !== undefined && meta.modelName !== "ModelRun") return false;
    const target = meta?.target;
    if (namesActiveRunIndex(target)) return true;
    return Array.isArray(target) && target.length === 1 &&
      (namesActiveRunIndex(target[0]) || meta?.modelName === "ModelRun" && target[0] === "chatId");
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return error.code === "P2010" && isRecord(error.meta) && error.meta.code === "23505" &&
      typeof error.meta.message === "string" &&
      /\bconstraint "(ModelRun_one_active_per_chat_idx|ModelRun_one_workspace_wait_per_chat_idx)"/u.test(error.meta.message);
  }
  // Raw connector failures lack P2002 metadata. Only an exact known index in
  // a uniqueness diagnostic proves this conflict; generic duplicate keys do not.
  return error instanceof Error &&
    /(?:Unique constraint failed|duplicate key value violates unique constraint)/u.test(error.message) &&
    /["`'](ModelRun_one_active_per_chat_idx|ModelRun_one_workspace_wait_per_chat_idx)["`']/u.test(error.message);
}

export async function mapActiveRunConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPrismaActiveRunUniqueViolation(error)) {
      throw new ActiveRunConflictError();
    }

    throw error;
  }
}
