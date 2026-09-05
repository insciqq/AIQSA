import type { Prisma, WorkspaceSession } from "@prisma/client";
import { WORKSPACE_PERMANENT_EXPORT_ERROR_CODES } from "@/lib/domain/workspace";
import type { WorkspaceOperation } from "./operationFence";

export const WORKSPACE_OPERATION_LEASE_MS = 120_000;

/** The same Chat -> WorkspaceSession order used by run admission. */
export async function lockWorkspaceSession(tx: Prisma.TransactionClient, sessionId: string): Promise<WorkspaceSession | null> {
  const observed = await tx.workspaceSession.findUnique({ select: { chatId: true }, where: { id: sessionId } });
  if (!observed) return null;
  await tx.$queryRaw`SELECT "id" FROM "Chat" WHERE "id" = ${observed.chatId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id" = ${sessionId} FOR UPDATE`;
  const session = await tx.workspaceSession.findUnique({ where: { id: sessionId } });
  return session?.chatId === observed.chatId ? session : null;
}

export function workspaceRunOperationOwner(runId: string): string {
  return `run:${runId}`;
}

export function workspaceOperationWhere(operation: WorkspaceOperation): Prisma.WorkspaceSessionWhereInput {
  return { operationOwner: operation.owner, version: operation.generation };
}

/** Caller holds the session fence (or runs offline restore) and has proved disk loss. */
export async function failWorkspaceExportsForLostDisk(
  tx: Prisma.TransactionClient,
  sessionId: string | null,
  currentRunId?: string
): Promise<void> {
  await tx.workspaceRunBinding.updateMany({
    data: { exportState: "FAILED", exportLeaseToken: null, exportLeaseExpiresAt: null,
      lastExportErrorCode: "workspace_session_lost" },
    where: {
      ...(sessionId ? { workspaceSessionId: sessionId } : {}),
      ...(currentRunId ? { modelRunId: { not: currentRunId } } : {}),
      exportState: { not: "COMPLETE" },
      OR: [{ lastExportErrorCode: null }, { lastExportErrorCode: { notIn: [...WORKSPACE_PERMANENT_EXPORT_ERROR_CODES] } }]
    }
  });
}
