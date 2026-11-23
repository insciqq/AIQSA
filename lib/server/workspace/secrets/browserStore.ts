import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient, type WorkspaceSecretValue as StoredValue } from "@prisma/client";
import { WORKSPACE_BROWSER_SESSION_MAX_COUNT, WORKSPACE_BROWSER_SESSION_TOTAL_MAX_BYTES } from "@/lib/contracts/workspaceSecrets";
import { getSecretEncryptionKey } from "../../secrets/envelope";
import type { WorkspaceOperation } from "../operationFence";
import { lockWorkspaceSession } from "../sessionOperation";
import { isWorkspaceRunOperation, workspaceRunHoldsOperation } from "../attachments";
import {
  createWorkspaceSecretRevision, decryptWorkspaceSecret, lockWorkspaceSecretOwner, pruneWorkspaceSecretRevisions, workspaceBrowserSessionBytes
} from "./store";
import {
  workspaceBrowserSaveOrder, workspaceBrowserSessionChecksum, workspaceBrowserSessionError, workspaceBrowserSessionSavedAt,
  type WorkspaceBrowserSaveReport, type WorkspaceBrowserSkipCode
} from "./browserSession";
import type { WorkspaceBrowserSaveItem } from "./browserCollection";
import {
  BROWSER_SESSION_SERVER_TURN, browserSignInSaveFiles, serverWrittenBrowserTurn, type BrowserSaveTurn
} from "./browserSignInAuthority";
import { logEvent } from "../../observability";

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
// or run state change between files ends this save without a later write. The
// run's stored turn comes with it: whose turn it was decides what it may save.
async function authorizedRun(tx: Prisma.TransactionClient, input: WorkspaceBrowserSaveInput):
  Promise<Readonly<{ sequence: bigint; turn: BrowserSaveTurn }> | null> {
  const session = await lockWorkspaceSession(tx, input.sessionId);
  if (!session || session.state === "DELETING" || session.runtimeSandboxId !== input.runtimeSandboxId ||
    session.version !== input.operation.generation || session.operationOwner !== input.operation.owner) return null;
  const binding = await tx.workspaceRunBinding.findUnique({ where: { modelRunId: input.runId }, include: {
    modelRun: { select: { userId: true, chatId: true, status: true, chat: { select: { userId: true } }, scheduledTaskId: true,
      userMessage: { select: { scheduledTaskPrompt: true, systemTurnKind: true } } } }
  } });
  if (!binding?.browserSessionSequence || binding.workspaceSessionId !== session.id || binding.modelRun.chatId !== session.chatId ||
    binding.modelRun.userId !== input.userId || binding.modelRun.chat.userId !== input.userId) return null;
  // The run holds the operation alone or attached beside the chat's other runs (`attachments.ts`).
  const runOwner = isWorkspaceRunOperation(input.operation.owner) && await workspaceRunHoldsOperation(tx, session, input.runId);
  const handoffOwner = input.handoffToken && input.operation.owner === `export:${input.runId}:${input.handoffToken}` &&
    binding.exportLeaseToken === input.handoffToken && binding.exportLeaseExpiresAt && binding.exportLeaseExpiresAt > new Date() &&
    ["preparing", "queued", "in_progress", "streaming"].includes(binding.modelRun.status);
  return runOwner || handoffOwner ? { sequence: binding.browserSessionSequence, turn: binding.modelRun } : null;
}

/** The stamp inside a saved revision, read only when a stamped file competes with it. */
function revisionSavedAt(value: StoredValue, userId: string, key: () => Buffer): number | null {
  try {
    const secret = decryptWorkspaceSecret(value, userId, key());
    return secret.value.kind === "browser_session" ? workspaceBrowserSessionSavedAt(Buffer.from(secret.value.base64, "base64")) : null;
  } catch { return null; }
}

async function commitFile(tx: Prisma.TransactionClient, input: WorkspaceBrowserSaveInput,
  file: Readonly<{ fileName: string; bytes: Uint8Array }>, key: () => Buffer, now: () => number): Promise<FileOutcome> {
  input.signal?.throwIfAborted();
  await lockWorkspaceSecretOwner(tx, input.userId, true);
  const run = await authorizedRun(tx, input);
  if (run === null) return "unauthorized";
  const { sequence } = run;
  const owner = await tx.user.findUniqueOrThrow({ where: { id: input.userId }, select: { workspaceBrowserManualSequence: true } });
  const existing = await tx.workspaceSecret.findFirst({ where: { userId: input.userId, browserFileName: file.fileName }, include: { value: true } });
  // What this run was given at admission: a file it collects back unchanged is no write of its own.
  const given = existing ? await tx.workspaceRunSecret.findUnique({
    where: { modelRunId_secretId: { modelRunId: input.runId, secretId: existing.id } }, include: { value: true } }) : null;
  // Freshness of the guest's writes, under the run's operation fence; a manual settings change fences every older run.
  const order = workspaceBrowserSaveOrder({ sequence, manualSequence: owner.workspaceBrowserManualSequence, now: now(),
    incoming: { checksum: workspaceBrowserSessionChecksum(file.bytes), savedAt: workspaceBrowserSessionSavedAt(file.bytes) },
    current: existing ? { checksum: existing.value.checksum, writerSequence: existing.browserWriterSequence,
      createdAt: existing.value.createdAt, savedAt: () => revisionSavedAt(existing.value, input.userId, key) } : null,
    given: given && given.valueId !== existing?.valueId ? { checksum: given.value.checksum,
      savedAt: () => revisionSavedAt(given.value, input.userId, key) } : null });
  if (order === "browser_session_stale") return order;
  const writerSequence = existing && existing.browserWriterSequence > sequence ? existing.browserWriterSequence : sequence;
  if (existing && order === "unchanged") {
    // Advance ordering even when the immutable encrypted revision is unchanged.
    if (writerSequence !== existing.browserWriterSequence) {
      await tx.workspaceSecret.update({ where: { id: existing.id }, data: { browserWriterSequence: writerSequence } });
    }
    return "unchanged";
  }
  // A turn the server wrote saves or replaces only a sign-in the user finished in it, and the saved one stays otherwise
  // (operator decision 2026-11-23); the user's own turn saves what its browser holds.
  if (serverWrittenBrowserTurn(run.turn) && !(await browserSignInSaveFiles(tx, input.runId)).has(file.fileName)) {
    return BROWSER_SESSION_SERVER_TURN;
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
  if (existing) await tx.workspaceSecret.update({ where: { id: existing.id }, data: { valueId, browserWriterSequence: writerSequence } });
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
  key: () => Buffer = getSecretEncryptionKey, now: () => number = Date.now): Promise<WorkspaceBrowserSaveReport | null> {
  // No deadline check here: an already expired deadline still records its
  // failed outcome for an authorized run instead of disappearing.
  const authorized = await prisma.$transaction(async (tx) => {
    await lockWorkspaceSecretOwner(tx, input.userId, true);
    return await authorizedRun(tx, input) !== null;
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
      const outcome = await prisma.$transaction((tx) => commitFile(tx, input, item, key, now), { maxWait: 5_000, timeout: 15_000 });
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
  const refused = report.skipped[BROWSER_SESSION_SERVER_TURN];
  if (refused) {
    logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "write", outcome: "skipped", code: BROWSER_SESSION_SERVER_TURN,
      action: "skip", count: refused });
  }
  await prisma.workspaceRunBinding.update({ where: { modelRunId: input.runId }, data: { browserSessionSave: report as Prisma.InputJsonValue } });
  return report;
}
