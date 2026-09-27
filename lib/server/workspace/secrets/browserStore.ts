import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { WORKSPACE_BROWSER_SESSION_MAX_COUNT, WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES } from "@/lib/contracts/workspaceSecrets";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import type { WorkspaceOperation } from "../operationFence";
import { lockWorkspaceSession, workspaceRunOperationOwner } from "../sessionOperation";
import { createWorkspaceSecretRevision, lockWorkspaceSecretOwner, pruneWorkspaceSecretRevisions, workspaceBrowserSessionBytes } from "./store";
import { workspaceBrowserSessionChecksum, workspaceBrowserSessionError, type WorkspaceBrowserSaveReport, type WorkspaceBrowserSkipCode } from "./browserSession";
import type { WorkspaceBrowserSaveItem } from "./browserCollection";

export type WorkspaceBrowserSaveInput = Readonly<{
  userId: string;
  runId: string;
  sessionId: string;
  runtimeSandboxId: string;
  operation: WorkspaceOperation;
  /** Only foreground accepted-run handoff may save while its export lease owns the VM. */
  handoffToken?: string;
  /** Pulled one item at a time, only after the save is authorized. */
  files: AsyncIterable<WorkspaceBrowserSaveItem> | Iterable<WorkspaceBrowserSaveItem>;
  skipped: readonly WorkspaceBrowserSkipCode[];
  signal?: AbortSignal;
}>;

type FileOutcome = "saved" | "unchanged" | "unauthorized" | WorkspaceBrowserSkipCode;

// Authorization is rechecked in every per-file transaction: a lease, operation
// or run state change between files ends this save without a later write.
async function authorizedSequence(tx: Prisma.TransactionClient, input: WorkspaceBrowserSaveInput): Promise<bigint | null> {
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
  return runOwner || handoffOwner ? binding.browserSessionSequence : null;
}

async function commitFile(tx: Prisma.TransactionClient, input: WorkspaceBrowserSaveInput,
  file: Readonly<{ fileName: string; bytes: Uint8Array }>, key: () => Buffer): Promise<FileOutcome> {
  input.signal?.throwIfAborted();
  await lockWorkspaceSecretOwner(tx, input.userId, true);
  const sequence = await authorizedSequence(tx, input);
  if (sequence === null) return "unauthorized";
  const owner = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { workspaceBrowserManualSequence: true } });
  const existing = await tx.workspaceSecret.findFirst({ where: { userId: input.userId, browserFileName: file.fileName }, include: { value: true } });
  // Acceptance order wins; a manual settings change fences every older run.
  if (sequence <= owner.workspaceBrowserManualSequence || existing && sequence < existing.browserWriterSequence) return "browser_session_stale";
  if (existing?.value.checksum === workspaceBrowserSessionChecksum(file.bytes)) {
    // Advance ordering even when the immutable encrypted revision is unchanged.
    await tx.workspaceSecret.update({ where: { id: existing.id }, data: { browserWriterSequence: sequence } });
    return "unchanged";
  }
  if (!existing && await tx.workspaceSecret.count({ where: { userId: input.userId, browserFileName: { not: null } } }) >= WORKSPACE_BROWSER_SESSION_MAX_COUNT) {
    return "browser_session_limit";
  }
  if (await workspaceBrowserSessionBytes(tx, input.userId, existing?.id) + file.bytes.byteLength > WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES) {
    return "browser_session_total_limit";
  }
  input.signal?.throwIfAborted();
  const secretId = existing?.id ?? randomUUID();
  const valueId = await createWorkspaceSecretRevision(tx, { userId: input.userId, secretId,
    name: existing?.value.name ?? file.fileName.slice(0, -5).slice(0, 120).replace(/[\uD800-\uDBFF]$/u, ""), description: existing?.value.description ?? "",
    value: { kind: "browser_session", originalName: file.fileName, base64: Buffer.from(file.bytes).toString("base64") }, key: key(), autoSaved: true });
  if (existing) await tx.workspaceSecret.update({ where: { id: existing.id }, data: { valueId, browserWriterSequence: sequence } });
  else await tx.workspaceSecret.create({ data: { id: secretId, userId: input.userId, valueId, browserFileName: file.fileName, browserWriterSequence: sequence } });
  // The replaced revision goes unless an accepted run still binds it.
  await pruneWorkspaceSecretRevisions(tx, input.userId);
  return "saved";
}

/**
 * The caller has quiesced this exact accepted run; settings/admission share
 * the owner lock. Each state is read, validated, encrypted and committed on its
 * own, so memory and transaction time are bounded by one state. The recorded
 * report is the only user-visible outcome and never contains names or content.
 */
export async function saveWorkspaceBrowserSessions(prisma: PrismaClient, input: WorkspaceBrowserSaveInput,
  key: () => Buffer = getSecretEncryptionKey): Promise<WorkspaceBrowserSaveReport | null> {
  // No deadline check here: an already expired deadline still records its
  // failed outcome for an authorized run instead of disappearing.
  const authorized = await prisma.$transaction(async (tx) => {
    await lockWorkspaceSecretOwner(tx, input.userId, true);
    return await authorizedSequence(tx, input) !== null;
  }, { maxWait: 1_000, timeout: 5_000 });
  if (!authorized) return null;

  const report: { saved: number; unchanged: number; skipped: Partial<Record<WorkspaceBrowserSkipCode, number>>; failure?: "browser_session_save_failed" } =
    { saved: 0, unchanged: 0, skipped: {} };
  const skip = (code: WorkspaceBrowserSkipCode) => { report.skipped[code] = (report.skipped[code] ?? 0) + 1; };
  for (const code of input.skipped.slice(0, 180)) skip(code);
  const seen = new Set<string>();
  let files = 0;
  try {
    for await (const item of input.files) {
      input.signal?.throwIfAborted();
      if ("skipped" in item) { skip(item.skipped); continue; }
      if (files >= WORKSPACE_BROWSER_SESSION_MAX_COUNT) { skip("browser_session_limit"); continue; }
      files++;
      const invalid = workspaceBrowserSessionError(item.fileName, item.bytes);
      if (invalid) { skip(invalid); continue; }
      if (seen.has(item.fileName)) { skip("browser_session_invalid"); continue; }
      seen.add(item.fileName);
      const outcome = await prisma.$transaction((tx) => commitFile(tx, input, item, key), { maxWait: 5_000, timeout: 15_000 });
      if (outcome === "saved") report.saved++;
      else if (outcome === "unchanged") report.unchanged++;
      else if (outcome === "unauthorized") { skip("browser_session_stale"); break; }
      else skip(outcome);
    }
    input.signal?.throwIfAborted();
  } catch {
    // Committed states remain; the rest keep their previous versions.
    report.failure = "browser_session_save_failed";
  }
  await prisma.workspaceRunBinding.update({ where: { modelRunId: input.runId }, data: { browserSessionSave: report as Prisma.InputJsonValue } });
  return report;
}
