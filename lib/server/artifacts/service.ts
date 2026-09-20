import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ARTIFACT_LIMITS,
  artifactManifest,
  normalizeArtifactOperation,
  type ArtifactOperation,
  type ArtifactManifest,
  type NormalizedArtifactOperation
} from "@/lib/contracts/artifacts";
import { createShareToken, hashShareToken } from "@/lib/server/shares/tokens";
import type { StorageAdapter } from "@/lib/server/uploads/storage";
import { buildArtifactBundle, decodeArtifactBundle, renderArtifactBundle, type ArtifactBundle } from "./bundle";
import { ARTIFACT_WRITE_LEASE_MS } from "./lifecycle";
import { artifactZip } from "./zip";
import { ARTIFACT_TOOL_NAME } from "../tools/artifact";
import type { ModelToolCall, ToolExecutionContext, ToolExecutionResult } from "../tools/types";

function json(value: unknown): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
const checksum = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export type ArtifactService = ReturnType<typeof createArtifactService>;

function publicVersion(row: {
  artifactId: string; checksum: string; entrypoint: string | null; id: string; kind: string; manifest: unknown; status: string;
  title: string; versionNumber: number; byteSize: number; createdAt: Date; readyAt: Date | null;
}) {
  return { artifactId: row.artifactId, checksum: row.checksum, entrypoint: row.entrypoint, id: row.id, kind: row.kind, manifest: publicManifestFromPrivate(row.manifest),
    status: row.status, title: row.title, versionNumber: row.versionNumber, byteSize: row.byteSize,
    createdAt: row.createdAt.toISOString(), ...(row.readyAt ? { readyAt: row.readyAt.toISOString() } : {}) };
}

function privateManifest(operation: NormalizedArtifactOperation): Prisma.InputJsonValue {
  return json({
    ...artifactManifest(operation),
    files: operation.files.map((file) => ({
      byteSize: file.byteSize,
      mimeType: file.mimeType,
      path: file.path,
      ...(file.assetRef ? { assetRef: file.assetRef } : {})
    }))
  });
}

function publicManifestFromPrivate(value: unknown): ArtifactManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("artifact_manifest_invalid");
  const candidate = value as { entrypoint?: unknown; files?: unknown; kind?: unknown; title?: unknown; version?: unknown };
  if (!Array.isArray(candidate.files) || typeof candidate.entrypoint !== "string" && candidate.entrypoint !== null ||
    typeof candidate.kind !== "string" || typeof candidate.title !== "string" || candidate.version !== 1) {
    throw new Error("artifact_manifest_invalid");
  }
  return {
    entrypoint: candidate.entrypoint,
    files: candidate.files.map((file) => {
      if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("artifact_manifest_invalid");
      const item = file as Record<string, unknown>;
      if (typeof item.path !== "string" || typeof item.mimeType !== "string" || !Number.isSafeInteger(item.byteSize)) throw new Error("artifact_manifest_invalid");
      return { byteSize: item.byteSize as number, mimeType: item.mimeType, path: item.path };
    }),
    kind: candidate.kind as ArtifactManifest["kind"],
    title: candidate.title,
    version: 1
  };
}

export function createArtifactService(db: PrismaClient, storage: StorageAdapter) {
  async function guardRun(tx: Prisma.TransactionClient, input: { sourceModelRunId?: string; ownerUserId: string }) {
    if (!input.sourceModelRunId) return;
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "ModelRun"
      WHERE "id" = ${input.sourceModelRunId} AND "userId" = ${input.ownerUserId}
        AND "status" IN ('streaming', 'in_progress') FOR UPDATE`;
    if (!rows.length) throw new Error("artifact_run_inactive");
  }
  async function expireWrites(tx: Prisma.TransactionClient, artifactId: string) {
    await tx.artifactVersion.updateMany({ where: { artifactId, status: "PENDING", createdAt: { lte: new Date(Date.now() - ARTIFACT_WRITE_LEASE_MS) } },
      data: { status: "FAILED", failureCode: "artifact_write_expired" } });
  }

  async function resolveAssets(
    userId: string,
    operation: NormalizedArtifactOperation,
    source: { chatId?: string; modelRunId?: string; allowedAssetRefs?: readonly string[]; baseVersionId?: string } = {}
  ) {
    const refs = operation.files.filter((file) => file.assetRef).map((file) => file.assetRef!);
    if (!refs.length) return [];
    // Binary assets in a ready version are independent of the attachment and
    // source chat. An edit may reuse only assets actually present in its base.
    const reusable = new Map<string, { bytes: Buffer; mimeType: string }>();
    if (source.baseVersionId) {
      const base = await db.artifactVersion.findFirst({ where: { id: source.baseVersionId, status: "READY",
        artifact: { ownerUserId: userId, archivedAt: null } } });
      if (!base) throw new Error("artifact_version_not_found");
      const object = await storage.getObject(base.bundleStorageKey, { maxBytes: base.byteSize });
      if (object.body.byteLength !== base.byteSize || checksum(object.body) !== base.checksum) throw new Error("artifact_bundle_unavailable");
      const bundle = decodeArtifactBundle(object.body);
      const metadata = (base.manifest as { files: Array<{ path: string; assetRef?: string }> }).files;
      for (const file of bundle.files) {
        const ref = metadata.find((item) => item.path === file.path)?.assetRef;
        if (ref && file.base64 !== undefined) reusable.set(ref, { bytes: Buffer.from(file.base64, "base64"), mimeType: file.mimeType });
      }
    }
    const rows = await db.attachment.findMany({
      where: {
        id: { in: refs.filter((ref) => !reusable.has(ref)) },
        userId,
        projectId: null,
        status: "ready",
        ...(source.allowedAssetRefs !== undefined ? {
          OR: [
            { id: { in: [...source.allowedAssetRefs] } },
            ...(source.modelRunId ? [{ producerModelRunId: source.modelRunId }] : [])
          ]
        } : source.chatId || source.modelRunId
          ? {
              OR: [
                ...(source.chatId ? [{ chatId: source.chatId }] : []),
                ...(source.modelRunId ? [{ producerModelRunId: source.modelRunId }] : [])
              ]
            }
          : {})
      },
      select: { id: true, mimeType: true, storageKey: true, byteSize: true, checksum: true }
    });
    // Bound the complete read set before fetching attachment bodies. The final
    // encoded-bundle check also accounts for JSON/base64 overhead.
    let totalBytes = operation.totalBytes;
    for (const file of operation.files.filter((file) => file.assetRef)) {
      const byteSize = reusable.get(file.assetRef!)?.bytes.byteLength ?? rows.find((row) => row.id === file.assetRef)?.byteSize;
      if (byteSize === undefined) throw new Error("artifact_asset_unavailable");
      if (byteSize <= 0 || byteSize > ARTIFACT_LIMITS.maxAssetBytes) throw new Error("artifact_asset_too_large");
      totalBytes += byteSize;
      if (totalBytes > ARTIFACT_LIMITS.maxBundleBytes) throw new Error("artifact_bundle_limit_exceeded");
    }
    return Promise.all(operation.files.filter((file) => file.assetRef).map(async (file) => {
      const copied = reusable.get(file.assetRef!);
      if (copied) {
        if (copied.mimeType !== file.mimeType) throw new Error("artifact_asset_mime_mismatch");
        return { ...copied, path: file.path };
      }
      const row = rows.find((candidate) => candidate.id === file.assetRef);
      if (!row) throw new Error("artifact_asset_unavailable");
      if (row.byteSize <= 0 || row.byteSize > ARTIFACT_LIMITS.maxAssetBytes) throw new Error("artifact_asset_too_large");
      if (row.mimeType.toLowerCase() !== file.mimeType) throw new Error("artifact_asset_mime_mismatch");
      const stored = await storage.getObject(row.storageKey, { maxBytes: row.byteSize });
      if (stored.body.byteLength !== row.byteSize || row.checksum && (await import("node:crypto")).createHash("sha256").update(stored.body).digest("hex") !== row.checksum) {
        throw new Error("artifact_asset_invalid");
      }
      return { bytes: stored.body, mimeType: row.mimeType, path: file.path };
    }));
  }

  async function createVersion(input: {
    artifactId?: string;
    operation: ArtifactOperation;
    ownerUserId: string;
    sourceChatId?: string;
    sourceModelRunId?: string;
    sourceToolCallId?: string;
    allowedAssetRefs?: readonly string[];
  }) {
    if (input.sourceToolCallId) {
      const existing = await db.artifactVersion.findUnique({ where: { sourceToolCallId: input.sourceToolCallId } });
      if (existing?.status === "READY") {
        return getArtifactVersion({ ownerUserId: input.ownerUserId, artifactId: existing.artifactId, versionId: existing.id });
      }
      if (existing) throw new Error("artifact_version_in_progress");
    }
    const operation = normalizeArtifactOperation(input.operation);
    if (input.sourceChatId && !await db.chat.findFirst({ where: {
      id: input.sourceChatId, userId: input.ownerUserId, projectId: null, memoryMode: { not: "TEMPORARY" }
    }, select: { id: true } })) throw new Error("artifact_not_found");
    let artifactId = input.artifactId;
    if (artifactId && operation.intent !== "update") throw new Error("artifact_operation_invalid");
    if (!artifactId && operation.intent === "update") {
      const base = await db.artifactVersion.findFirst({
        where: { id: operation.baseVersionId, status: "READY", artifact: { ownerUserId: input.ownerUserId, archivedAt: null } },
        select: { artifactId: true }
      });
      if (!base) throw new Error("artifact_version_not_found");
      artifactId = base.artifactId;
    }
    const assets = await resolveAssets(input.ownerUserId, operation, {
      chatId: input.sourceChatId,
      modelRunId: input.sourceModelRunId,
      allowedAssetRefs: input.allowedAssetRefs,
      baseVersionId: operation.intent === "update" ? operation.baseVersionId : undefined
    });
    const built = buildArtifactBundle(operation, assets);
    const assetBytes = new Map(assets.map((asset) => [asset.path, asset.bytes.byteLength]));
    const manifestOperation = {
      ...operation,
      files: operation.files.map((file) => file.assetRef
        ? { ...file, byteSize: assetBytes.get(file.path) ?? 0 }
        : file)
    };
    const version = await db.$transaction(async (tx) => {
      await guardRun(tx, input);
      let nextNumber = 1;
      if (artifactId) {
        // Serialize edits against the current pointer, including an explicitly
        // restored historical version. Numbers still increase monotonically.
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Artifact" WHERE "id" = ${artifactId} FOR UPDATE`);
        const current = await tx.artifact.findFirst({
          where: { id: artifactId, ownerUserId: input.ownerUserId, archivedAt: null },
          select: { currentVersionId: true }
        });
        if (!current) throw new Error("artifact_not_found");
        await expireWrites(tx, artifactId);
        const pending = await tx.artifactVersion.findFirst({ where: { artifactId, status: "PENDING" }, select: { id: true } });
        if (pending) throw new Error("artifact_version_conflict");
        if (operation.baseVersionId !== current.currentVersionId) throw new Error("artifact_version_conflict");
        nextNumber = (await tx.artifactVersion.aggregate({ _max: { versionNumber: true }, where: { artifactId } }))._max.versionNumber ?? 0;
        nextNumber += 1;
      } else {
        const artifact = await tx.artifact.create({ data: { kind: operation.kind, ownerUserId: input.ownerUserId,
          ...(input.sourceChatId ? { sourceChatId: input.sourceChatId } : {}), title: operation.title } });
        artifactId = artifact.id;
      }
      const bundleStorageKey = `artifacts/${input.ownerUserId}/${artifactId}/${randomUUID()}.bundle.json`;
      const row = await tx.artifactVersion.create({ data: { artifactId, bundleStorageKey, byteSize: built.bytes.byteLength,
        checksum: built.checksum, entrypoint: operation.entrypoint, kind: operation.kind,
        manifest: privateManifest(manifestOperation), sourceModelRunId: input.sourceModelRunId,
        sourceToolCallId: input.sourceToolCallId, status: "PENDING",
        title: operation.title, versionNumber: nextNumber } });
      // Keep cleanup evidence even while canonical rows protect the bytes.
      // A later owner cascade or interrupted write must not orphan the object.
      await tx.attachmentDeletionJob.create({ data: { storageKey: bundleStorageKey } });
      return row;
    });
    try {
      await storage.putObject({ body: built.bytes, contentType: "application/vnd.aiqsa.artifact+json", storageKey: version.bundleStorageKey });
      const stored = await storage.getObject(version.bundleStorageKey, { maxBytes: built.bytes.byteLength });
      if (stored.body.byteLength !== built.bytes.byteLength || checksum(stored.body) !== built.checksum) throw new Error("artifact_bundle_write_failed");
      await db.$transaction(async (tx) => {
        await guardRun(tx, input);
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Artifact" WHERE "id" = ${version.artifactId} FOR UPDATE`);
        const settled = await tx.artifactVersion.updateMany({ where: { id: version.id, status: "PENDING", checksum: built.checksum, createdAt: { gt: new Date(Date.now() - ARTIFACT_WRITE_LEASE_MS) },
          artifact: { ownerUserId: input.ownerUserId, archivedAt: null } }, data: { readyAt: new Date(), status: "READY" } });
        if (settled.count !== 1) throw new Error("artifact_version_settlement_conflict");
        await tx.artifact.update({ where: { id: version.artifactId }, data: { currentVersionId: version.id, kind: operation.kind, title: operation.title } });
        if (input.sourceChatId) {
          const sourceChat = await tx.chat.findFirst({ where: {
            id: input.sourceChatId, userId: input.ownerUserId, projectId: null
          }, select: { id: true } });
          if (sourceChat) {
            await tx.artifactChatBinding.upsert({
              where: { artifactId_chatId: { artifactId: version.artifactId, chatId: sourceChat.id } },
              create: { artifactId: version.artifactId, chatId: sourceChat.id, versionId: version.id },
              update: { versionId: version.id }
            });
          }
        }
      });
    } catch (error) {
      await db.artifactVersion.updateMany({ where: { id: version.id, status: "PENDING" }, data: { failureCode: "artifact_bundle_write_failed", status: "FAILED" } }).catch(() => undefined);
      await db.attachmentDeletionJob.upsert({ where: { storageKey: version.bundleStorageKey }, create: { storageKey: version.bundleStorageKey }, update: {} });
      // The commit may have succeeded even if its acknowledgement was lost.
      // Canonical-reference checks in retention decide whether bytes can go.
      throw error;
    }
    return getArtifactVersion({ ownerUserId: input.ownerUserId, artifactId: version.artifactId, versionId: version.id });
  }

  async function getArtifactVersion(input: { ownerUserId: string; artifactId: string; versionId?: string }) {
    const artifact = await db.artifact.findFirst({
      where: { id: input.artifactId, ownerUserId: input.ownerUserId, archivedAt: null },
      select: { currentVersionId: true }
    });
    if (!artifact) return null;
    const row = await db.artifactVersion.findFirst({ where: {
      artifactId: input.artifactId, status: "READY",
      id: input.versionId ?? artifact.currentVersionId ?? ""
    } });
    return row ? publicVersion(row) : null;
  }

  async function detail(ownerUserId: string, artifactId: string) {
    const artifact = await db.artifact.findFirst({
      where: { id: artifactId, ownerUserId, archivedAt: null },
      include: {
        versions: { where: { status: "READY" }, orderBy: { versionNumber: "asc" } },
        publications: { orderBy: { createdAt: "desc" }, select: {
          id: true, artifactVersionId: true, byteSize: true, checksum: true, createdAt: true,
          expiresAt: true, kind: true, revokedAt: true, status: true, title: true
        } }
      }
    });
    if (!artifact) return null;
    return {
      id: artifact.id,
      kind: artifact.kind,
      title: artifact.title,
      sourceChatId: artifact.sourceChatId && await db.chat.count({ where: { id: artifact.sourceChatId, userId: ownerUserId, projectId: null, archived: false, permanentDeletionAt: null } }) ? artifact.sourceChatId : null,
      currentVersionId: artifact.currentVersionId,
      createdAt: artifact.createdAt.toISOString(),
      updatedAt: artifact.updatedAt.toISOString(),
      versions: artifact.versions.map(publicVersion),
      publications: artifact.publications.map((publication) => ({
        byteSize: publication.byteSize,
        checksum: publication.checksum,
        createdAt: publication.createdAt.toISOString(),
        expiresAt: publication.expiresAt?.toISOString() ?? null,
        id: publication.id,
        kind: publication.kind,
        revokedAt: publication.revokedAt?.toISOString() ?? null,
        status: publication.status === "PENDING" && publication.createdAt.getTime() <= Date.now() - ARTIFACT_WRITE_LEASE_MS ? "REVOKED" : publication.status,
        title: publication.title,
        versionId: publication.artifactVersionId
      }))
    };
  }

  async function getPrivateBundle(input: { ownerUserId: string; artifactId: string; versionId?: string }) {
    const artifact = await db.artifact.findFirst({ where: { id: input.artifactId, ownerUserId: input.ownerUserId, archivedAt: null }, select: { currentVersionId: true } });
    if (!artifact) return null;
    const row = await db.artifactVersion.findFirst({ where: {
      artifactId: input.artifactId, status: "READY", id: input.versionId ?? artifact.currentVersionId ?? ""
    } });
    if (!row) return null;
    const object = await storage.getObject(row.bundleStorageKey, { maxBytes: row.byteSize });
    if (object.body.byteLength !== row.byteSize || checksum(object.body) !== row.checksum) throw new Error("artifact_bundle_unavailable");
    const bundle = decodeArtifactBundle(object.body);
    const rendered = renderArtifactBundle(bundle);
    return { ...rendered, version: publicVersion(row) };
  }

  async function getPrivateZip(input: { ownerUserId: string; artifactId: string; versionId?: string }) {
    const artifact = await db.artifact.findFirst({ where: { id: input.artifactId, ownerUserId: input.ownerUserId, archivedAt: null }, select: { currentVersionId: true } });
    if (!artifact) return null;
    const row = await db.artifactVersion.findFirst({ where: {
      artifactId: input.artifactId, status: "READY", id: input.versionId ?? artifact.currentVersionId ?? ""
    } });
    if (!row) return null;
    const object = await storage.getObject(row.bundleStorageKey, { maxBytes: row.byteSize });
    if (object.body.byteLength !== row.byteSize || checksum(object.body) !== row.checksum) throw new Error("artifact_bundle_unavailable");
    return { body: artifactZip(decodeArtifactBundle(object.body)), contentType: "application/zip", fileName: `${row.title.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80) || "artifact"}.zip`, version: publicVersion(row) };
  }

  async function source(input: { ownerUserId: string; artifactId: string; versionId: string }) {
    const row = await db.artifactVersion.findFirst({ where: { id: input.versionId, artifactId: input.artifactId, status: "READY",
      artifact: { ownerUserId: input.ownerUserId, archivedAt: null } } });
    if (!row) return null;
    const object = await storage.getObject(row.bundleStorageKey, { maxBytes: row.byteSize });
    if (object.body.byteLength !== row.byteSize || checksum(object.body) !== row.checksum) throw new Error("artifact_bundle_unavailable");
    const bundle = decodeArtifactBundle(object.body);
    return { versionId: row.id, files: bundle.files.map((file) => ({ path: file.path, mimeType: file.mimeType,
      ...(file.text !== undefined ? { text: file.text } : { binary: true as const }) })) };
  }

  async function prepareEdit(input: { ownerUserId: string; artifactId: string; versionId: string; chatId?: string }) {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Artifact" WHERE "id" = ${input.artifactId} FOR UPDATE`;
      const artifact = await tx.artifact.findFirst({ where: { id: input.artifactId, ownerUserId: input.ownerUserId, archivedAt: null } });
      if (!artifact) throw new Error("artifact_not_found");
      if (artifact.currentVersionId !== input.versionId) throw new Error("artifact_version_conflict");
      const existing = input.chatId ? await tx.chat.findFirst({ where: { id: input.chatId, userId: input.ownerUserId, projectId: null,
        memoryMode: { not: "TEMPORARY" }, archived: false, permanentDeletionAt: null } }) : (await tx.artifactChatBinding.findFirst({
          where: { artifactId: artifact.id, chat: { userId: input.ownerUserId, projectId: null, memoryMode: { not: "TEMPORARY" }, archived: false, permanentDeletionAt: null } },
          orderBy: { updatedAt: "desc" }, include: { chat: true }
        }))?.chat;
      if (input.chatId && !existing) throw new Error("artifact_chat_unavailable");
      const chat = existing ?? await tx.chat.create({ data: { userId: input.ownerUserId, title: artifact.title } });
      await tx.artifactChatBinding.upsert({ where: { artifactId_chatId: { artifactId: artifact.id, chatId: chat.id } },
        create: { artifactId: artifact.id, chatId: chat.id, versionId: input.versionId }, update: { versionId: input.versionId } });
      return { chatId: chat.id, artifactId: artifact.id, versionId: input.versionId };
    });
  }

  async function rename(input: { ownerUserId: string; artifactId: string; title: string }) {
    const title = input.title.trim().normalize("NFC");
    if (!title || Buffer.byteLength(title) > ARTIFACT_LIMITS.maxTitleBytes || /[\u0000-\u001f\u007f]/u.test(title)) throw new Error("artifact_title_invalid");
    const changed = await db.artifact.updateMany({ where: { id: input.artifactId, ownerUserId: input.ownerUserId, archivedAt: null }, data: { title } });
    if (!changed.count) throw new Error("artifact_not_found");
    return { title };
  }

  async function publish(input: { artifactId: string; ownerUserId: string; versionId: string; expiresAt?: Date | null }) {
    if (input.expiresAt && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date() || input.expiresAt.getTime() - Date.now() > ARTIFACT_LIMITS.maxPublicationDays * 86_400_000)) throw new Error("artifact_expiry_invalid");
    const token = createShareToken();
    const publication = await db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Artifact" WHERE "id" = ${input.artifactId} FOR UPDATE`);
      const row = await tx.artifactVersion.findFirst({ where: { id: input.versionId, artifactId: input.artifactId, status: "READY",
        artifact: { ownerUserId: input.ownerUserId, archivedAt: null } } });
      if (!row) throw new Error("artifact_version_not_found");
      const storageKey = `artifact-publications/${input.ownerUserId}/${randomUUID()}.bundle.json`;
      const publication = await tx.artifactPublication.create({ data: { artifactId: row.artifactId, artifactVersionId: row.id,
        bundleStorageKey: storageKey, byteSize: row.byteSize, checksum: row.checksum, kind: row.kind,
        ownerUserId: input.ownerUserId, publicManifest: json(publicManifestFromPrivate(row.manifest)), title: row.title,
        tokenHash: hashShareToken(token), expiresAt: input.expiresAt, status: "PENDING" } });
      await tx.attachmentDeletionJob.create({ data: { storageKey } });
      return { ...publication, sourceStorageKey: row.bundleStorageKey };
    });
    try {
      const source = await storage.getObject(publication.sourceStorageKey, { maxBytes: publication.byteSize });
      if (source.body.byteLength !== publication.byteSize || checksum(source.body) !== publication.checksum) throw new Error("artifact_bundle_unavailable");
      await storage.putObject({ body: source.body, contentType: "application/vnd.aiqsa.artifact+json", storageKey: publication.bundleStorageKey });
      const stored = await storage.getObject(publication.bundleStorageKey, { maxBytes: publication.byteSize });
      if (stored.body.byteLength !== publication.byteSize || checksum(stored.body) !== publication.checksum) throw new Error("artifact_bundle_write_failed");
      await db.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Artifact" WHERE "id" = ${input.artifactId} FOR UPDATE`);
        const settled = await tx.artifactPublication.updateMany({ where: { id: publication.id, status: "PENDING", revokedAt: null, createdAt: { gt: new Date(Date.now() - ARTIFACT_WRITE_LEASE_MS) },
          artifact: { ownerUserId: input.ownerUserId, archivedAt: null } }, data: { status: "READY" } });
        if (settled.count !== 1) throw new Error("artifact_publication_unavailable");
      });
    } catch (error) {
      await db.artifactPublication.updateMany({ where: { id: publication.id, status: "PENDING" }, data: { revokedAt: new Date(), status: "REVOKED" } }).catch(() => undefined);
      await db.attachmentDeletionJob.upsert({ where: { storageKey: publication.bundleStorageKey }, create: { storageKey: publication.bundleStorageKey }, update: {} });
      // Retention checks canonical state before deleting this staged object.
      throw error;
    }
    return { id: publication.id, kind: publication.kind, title: publication.title, versionId: publication.artifactVersionId,
      publicPath: `/a/${token}`, shareToken: token, createdAt: publication.createdAt.toISOString() };
  }

  async function publicBundle(token: string) {
    const row = await db.artifactPublication.findFirst({ where: { tokenHash: hashShareToken(token), status: "READY", revokedAt: null, artifact: { archivedAt: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
    if (!row) return null;
    const object = await storage.getObject(row.bundleStorageKey, { maxBytes: row.byteSize });
    if (object.body.byteLength !== row.byteSize || checksum(object.body) !== row.checksum) return null;
    const bundle = decodeArtifactBundle(object.body);
    const rendered = renderArtifactBundle(bundle);
    return { ...rendered, manifest: row.publicManifest, title: row.title, kind: row.kind };
  }

  async function publicZip(token: string) {
    const row = await db.artifactPublication.findFirst({ where: { tokenHash: hashShareToken(token), status: "READY", revokedAt: null, artifact: { archivedAt: null },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
    if (!row) return null;
    const object = await storage.getObject(row.bundleStorageKey, { maxBytes: row.byteSize }).catch(() => null);
    if (!object || object.body.byteLength !== row.byteSize || checksum(object.body) !== row.checksum) return null;
    return { body: artifactZip(decodeArtifactBundle(object.body)), contentType: "application/zip", fileName: `${row.title.replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80) || "artifact"}.zip` };
  }

  async function revoke(input: { ownerUserId: string; publicationId: string }) {
    const row = await db.artifactPublication.findFirst({ where: { id: input.publicationId, ownerUserId: input.ownerUserId }, select: { id: true } });
    if (!row) return false;
    await db.artifactPublication.updateMany({ where: { id: row.id, status: { in: ["PENDING", "READY"] }, revokedAt: null }, data: { revokedAt: new Date(), status: "REVOKED" } });
    return true;
  }

  async function contextForChat(input: { ownerUserId: string; chatId: string }) {
    const rows = await db.artifactChatBinding.findMany({
      where: { chatId: input.chatId, artifact: { ownerUserId: input.ownerUserId, archivedAt: null }, version: { status: "READY" } },
      orderBy: { updatedAt: "desc" },
      take: ARTIFACT_LIMITS.maxContextArtifacts,
      select: {
        artifactId: true,
        versionId: true,
        artifact: { select: { id: true, kind: true, title: true } },
        version: { select: { id: true, artifactId: true, kind: true, title: true, entrypoint: true, versionNumber: true, byteSize: true, checksum: true, bundleStorageKey: true, manifest: true } }
      }
    });
    const contexts: Array<{ artifact_id: string; base_version_id: string; kind: string; title: string; version_number: number; entrypoint: string | null; files: Array<{ path: string; mimeType: string; binary?: boolean; text?: string; asset_ref?: string }> }> = [];
    let sourceBytes = 0;
    for (const binding of rows) {
      const artifact = binding.artifact;
      const version = binding.version;
      if (version.artifactId !== binding.artifactId || version.id !== binding.versionId || version.byteSize > ARTIFACT_LIMITS.maxBundleBytes) continue;
      const object = await storage.getObject(version.bundleStorageKey, { maxBytes: version.byteSize }).catch(() => null);
      if (!object || object.body.byteLength !== version.byteSize || checksum(object.body) !== version.checksum) continue;
      const bundle = decodeArtifactBundle(object.body);
      const textBytes = bundle.files.reduce((sum, file) => sum + (file.text === undefined ? 0 : Buffer.byteLength(file.text, "utf8")), 0);
      if (sourceBytes + textBytes > ARTIFACT_LIMITS.maxSourceBytes) continue;
      sourceBytes += textBytes;
      const privateFiles = Array.isArray((version.manifest as { files?: unknown }).files)
        ? (version.manifest as { files: Array<Record<string, unknown>> }).files
        : [];
      const files: Array<{ path: string; mimeType: string; binary?: boolean; text?: string; asset_ref?: string }> = bundle.files.flatMap<{ path: string; mimeType: string; binary?: boolean; text?: string; asset_ref?: string }>((file) => {
        const metadata = privateFiles.find((candidate) => candidate.path === file.path);
        if (file.text === undefined) return [{ path: file.path, mimeType: file.mimeType, binary: true,
          ...(typeof metadata?.assetRef === "string" ? { asset_ref: metadata.assetRef } : {}) }];
        return [{ path: file.path, mimeType: file.mimeType, text: file.text }];
      });
      contexts.push({ artifact_id: artifact.id, base_version_id: version.id, kind: version.kind, title: version.title,
        version_number: version.versionNumber, entrypoint: version.entrypoint, files });
    }
    return contexts;
  }

  async function setArchived(input: { artifactId: string; ownerUserId: string; archived: boolean }) {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Artifact" WHERE "id" = ${input.artifactId} FOR UPDATE`;
      const artifact = await tx.artifact.findFirst({ where: { id: input.artifactId, ownerUserId: input.ownerUserId } });
      if (!artifact) throw new Error("artifact_not_found");
      await tx.artifact.update({ where: { id: artifact.id }, data: { archivedAt: input.archived ? new Date() : null } });
      if (input.archived) {
        await tx.artifactPublication.updateMany({ where: { artifactId: artifact.id, status: { in: ["PENDING", "READY"] } }, data: { revokedAt: new Date(), status: "REVOKED" } });
      }
      return { archived: input.archived };
    });
  }

  async function archive(input: { artifactId: string; ownerUserId: string }) {
    return (await setArchived({ ...input, archived: true })).archived;
  }

  async function remove(input: { artifactId: string; ownerUserId: string }) {
    return db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Artifact" WHERE "id" = ${input.artifactId} FOR UPDATE`;
      const artifact = await tx.artifact.findFirst({ where: { id: input.artifactId, ownerUserId: input.ownerUserId },
        include: { versions: { select: { bundleStorageKey: true } }, publications: { select: { bundleStorageKey: true } } } });
      if (!artifact) return false;
      for (const row of [...artifact.versions, ...artifact.publications]) {
        await tx.attachmentDeletionJob.upsert({ where: { storageKey: row.bundleStorageKey }, create: { storageKey: row.bundleStorageKey }, update: {} });
      }
      await tx.artifact.delete({ where: { id: artifact.id } });
      return true;
    });
  }

  async function restoreVersion(input: { artifactId: string; ownerUserId: string; versionId: string }) {
    const result = await db.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Artifact" WHERE "id" = ${input.artifactId} FOR UPDATE`);
      const artifact = await tx.artifact.findFirst({
        where: { id: input.artifactId, ownerUserId: input.ownerUserId, archivedAt: null },
        select: { id: true }
      });
      if (!artifact) return null;
      const version = await tx.artifactVersion.findFirst({
        where: { id: input.versionId, artifactId: input.artifactId, status: "READY" },
        select: { id: true, kind: true, title: true }
      });
      if (!version) throw new Error("artifact_version_not_found");
      await expireWrites(tx, artifact.id);
      if (await tx.artifactVersion.count({ where: { artifactId: artifact.id, status: "PENDING" } })) throw new Error("artifact_version_conflict");
      await tx.artifact.update({ where: { id: artifact.id }, data: { currentVersionId: version.id, kind: version.kind, title: version.title } });
      await tx.artifactChatBinding.updateMany({ where: { artifactId: artifact.id }, data: { versionId: version.id } });
      return version.id;
    });
    return result ? getArtifactVersion({ ownerUserId: input.ownerUserId, artifactId: input.artifactId, versionId: result }) : null;
  }

  function artifactResult(call: ModelToolCall, version: Awaited<ReturnType<typeof getArtifactVersion>>): ToolExecutionResult {
    if (!version) throw new Error("artifact_version_not_found");
    const payload = {
      artifact_id: version.artifactId,
      version_id: version.id,
      version_number: version.versionNumber,
      kind: version.kind,
      title: version.title,
      entrypoint: version.entrypoint
    };
    return {
      callId: call.id,
      name: call.name,
      status: "complete",
      content: [{ type: "json", value: payload }],
      artifacts: [{ type: "artifact", data: { artifactType: "generated_artifact", payload } }]
    };
  }

  async function restore(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult | null> {
    if (!context.persistedToolCallId || !context.userId) return null;
    const row = await db.artifactVersion.findFirst({
      where: { sourceToolCallId: context.persistedToolCallId, sourceModelRunId: context.runId, status: "READY", artifact: { ownerUserId: context.userId, archivedAt: null } }
    });
    if (!row) return null;
    return artifactResult(call, publicVersion(row));
  }

  async function execute(call: ModelToolCall, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (call.name !== ARTIFACT_TOOL_NAME || !context.runId || !context.userId || !context.persistedToolCallId) {
      throw new Error("artifact_tool_unavailable");
    }
    const restored = await restore(call, context);
    if (restored) return restored;
    const args = call.arguments;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("artifact_operation_invalid");
    const operation = {
      ...(typeof args.base_version_id === "string" ? { baseVersionId: args.base_version_id } : {}),
      ...(typeof args.entrypoint === "string" ? { entrypoint: args.entrypoint } : {}),
      files: Array.isArray(args.files) ? args.files.map((file) => {
        if (!file || typeof file !== "object" || Array.isArray(file)) return file;
        const value = file as Record<string, unknown>;
        return {
          ...(typeof value.asset_ref === "string" ? { assetRef: value.asset_ref } : {}),
          ...(typeof value.mimeType === "string" ? { mimeType: value.mimeType } : {}),
          ...(typeof value.path === "string" ? { path: value.path } : {}),
          ...(typeof value.text === "string" ? { text: value.text } : {})
        };
      }) : args.files,
      intent: args.intent,
      kind: args.kind,
      title: args.title
    } as ArtifactOperation;
    if (operation.intent === "update") {
      const admitted = context.request.artifactReferences?.some((reference) => reference.versionId === operation.baseVersionId);
      const createdThisRun = !admitted && await db.artifactVersion.findFirst({ where: {
        id: operation.baseVersionId ?? "", sourceModelRunId: context.runId, status: "READY",
        artifact: { ownerUserId: context.userId, archivedAt: null }
      }, select: { id: true } });
      if (!admitted && !createdThisRun) throw new Error("artifact_edit_context_unavailable");
    }
    const version = await createVersion({
      operation,
      ownerUserId: context.userId,
      sourceChatId: context.request.chatId,
      sourceModelRunId: context.runId,
      sourceToolCallId: context.persistedToolCallId,
      allowedAssetRefs: context.request.imageReferences?.map((reference) => reference.attachmentId) ?? []
    });
    return artifactResult(call, version);
  }

  return {
    createVersion,
    contextForChat,
    execute,
    detail,
    getArtifactVersion,
    getPrivateBundle,
    getPrivateZip,
    source,
    prepareEdit,
    rename,
    list: async (ownerUserId: string, archived = false) => {
      const rows = await db.artifact.findMany({ where: { ownerUserId, archivedAt: archived ? { not: null } : null, currentVersionId: { not: null } },
        orderBy: { updatedAt: "desc" }, take: 100,
        include: { _count: { select: { publications: { where: { status: "READY", revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } } } } } });
      const versions = await db.artifactVersion.findMany({ where: { id: { in: rows.flatMap(row => row.currentVersionId ? [row.currentVersionId] : []) }, status: "READY" },
        select: { id: true, status: true, versionNumber: true } });
      return rows.map((artifact) => ({ ...artifact, versions: versions.filter(version => version.id === artifact.currentVersionId) }));
    },
    publish,
    publicBundle,
    publicZip,
    archive,
    remove,
    setArchived,
    restoreVersion,
    restore,
    revoke
  };
}
