import { resolveRequestAuth } from "@/lib/server/auth/defaultAuth";
import { resolveProjectAccess } from "@/lib/server/projects/access";
import { prisma } from "@/lib/server/prisma";
import { kickDefaultAttachmentProcessing } from "@/lib/server/uploads/defaultProcessing";
import { serializeAttachmentLifecycle, type AttachmentLifecycleRecord } from "@/lib/server/uploads/lifecycleHandlers";
import { Prisma } from "@prisma/client";

export const runtime = "nodejs";

const attachmentSelect = {
  byteSize: true,
  extractedText: true,
  fileName: true,
  id: true,
  kind: true,
  metadata: true,
  mimeType: true,
  processingErrorCode: true,
  status: true,
  updatedAt: true
} as const;

async function projectParams(
  context: { params: Promise<{ attachmentId: string; projectId: string }> | { attachmentId: string; projectId: string } }
) {
  return await context.params;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ attachmentId: string; projectId: string }> }
): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
  const params = await projectParams(context);
  const access = await resolveProjectAccess(prisma, {
    projectId: params.projectId,
    userId: auth.userId
  });
  if (!access) return Response.json({ error: "attachment_not_found" }, { status: 404 });
  const attachment = await prisma.attachment.findFirst({
    select: attachmentSelect,
    where: { id: params.attachmentId, projectId: params.projectId }
  });
  if (!attachment) return Response.json({ error: "attachment_not_found" }, { status: 404 });
  return Response.json(
    { attachment: serializeAttachmentLifecycle(attachment as AttachmentLifecycleRecord) },
    { headers: { "cache-control": "private, no-store" } }
  );
}

export async function POST(
  request: Request,
  context: { params: Promise<{ attachmentId: string; projectId: string }> }
): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
  const params = await projectParams(context);
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "Project" WHERE "id" = ${params.projectId} FOR UPDATE
    `);
    const access = await resolveProjectAccess(tx, {
      minimumRole: "CONTRIBUTOR",
      projectId: params.projectId,
      requireActive: true,
      userId: auth.userId
    });
    if (!access) return { kind: "not_found" as const };
    const existing = await tx.attachment.findFirst({
      select: { id: true, status: true },
      where: { id: params.attachmentId, projectId: params.projectId }
    });
    if (!existing) return { kind: "not_found" as const };
    const updated = await tx.attachment.updateMany({
      data: {
        extractedText: null,
        metadata: {},
        processingErrorCode: null,
        status: "processing",
        updatedAt: new Date()
      },
      where: {
        chatId: null,
        id: params.attachmentId,
        messageId: null,
        projectId: params.projectId,
        status: "failed"
      }
    });
    if (updated.count !== 1) return { kind: "not_retryable" as const };
    await tx.attachmentProcessingJob.upsert({
      create: { attachmentId: params.attachmentId, nextAttemptAt: new Date(), ownerUserId: auth.userId },
      update: {
        attemptCount: 0,
        claimedAt: null,
        claimToken: null,
        lastAttemptAt: null,
        lastErrorCode: null,
        nextAttemptAt: new Date(),
        ownerUserId: auth.userId,
        updatedAt: new Date()
      },
      where: { attachmentId: params.attachmentId }
    });
    const attachment = await tx.attachment.findUnique({
      select: attachmentSelect,
      where: { id: params.attachmentId }
    });
    return attachment
      ? { attachment, kind: "ok" as const }
      : { kind: "not_found" as const };
  });
  if (result.kind === "not_found") {
    return Response.json({ error: "attachment_not_found" }, { status: 404 });
  }
  if (result.kind === "not_retryable") {
    return Response.json({ error: "attachment_retry_not_available" }, { status: 409 });
  }
  kickDefaultAttachmentProcessing();
  return Response.json({
    attachment: serializeAttachmentLifecycle(result.attachment as AttachmentLifecycleRecord)
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ attachmentId: string; projectId: string }> }
): Promise<Response> {
  const auth = await resolveRequestAuth(request);
  if (!auth) return Response.json({ error: "unauthorized" }, { status: 401 });
  const params = await context.params;
  if (!params.projectId || !params.attachmentId) {
    return Response.json({ error: "attachment_not_found" }, { status: 404 });
  }

  const deleted = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw(Prisma.sql`
      SELECT "id" FROM "Project" WHERE "id" = ${params.projectId} FOR UPDATE
    `);
    const access = await resolveProjectAccess(tx, {
      minimumRole: "MANAGER",
      projectId: params.projectId,
      requireActive: true,
      userId: auth.userId
    });
    if (!access) return null;
    const attachment = await tx.attachment.findFirst({
      select: { id: true, storageKey: true },
      where: { id: params.attachmentId, projectId: params.projectId }
    });
    if (!attachment) return null;
    await tx.attachment.delete({ where: { id: attachment.id } });
    const remaining = await tx.attachment.count({ where: { storageKey: attachment.storageKey } });
    if (remaining === 0) {
      await tx.attachmentDeletionJob.upsert({
        create: { storageKey: attachment.storageKey },
        update: {},
        where: { storageKey: attachment.storageKey }
      });
    }
    await tx.projectAuditEvent.create({
      data: {
        actorDisplayName: auth.user.displayName,
        actorUserId: auth.userId,
        eventType: "project_attachment_deleted",
        metadata: { attachmentId: attachment.id },
        projectId: params.projectId
      }
    });
    return attachment.id;
  });
  if (!deleted) return Response.json({ error: "attachment_not_found" }, { status: 404 });
  return Response.json({ attachment: { deleted: true, id: deleted } });
}
