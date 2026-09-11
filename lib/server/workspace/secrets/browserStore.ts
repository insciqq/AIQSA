import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { WORKSPACE_BROWSER_SESSION_MAX_COUNT } from "@/lib/contracts/workspaceSecrets";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import type { WorkspaceOperation } from "../operationFence";
import { lockWorkspaceSession, workspaceRunOperationOwner } from "../sessionOperation";
import { createWorkspaceSecretRevision, lockWorkspaceSecretOwner, pruneWorkspaceSecretRevisions } from "./store";
import { workspaceBrowserSessionChecksum, workspaceBrowserSessionError, type WorkspaceBrowserSaveReport, type WorkspaceBrowserSkipCode } from "./browserSession";

export type WorkspaceBrowserSaveInput = Readonly<{
  userId: string;
  runId: string;
  sessionId: string;
  runtimeSandboxId: string;
  operation: WorkspaceOperation;
  /** Only foreground accepted-run handoff may save while its export lease owns the VM. */
  handoffToken?: string;
  files: readonly Readonly<{ fileName: string; bytes: Uint8Array }>[];
  skipped: readonly WorkspaceBrowserSkipCode[];
  signal?: AbortSignal;
}>;

/** The caller has quiesced this exact accepted run; settings/admission share the owner lock. */
export async function saveWorkspaceBrowserSessions(prisma: PrismaClient, input: WorkspaceBrowserSaveInput,
  key: () => Buffer = getSecretEncryptionKey): Promise<WorkspaceBrowserSaveReport | null> {
  return prisma.$transaction(async (tx) => {
    input.signal?.throwIfAborted();
    await lockWorkspaceSecretOwner(tx, input.userId, true);
    const session = await lockWorkspaceSession(tx, input.sessionId);
    if (!session || session.state === "DELETING" || session.runtimeSandboxId !== input.runtimeSandboxId ||
      session.version !== input.operation.generation || session.operationOwner !== input.operation.owner) return null;
    const binding = await tx.workspaceRunBinding.findUnique({ where: { modelRunId: input.runId }, include: {
      modelRun: { select: { userId: true, chatId: true, status: true, chat: { select: { userId: true, projectId: true } } } }
    } });
    if (!binding?.browserSessionSequence || binding.workspaceSessionId !== session.id || binding.modelRun.chatId !== session.chatId ||
      binding.modelRun.userId !== input.userId || binding.modelRun.chat.userId !== input.userId || binding.modelRun.chat.projectId !== null) return null;
    const runOwner = input.operation.owner === workspaceRunOperationOwner(input.runId);
    const handoffOwner = input.handoffToken && input.operation.owner === `export:${input.runId}:${input.handoffToken}` &&
      binding.exportLeaseToken === input.handoffToken && binding.exportLeaseExpiresAt && binding.exportLeaseExpiresAt > new Date() &&
      ["preparing", "queued", "in_progress", "streaming"].includes(binding.modelRun.status);
    if (!runOwner && !handoffOwner) return null;

    const owner = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { workspaceBrowserManualSequence: true } });
    const report: { saved: number; unchanged: number; skipped: Partial<Record<WorkspaceBrowserSkipCode, number>> } = { saved: 0, unchanged: 0, skipped: {} };
    const skip = (code: WorkspaceBrowserSkipCode, count = 1) => { report.skipped[code] = (report.skipped[code] ?? 0) + count; };
    for (const code of input.skipped.slice(0, 180)) skip(code);
    const current = await tx.workspaceSecret.findMany({ where: { userId: input.userId, browserFileName: { not: null } }, include: { value: true } });
    const byName = new Map(current.map((entry) => [entry.browserFileName!, entry]));
    const seen = new Set<string>();
    if (input.files.length > WORKSPACE_BROWSER_SESSION_MAX_COUNT) skip("browser_session_limit", input.files.length - WORKSPACE_BROWSER_SESSION_MAX_COUNT);
    for (const file of input.files.slice(0, WORKSPACE_BROWSER_SESSION_MAX_COUNT)) {
      input.signal?.throwIfAborted();
      const invalid = workspaceBrowserSessionError(file.fileName, file.bytes);
      if (invalid) { skip(invalid); continue; }
      if (seen.has(file.fileName)) { skip("browser_session_invalid"); continue; }
      seen.add(file.fileName);
      const existing = byName.get(file.fileName);
      const sequence = binding.browserSessionSequence;
      if (sequence <= owner.workspaceBrowserManualSequence || existing && sequence < existing.browserWriterSequence) {
        skip("browser_session_stale"); continue;
      }
      if (existing?.value.checksum === workspaceBrowserSessionChecksum(file.bytes)) {
        // Advance ordering even when the immutable encrypted revision is unchanged.
        await tx.workspaceSecret.update({ where: { id: existing.id }, data: { browserWriterSequence: sequence } });
        report.unchanged++; continue;
      }
      if (!existing && byName.size >= WORKSPACE_BROWSER_SESSION_MAX_COUNT) { skip("browser_session_limit"); continue; }
      const secretId = existing?.id ?? randomUUID();
      const valueId = await createWorkspaceSecretRevision(tx, { userId: input.userId, secretId,
        name: existing?.value.name ?? file.fileName.slice(0, -5).slice(0, 120).replace(/[\uD800-\uDBFF]$/u, ""), description: existing?.value.description ?? "",
        value: { kind: "browser_session", originalName: file.fileName, base64: Buffer.from(file.bytes).toString("base64") }, key: key(), autoSaved: true });
      const row = existing
        ? await tx.workspaceSecret.update({ where: { id: existing.id }, data: { valueId, browserWriterSequence: sequence }, include: { value: true } })
        : await tx.workspaceSecret.create({ data: { id: secretId, userId: input.userId, valueId, browserFileName: file.fileName, browserWriterSequence: sequence }, include: { value: true } });
      byName.set(file.fileName, row);
      report.saved++;
    }
    await pruneWorkspaceSecretRevisions(tx, input.userId);
    input.signal?.throwIfAborted();
    await tx.workspaceRunBinding.update({ where: { modelRunId: input.runId }, data: { browserSessionSave: report as Prisma.InputJsonValue } });
    return report;
  }, { maxWait: 1_000, timeout: 5_000 });
}
