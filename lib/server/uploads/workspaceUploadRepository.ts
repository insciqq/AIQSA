import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { WorkspaceUploadWire } from "@/lib/contracts/workspaceUploads";
import { resolveProjectAccess } from "../projects/access";
import { WORKSPACE_UPLOAD_IDLE_MS, WORKSPACE_UPLOAD_LEASE_MS, WORKSPACE_UPLOAD_LIFETIME_MS, WORKSPACE_UPLOAD_PART_BYTES } from "./workspaceUploadConfig";

const include = { objects: true, attachment: true } satisfies Prisma.AttachmentUploadInclude;
export type WorkspaceUploadRecord = Prisma.AttachmentUploadGetPayload<{ include: typeof include }>;

const errorBrand = Symbol.for("aiqsa.workspace-upload-error");
export class WorkspaceUploadError extends Error {
  readonly [errorBrand] = true;
  constructor(readonly code: string, readonly status = 409) { super(code); }
}

// Next builds instrumentation and routes into separate bundles. The process
// singleton can throw an error from either copy of this module.
export function isWorkspaceUploadError(error: unknown): error is WorkspaceUploadError {
  return error instanceof Error && errorBrand in error && error[errorBrand] === true;
}

async function lock(tx: Prisma.TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "AttachmentUpload" WHERE "id" = ${id} FOR UPDATE`;
  return tx.attachmentUpload.findUnique({ where: { id }, include });
}

async function authorized(tx: Prisma.TransactionClient, row: WorkspaceUploadRecord, userId: string, projectLock = false) {
  if (row.userId !== userId) return false;
  if (!await tx.user.findFirst({ where: { id: userId, status: "active" }, select: { id: true } })) return false;
  if (!row.projectScoped) return row.projectId === null;
  if (!row.projectId) return false;
  if (projectLock) await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${row.projectId} FOR UPDATE`;
  return !!await resolveProjectAccess(tx, { projectId: row.projectId, userId, requireActive: true, minimumRole: "CONTRIBUTOR" });
}

function writable(row: WorkspaceUploadRecord, now: Date) {
  if (row.expiresAt <= now || row.deadlineAt <= now) throw new WorkspaceUploadError("upload_expired", 410);
  if (row.state !== "uploading") throw new WorkspaceUploadError("upload_not_writable");
}

function expiry(row: Pick<WorkspaceUploadRecord, "deadlineAt">, now: Date) {
  return new Date(Math.min(row.deadlineAt.getTime(), now.getTime() + WORKSPACE_UPLOAD_IDLE_MS));
}

export function workspaceUploadProjection(row: WorkspaceUploadRecord): WorkspaceUploadWire {
  const file = row.attachment;
  return {
    id: row.id, byteSize: row.byteSize, partBytes: WORKSPACE_UPLOAD_PART_BYTES,
    completedParts: row.objects.filter(object => object.partNumber !== null && object.ready).map(object => object.partNumber!),
    state: row.state as WorkspaceUploadWire["state"], expiresAt: row.expiresAt.toISOString(), errorCode: row.errorCode,
    attachment: row.state === "completed" && file ? {
      id: file.id, fileName: file.fileName, mimeType: file.mimeType, byteSize: file.byteSize,
      kind: "file", status: "ready", extractedText: null, updatedAt: file.updatedAt.toISOString()
    } : null
  };
}

export function createWorkspaceUploadRepository(db: PrismaClient) {
  return {
    async create(input: { userId: string; projectId: string | null; idempotencyKey: string; fileName: string; mimeType: string; byteSize: number }, now = new Date()) {
      return db.$transaction(async tx => {
        // Serializes the bounded per-owner admission across sessions/processes.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attachment-upload:${input.userId}`}, 0))::text`;
        const prior = await tx.attachmentUpload.findUnique({ where: {
          userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey }
        }, include });
        if (prior) {
          if (!await authorized(tx, prior, input.userId)) throw new WorkspaceUploadError("upload_not_found", 404);
          if (prior.projectId !== input.projectId || prior.fileName !== input.fileName || prior.mimeType !== input.mimeType || prior.byteSize !== input.byteSize) {
            throw new WorkspaceUploadError("upload_conflict");
          }
          return prior;
        }
        if (!await tx.user.findFirst({ where: { id: input.userId, status: "active" }, select: { id: true } })) {
          throw new WorkspaceUploadError("upload_not_found", 404);
        }
        if (input.projectId) {
          await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${input.projectId} FOR UPDATE`;
          if (!await resolveProjectAccess(tx, { projectId: input.projectId, userId: input.userId, requireActive: true, minimumRole: "CONTRIBUTOR" })) {
            throw new WorkspaceUploadError("upload_not_found", 404);
          }
        }
        const count = await tx.attachmentUpload.count({ where: {
          userId: input.userId, state: { in: ["uploading", "verifying"] }, deadlineAt: { gt: now },
          OR: [{ state: "verifying" }, { expiresAt: { gt: now } }, { leaseExpiresAt: { gt: now } }]
        } });
        if (count >= 2) throw new WorkspaceUploadError("upload_busy", 429);
        return tx.attachmentUpload.create({ data: {
          ...input, projectScoped: input.projectId !== null,
          expiresAt: new Date(now.getTime() + WORKSPACE_UPLOAD_IDLE_MS),
          deadlineAt: new Date(now.getTime() + WORKSPACE_UPLOAD_LIFETIME_MS)
        }, include });
      });
    },
    async get(id: string, userId: string) {
      return db.$transaction(async tx => {
        const row = await tx.attachmentUpload.findUnique({ where: { id }, include });
        if (!row || !await authorized(tx, row, userId)) throw new WorkspaceUploadError("upload_not_found", 404);
        if (row.state === "completed" && !row.attachment) throw new WorkspaceUploadError("upload_not_found", 404);
        return row;
      });
    },
    async claimPart(input: { id: string; userId: string; partNumber: number; checksum: string }, now = new Date()) {
      return db.$transaction(async tx => {
        const row = await lock(tx, input.id);
        if (!row || !await authorized(tx, row, input.userId)) throw new WorkspaceUploadError("upload_not_found", 404);
        writable(row, now);
        const count = Math.ceil(row.byteSize / WORKSPACE_UPLOAD_PART_BYTES);
        if (input.partNumber < 1 || input.partNumber > count) throw new WorkspaceUploadError("upload_invalid_part", 400);
        const part = row.objects.find(object => object.partNumber === input.partNumber);
        if (part && part.checksum !== input.checksum) throw new WorkspaceUploadError("upload_part_conflict");
        if (part?.ready) return { row, part, duplicate: true };
        if (part?.leaseExpiresAt && part.leaseExpiresAt > now) throw new WorkspaceUploadError("upload_busy", 429);
        // Same owner can upload across two sessions; use a shared durable gate.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`attachment-upload-parts:${input.userId}`}, 0))::text`;
        if (await tx.attachmentUploadObject.count({ where: {
          upload: { userId: input.userId }, partNumber: { not: null }, leaseExpiresAt: { gt: now }
        } }) >= 2) throw new WorkspaceUploadError("upload_busy", 429);
        const byteSize = Math.min(WORKSPACE_UPLOAD_PART_BYTES, row.byteSize - (input.partNumber - 1) * WORKSPACE_UPLOAD_PART_BYTES);
        const data = { claimToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + WORKSPACE_UPLOAD_LEASE_MS) };
        const claimed = part
          ? await tx.attachmentUploadObject.update({ where: { id: part.id }, data })
          : await tx.attachmentUploadObject.create({ data: { ...data, uploadId: row.id, partNumber: input.partNumber,
            checksum: input.checksum, byteSize, storageKey: `uploads/stream/${row.id}/parts/${input.partNumber}` } });
        await tx.attachmentUpload.update({ where: { id: row.id }, data: { expiresAt: expiry(row, now) } });
        return { row, part: claimed, duplicate: false };
      });
    },
    async finishPart(input: { id: string; userId: string; objectId: string; claimToken: string; ready: boolean }, now = new Date()) {
      return db.$transaction(async tx => {
        const row = await lock(tx, input.id);
        const allowed = row && row.state === "uploading" && row.expiresAt > now && row.deadlineAt > now && await authorized(tx, row, input.userId);
        const changed = await tx.attachmentUploadObject.updateMany({ where: {
          id: input.objectId, uploadId: input.id, claimToken: input.claimToken
        }, data: { ready: !!allowed && input.ready, claimToken: null, leaseExpiresAt: null } });
        if (allowed && input.ready && changed.count) {
          await tx.attachmentUpload.update({ where: { id: row.id }, data: { expiresAt: expiry(row, now) } });
        }
        return !!allowed && !!changed.count;
      });
    },
    async complete(id: string, userId: string, now = new Date()) {
      return db.$transaction(async tx => {
        const row = await lock(tx, id);
        if (!row || !await authorized(tx, row, userId)) throw new WorkspaceUploadError("upload_not_found", 404);
        if (row.state === "completed" || row.state === "verifying") return row;
        writable(row, now);
        const parts = row.objects.filter(object => object.partNumber !== null);
        if (parts.length !== Math.ceil(row.byteSize / WORKSPACE_UPLOAD_PART_BYTES) || parts.some(part => !part.ready || part.claimToken)) {
          throw new WorkspaceUploadError("upload_incomplete");
        }
        return tx.attachmentUpload.update({ where: { id }, data: { state: "verifying", nextAttemptAt: now,
          expiresAt: expiry(row, now), errorCode: null }, include });
      });
    },
    async cancel(id: string, userId: string) {
      return db.$transaction(async tx => {
        const row = await lock(tx, id);
        if (!row || !await authorized(tx, row, userId)) throw new WorkspaceUploadError("upload_not_found", 404);
        if (row.state === "completed") return row;
        return tx.attachmentUpload.update({ where: { id }, data: { state: "cancelled" }, include });
      });
    },
    async claimSettlement(now = new Date()) {
      return db.$transaction(async tx => {
        const candidates = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "AttachmentUpload" WHERE "state" = 'verifying' AND "nextAttemptAt" <= ${now}
          AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt" <= ${now})
          ORDER BY "createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const id = candidates[0]?.id;
        if (!id) return null;
        const row = await tx.attachmentUpload.findUniqueOrThrow({ where: { id }, include });
        if (row.deadlineAt <= now || !row.userId || !await authorized(tx, row, row.userId)) {
          await tx.attachmentUpload.update({ where: { id }, data: { state: "expired", claimToken: null, leaseExpiresAt: null } });
          return null;
        }
        const claimToken = randomUUID();
        const claimed = await tx.attachmentUpload.update({ where: { id }, data: {
          claimToken, leaseExpiresAt: new Date(now.getTime() + WORKSPACE_UPLOAD_LEASE_MS), attemptCount: { increment: 1 }
        }, include });
        const output = await tx.attachmentUploadObject.create({ data: { uploadId: id, byteSize: row.byteSize,
          storageKey: `uploads/stream/${id}/originals/${claimToken}` } });
        return { row: claimed, output };
      });
    },
    async heartbeat(id: string, claimToken: string, now = new Date()) {
      const result = await db.attachmentUpload.updateMany({ where: {
        id, claimToken, state: "verifying", deadlineAt: { gt: now }, leaseExpiresAt: { gt: now }
      }, data: { leaseExpiresAt: new Date(now.getTime() + WORKSPACE_UPLOAD_LEASE_MS) } });
      return result.count === 1;
    },
    async settle(input: { id: string; claimToken: string; storageKey: string; checksum: string }, now = new Date()) {
      return db.$transaction(async tx => {
        const row = await lock(tx, input.id);
        if (!row || row.state !== "verifying" || row.claimToken !== input.claimToken || !row.leaseExpiresAt || row.leaseExpiresAt <= now || row.deadlineAt <= now) return false;
        if (!row.userId || !await authorized(tx, row, row.userId, true)) {
          await tx.attachmentUpload.update({ where: { id: row.id }, data: { state: "failed", errorCode: "upload_unavailable",
            claimToken: null, leaseExpiresAt: null } });
          return false;
        }
        const output = row.objects.find(object => object.storageKey === input.storageKey && object.partNumber === null);
        if (!output) throw new WorkspaceUploadError("upload_conflict");
        const user = await tx.user.findUniqueOrThrow({ where: { id: row.userId }, select: { displayName: true } });
        const attachment = await tx.attachment.create({ data: {
          ...(row.projectId ? { projectId: row.projectId, uploaderUserId: row.userId, uploaderDisplayName: user.displayName } : { userId: row.userId }),
          byteSize: row.byteSize, checksum: input.checksum, fileName: row.fileName, kind: "file",
          mimeType: row.mimeType, storageKey: input.storageKey, status: "ready", extractedText: null,
          metadata: { workspaceOriginalOnly: true }
        } });
        await tx.attachmentUpload.update({ where: { id: row.id }, data: {
          attachmentId: attachment.id, state: "completed", claimToken: null, leaseExpiresAt: null, errorCode: null
        } });
        return true;
      });
    },
    async failSettlement(id: string, claimToken: string, errorCode: string, retryable: boolean, now = new Date()) {
      return db.$transaction(async tx => {
        const row = await lock(tx, id);
        if (!row || row.claimToken !== claimToken) return;
        const retry = row.state === "verifying" && retryable && row.attemptCount < 3 && row.deadlineAt > now;
        await tx.attachmentUpload.update({ where: { id }, data: {
          state: row.state === "verifying" ? retry ? "verifying" : "failed" : row.state,
          claimToken: null, leaseExpiresAt: null, errorCode, nextAttemptAt: new Date(now.getTime() + 5_000)
        } });
      });
    },
    async claimCleanup(now = new Date()) {
      return db.$transaction(async tx => {
        await tx.attachmentUpload.updateMany({ where: { state: "uploading", expiresAt: { lte: now } }, data: { state: "expired" } });
        await tx.attachmentUpload.updateMany({ where: { state: { in: ["uploading", "verifying"] },
          OR: [{ userId: null }, { projectScoped: true, projectId: null }] }, data: { state: "expired" } });
        const candidates = await tx.$queryRaw<{ id: string }[]>`
          SELECT u."id" FROM "AttachmentUpload" u WHERE u."state" IN ('completed','cancelled','expired','failed')
          AND u."cleanedAt" IS NULL AND (u."leaseExpiresAt" IS NULL OR u."leaseExpiresAt" <= ${now})
          AND NOT EXISTS (SELECT 1 FROM "AttachmentUploadObject" o WHERE o."uploadId" = u."id" AND o."leaseExpiresAt" > ${now})
          ORDER BY u."createdAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const id = candidates[0]?.id;
        if (!id) {
          await tx.attachmentUpload.deleteMany({ where: { cleanedAt: { not: null }, deadlineAt: { lt: now } } });
          return null;
        }
        const row = await tx.attachmentUpload.update({ where: { id }, data: {
          claimToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + WORKSPACE_UPLOAD_LEASE_MS)
        }, include });
        return { row, objects: row.objects.filter(object => object.storageKey !== row.attachment?.storageKey) };
      });
    },
    async finishCleanup(id: string, claimToken: string) {
      return db.$transaction(async tx => {
        const row = await lock(tx, id);
        if (!row || row.claimToken !== claimToken || ["uploading", "verifying"].includes(row.state)) return;
        await tx.attachmentUploadObject.deleteMany({ where: { uploadId: id } });
        await tx.attachmentUpload.update({ where: { id }, data: { cleanedAt: new Date(), claimToken: null, leaseExpiresAt: null } });
      });
    }
  };
}

export type WorkspaceUploadRepository = ReturnType<typeof createWorkspaceUploadRepository>;
