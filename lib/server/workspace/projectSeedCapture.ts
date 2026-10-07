import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "../uploads/storage";
import { parseWorkspaceOperation } from "./operationFence";
import { WorkspaceRuntimeError, type WorkspaceOutputStream, type WorkspaceRuntime } from "./runtime";
import { WORKSPACE_OPERATION_LEASE_MS } from "./sessionOperation";

export type WorkspaceProjectSeedCapture =
  | Readonly<{ kind: "ready" }>
  /** The seed stopped being CAPTURING (its claim was abandoned meanwhile); nothing was written. */
  | Readonly<{ kind: "abandoned" }>
  | Readonly<{ kind: "failed"; failureCode: string }>;

/**
 * Copies a session's `/workspace/project` into the private archive of a
 * continuation seed, never as an attachment or model input. The caller has
 * reserved both in one transaction: the seed is CAPTURING and the session's
 * operation owner and generation are `owner` and `generation`. The archive is
 * stored at the seed's own key and the seed settles READY with its checksum
 * and size (holding `readyLeaseExpiresAt`, if given, until a transfer), or
 * FAILED with its object queued for deletion. Whatever happens, the operation
 * is retired and the session left STOPPED once retirement is proven;
 * otherwise maintenance keeps fencing it.
 */
export async function captureWorkspaceProjectSeed(input: Readonly<{
  client: PrismaClient;
  generation: number;
  owner: string;
  readyLeaseExpiresAt?: Date;
  runtime: WorkspaceRuntime;
  runtimeSandboxId: string;
  seedId: string;
  sessionId: string;
  /** Bounds the copy; its abort settles the seed FAILED as `workspace_tool_timeout`. */
  signal: AbortSignal;
  storage: StorageAdapter;
}>): Promise<WorkspaceProjectSeedCapture> {
  const { client, runtime, signal, storage } = input;
  const operation = parseWorkspaceOperation({ generation: input.generation, owner: input.owner });
  const runtimeInput = { operation, runtimeSandboxId: input.runtimeSandboxId, sessionId: input.sessionId };
  let storageKey: string | null = null;
  let archiveOutput: WorkspaceOutputStream | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const renew = () => void client.workspaceSession.updateMany({
    where: { id: input.sessionId, version: input.generation, operationOwner: operation.owner },
    data: { operationExpiresAt: new Date(Date.now() + WORKSPACE_OPERATION_LEASE_MS) }
  }).then(() => client.chatContinuationWorkspaceSeed.updateMany({
    where: { id: input.seedId, status: "CAPTURING" },
    data: { leaseExpiresAt: new Date(Date.now() + WORKSPACE_OPERATION_LEASE_MS) }
  })).catch(() => undefined);
  try {
    await runtime.claimSessionOperation?.(runtimeInput);
    timer = setInterval(renew, Math.floor(WORKSPACE_OPERATION_LEASE_MS / 3));
    timer.unref?.();
    archiveOutput = await runtime.createProjectArchive({ ...runtimeInput, restorable: true, signal });
    const output = archiveOutput;
    storageKey = `workspace-continuation/${input.seedId}.tar.gz`;
    const reserved = await client.chatContinuationWorkspaceSeed.updateMany({
      where: { id: input.seedId, status: "CAPTURING" }, data: { storageKey }
    });
    if (reserved.count !== 1) {
      await output.body.cancel("continuation_abandoned").catch(() => undefined);
      if (output.batchId) await runtime.releaseOutputs?.({ ...runtimeInput, batchId: output.batchId }).catch(() => undefined);
      return { kind: "abandoned" };
    }
    if (storage.putObjectStream) {
      await storage.putObjectStream({ body: output.body, byteSize: output.byteSize, checksum: output.checksum,
        contentType: "application/gzip", signal, storageKey });
    } else {
      const reader = output.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try { while (true) { signal.throwIfAborted(); const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength; if (bytes > output.byteSize) throw new Error("archive_size"); chunks.push(next.value); } }
      finally { reader.releaseLock(); }
      if (bytes !== output.byteSize) throw new Error("archive_size");
      const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
      if (createHash("sha256").update(body).digest("hex") !== output.checksum) throw new Error("archive_checksum");
      await storage.putObject({ body, contentType: "application/gzip", storageKey });
    }
    const ready = await client.$transaction(async (tx) => {
      const seedReady = (await tx.chatContinuationWorkspaceSeed.updateMany({ where: { id: input.seedId, status: "CAPTURING" }, data: {
        status: "READY", storageKey, checksum: output.checksum, byteSize: output.byteSize, leaseToken: null,
        leaseExpiresAt: input.readyLeaseExpiresAt ?? null
      } })).count === 1;
      if (!seedReady && storageKey) await tx.attachmentDeletionJob.upsert({ where: { storageKey }, create: { storageKey }, update: {} });
      return seedReady;
    });
    return ready ? { kind: "ready" } : { kind: "abandoned" };
  } catch (error) {
    const failureCode = signal.aborted ? "workspace_tool_timeout" : error instanceof WorkspaceRuntimeError ? error.code : "workspace_archive_export_failed";
    if (archiveOutput?.batchId) await runtime.releaseOutputs?.({ ...runtimeInput, batchId: archiveOutput.batchId }).catch(() => undefined);
    await client.$transaction(async (tx) => {
      await tx.chatContinuationWorkspaceSeed.updateMany({ where: { id: input.seedId, status: "CAPTURING" }, data: {
        status: "FAILED", failureCode, storageKey, leaseToken: null, leaseExpiresAt: null
      } });
      if (storageKey) await tx.attachmentDeletionJob.upsert({ where: { storageKey }, create: { storageKey }, update: {} });
    });
    return { failureCode, kind: "failed" };
  } finally {
    if (timer) clearInterval(timer);
    try {
      if (runtime.retireSessionOperation) await runtime.retireSessionOperation(runtimeInput);
      else await runtime.stopSession(runtimeInput);
      await client.workspaceSession.updateMany({ where: { id: input.sessionId, version: input.generation, operationOwner: operation.owner },
        data: { operationOwner: null, operationExpiresAt: null, state: "STOPPED", stoppedAt: new Date() } });
    } catch {
      // Keep the database reservation until maintenance proves retirement.
    }
  }
}
