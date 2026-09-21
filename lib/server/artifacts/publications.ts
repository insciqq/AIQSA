import { Prisma, type PrismaClient } from "@prisma/client";
import {
  ARTIFACT_LIMITS, ARTIFACT_MAX_VERSION_NUMBER, decodeArtifactPublicationMutation, decodeArtifactPublicationCreate,
  type ArtifactManifest, type ArtifactPublicManifest, type ArtifactPublicationMutation, type ArtifactPublicationSummary,
  type ArtifactVersionSummary, type ArtifactPublicationPage, type ArtifactVersionPage
} from "../../contracts/artifacts";
import { createShareToken, hashShareToken } from "../shares/tokens";
import { artifactDownloadName } from "./downloadName";
import { ARTIFACT_WRITE_LEASE_MS } from "./lifecycle";
import { boundedArtifactWork, ArtifactPublicBusyError, type createArtifactObjects } from "./objects";
import { renderArtifactBundle } from "./bundle";
import { artifactZip } from "./zip";

export function publicManifestFromPrivate(value: unknown): ArtifactManifest {
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
      return { byteSize: item.byteSize as number, mimeType: item.mimeType, path: item.path,
        ...(item.group === "authored" || item.group === "vendored" ? { group: item.group } : {}) };
    }),
    kind: candidate.kind as ArtifactManifest["kind"],
    title: candidate.title,
    version: 1
  };
}


const versionSelect = { id: true, title: true, kind: true, versionNumber: true, entrypoint: true, createdAt: true, status: true } as const;
const publicationInclude = {
  artifactVersion: { select: versionSelect },
  members: { orderBy: { position: "asc" as const }, take: ARTIFACT_LIMITS.maxPublicationVersions + 1, include: { version: { select: versionSelect } } }
} satisfies Prisma.ArtifactPublicationInclude;
type PublicationRow = Prisma.ArtifactPublicationGetPayload<{ include: typeof publicationInclude }>;
type VersionRow = Prisma.ArtifactVersionGetPayload<{ select: typeof versionSelect }>;
const versionSummary = (version: VersionRow): ArtifactVersionSummary => ({ id: version.id, title: version.title,
  kind: version.kind, versionNumber: version.versionNumber, entrypoint: version.entrypoint, createdAt: version.createdAt.toISOString() });
export function artifactPublicationSummary(row: PublicationRow): ArtifactPublicationSummary {
  const base = { id: row.id, status: row.status === "PENDING" && row.createdAt.getTime() <= Date.now() - ARTIFACT_WRITE_LEASE_MS
    ? "REVOKED" as const : row.status, expiresAt: row.expiresAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString() };
  return row.mode === "VERSION_SET"
    ? { ...base, mode: "version_set", revision: row.revision, defaultVersionId: row.defaultVersionId!, versions: row.members.map(member => versionSummary(member.version)) }
    : { ...base, mode: "single", revision: row.revision, versionId: row.artifactVersionId!, versionNumber: row.artifactVersion!.versionNumber };
}
const activeArtifact = (ownerUserId: string) => ({ ownerUserId, archivedAt: null, owner: { status: "active" as const } });
const activePublication = () => ({ status: "READY" as const, revokedAt: null,
  artifact: { archivedAt: null, owner: { status: "active" as const } }, owner: { status: "active" as const },
  OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });
const publicWhere = (token: string) => ({ tokenHash: hashShareToken(token), ...activePublication() });
function expectedRevision(row: PublicationRow, expected: number | undefined) {
  if (!Number.isSafeInteger(expected) || Number(expected) < 1 || Number(expected) > ARTIFACT_MAX_VERSION_NUMBER) throw new Error("artifact_publication_invalid");
  if (row.revision !== expected || row.revision === ARTIFACT_MAX_VERSION_NUMBER) throw new Error("artifact_publication_conflict");
}
function ensureActive(row: PublicationRow) {
  if (row.status !== "READY" || row.revokedAt || row.expiresAt && row.expiresAt <= new Date()) throw new Error("artifact_publication_not_found");
}
function pageSize(value?: number) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1 || value > ARTIFACT_LIMITS.maxOwnerPageSize)) throw new Error("artifact_page_invalid");
  return value ?? ARTIFACT_LIMITS.maxOwnerPageSize;
}
function validId(value: string | undefined) { return value === undefined || value.length > 0 && value.length <= 128 && !/[\u0000-\u001f\u007f]/u.test(value); }

export function createArtifactPublications(db: PrismaClient, objects: ReturnType<typeof createArtifactObjects>) {
  async function lock(tx: Prisma.TransactionClient, ownerUserId: string, publicationId: string) {
    const identity = await tx.artifactPublication.findFirst({ where: { id: publicationId, ownerUserId }, select: { artifactId: true } });
    if (!identity) return null;
    // All publication mutations follow the same ordering as archive/delete.
    await tx.$queryRaw`SELECT "id" FROM "Artifact" WHERE "id" = ${identity.artifactId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "ArtifactPublication" WHERE "id" = ${publicationId} FOR UPDATE`;
    return tx.artifactPublication.findFirst({ where: { id: publicationId, ownerUserId, artifact: activeArtifact(ownerUserId) }, include: publicationInclude });
  }
  async function publication(ownerUserId: string, publicationId: string) {
    const row = await db.$transaction(tx => tx.artifactPublication.findFirst({
      where: { id: publicationId, ownerUserId, artifact: activeArtifact(ownerUserId) }, include: publicationInclude
    }), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    return row ? artifactPublicationSummary(row) : null;
  }
  async function versionPage(ownerUserId: string, artifactId: string, input: { cursor?: string; limit?: number; versionId?: string } = {}): Promise<ArtifactVersionPage | null> {
    const take = pageSize(input.limit);
    if (!validId(input.cursor) || !validId(input.versionId) || input.cursor && input.versionId) throw new Error("artifact_page_invalid");
    if (!await db.artifact.findFirst({ where: { id: artifactId, ...activeArtifact(ownerUserId) }, select: { id: true } })) return null;
    const where = { artifactId, status: "READY" as const, artifact: activeArtifact(ownerUserId) };
    const anchor = input.cursor ? await db.artifactVersion.findFirst({ where: { ...where, id: input.cursor }, select: { versionNumber: true } }) : null;
    if (input.cursor && !anchor) throw new Error("artifact_page_invalid");
    const rows = await db.artifactVersion.findMany({ where: { ...where, ...(input.versionId ? { id: input.versionId } : {}),
      ...(anchor ? { versionNumber: { gt: anchor.versionNumber } } : {}) }, orderBy: { versionNumber: "asc" }, take: take + 1, select: versionSelect });
    if (input.versionId && rows.length === 0) return null;
    return { versions: rows.slice(0, take).map(versionSummary), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
  }
  async function publicationPage(ownerUserId: string, artifactId: string, input: { cursor?: string; limit?: number } = {}): Promise<ArtifactPublicationPage | null> {
    const take = pageSize(input.limit);
    if (!validId(input.cursor)) throw new Error("artifact_page_invalid");
    return db.$transaction(async tx => {
      if (!await tx.artifact.findFirst({ where: { id: artifactId, ...activeArtifact(ownerUserId) }, select: { id: true } })) return null;
      const where = { artifactId, ownerUserId, artifact: activeArtifact(ownerUserId) };
      const anchor = input.cursor ? await tx.artifactPublication.findFirst({ where: { ...where, id: input.cursor }, select: { id: true, createdAt: true } }) : null;
      if (input.cursor && !anchor) throw new Error("artifact_page_invalid");
      const rows = await tx.artifactPublication.findMany({ where: { ...where, ...(anchor ? { OR: [
        { createdAt: { lt: anchor.createdAt } }, { createdAt: anchor.createdAt, id: { lt: anchor.id } }
      ] } : {}) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: take + 1, include: publicationInclude });
      return { publications: rows.slice(0, take).map(artifactPublicationSummary), nextCursor: rows.length > take ? rows[take - 1]!.id : null };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  async function replaceMembers(tx: Prisma.TransactionClient, row: { id: string; artifactId: string }, versionIds: readonly string[]) {
    await tx.artifactPublicationVersion.deleteMany({ where: { publicationId: row.id } });
    await tx.artifactPublicationVersion.createMany({ data: versionIds.map((versionId, position) => ({ publicationId: row.id, artifactId: row.artifactId, versionId, position })) });
  }
  async function checkVersions(tx: Prisma.TransactionClient, artifactId: string, versionIds: readonly string[]) {
    if (versionIds.length === 0) throw new Error("artifact_publication_empty");
    if (versionIds.length > ARTIFACT_LIMITS.maxPublicationVersions) throw new Error("artifact_publication_limit_exceeded");
    const count = await tx.artifactVersion.count({ where: { artifactId, id: { in: [...versionIds] }, status: "READY" } });
    if (count !== versionIds.length) throw new Error("artifact_publication_version_invalid");
  }
  async function publishSet(input: { artifactId: string; ownerUserId: string; versionIds: readonly string[]; defaultVersionId: string; expiresAt?: Date | null }) {
    if (!decodeArtifactPublicationCreate({ mode: "version_set", versionIds: input.versionIds, defaultVersionId: input.defaultVersionId })) throw new Error("artifact_publication_invalid");
    if (input.expiresAt && (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= new Date() || input.expiresAt.getTime() - Date.now() > ARTIFACT_LIMITS.maxPublicationDays * 86_400_000)) throw new Error("artifact_expiry_invalid");
    const token = createShareToken();
    const summary = await db.$transaction(async tx => {
      await tx.$queryRaw`SELECT "id" FROM "Artifact" WHERE "id" = ${input.artifactId} FOR UPDATE`;
      if (!await tx.artifact.findFirst({ where: { id: input.artifactId, ...activeArtifact(input.ownerUserId) }, select: { id: true } })) throw new Error("artifact_not_found");
      await checkVersions(tx, input.artifactId, input.versionIds);
      const row = await tx.artifactPublication.create({ data: { artifactId: input.artifactId, ownerUserId: input.ownerUserId,
        mode: "VERSION_SET", status: "READY", defaultVersionId: input.defaultVersionId, tokenHash: hashShareToken(token), expiresAt: input.expiresAt } });
      await replaceMembers(tx, row, input.versionIds);
      return artifactPublicationSummary(await tx.artifactPublication.findUniqueOrThrow({ where: { id: row.id }, include: publicationInclude }));
    });
    return { ...summary, publicPath: `/a/${token}`, shareToken: token };
  }
  async function mutatePublication(input: { ownerUserId: string; publicationId: string; mutation: ArtifactPublicationMutation }) {
    const mutation = decodeArtifactPublicationMutation(input.mutation);
    if (!mutation) throw new Error("artifact_publication_invalid");
    return db.$transaction(async tx => {
      const row = await lock(tx, input.ownerUserId, input.publicationId);
      if (!row || row.mode !== "VERSION_SET") throw new Error("artifact_publication_not_found");
      ensureActive(row); expectedRevision(row, mutation.expectedRevision);
      const current = row.members.map(member => member.versionId);
      let ids = current, defaultVersionId = row.defaultVersionId!;
      switch (mutation.action) {
        case "add": {
          if (mutation.versionIds.some(id => current.includes(id))) throw new Error("artifact_publication_version_invalid");
          ids = [...current, ...mutation.versionIds]; await checkVersions(tx, row.artifactId, ids); break;
        }
        case "remove": {
          if (!current.includes(mutation.versionId)) throw new Error("artifact_publication_version_invalid");
          if (current.length === 1) throw new Error("artifact_publication_empty");
          if (mutation.versionId === defaultVersionId) throw new Error("artifact_publication_default_required");
          ids = current.filter(id => id !== mutation.versionId); break;
        }
        case "set_default": {
          if (!current.includes(mutation.versionId)) throw new Error("artifact_publication_version_invalid");
          defaultVersionId = mutation.versionId; break;
        }
        case "reorder": {
          if (mutation.versionIds.length !== current.length || mutation.versionIds.some(id => !current.includes(id))) throw new Error("artifact_publication_version_invalid");
          ids = [...mutation.versionIds]; break;
        }
      }
      if (mutation.action !== "set_default") await replaceMembers(tx, row, ids);
      const updated = await tx.artifactPublication.update({ where: { id: row.id }, data: { defaultVersionId, revision: { increment: 1 } }, include: publicationInclude });
      return artifactPublicationSummary(updated);
    });
  }
  async function reissue(input: { ownerUserId: string; publicationId: string; expectedRevision: number }) {
    const token = createShareToken();
    const result = await db.$transaction(async tx => {
      const row = await lock(tx, input.ownerUserId, input.publicationId);
      if (!row || row.mode !== "VERSION_SET") throw new Error("artifact_publication_not_found");
      ensureActive(row); expectedRevision(row, input.expectedRevision);
      return artifactPublicationSummary(await tx.artifactPublication.update({ where: { id: row.id },
        data: { tokenHash: hashShareToken(token), revision: { increment: 1 } }, include: publicationInclude }));
    });
    return { ...result, publicPath: `/a/${token}`, shareToken: token };
  }
  async function revoke(input: { ownerUserId: string; publicationId: string; expectedRevision?: number }) {
    return db.$transaction(async tx => {
      const row = await lock(tx, input.ownerUserId, input.publicationId);
      if (!row) return false;
      if (row.mode === "VERSION_SET") { ensureActive(row); expectedRevision(row, input.expectedRevision); }
      if (!row.revokedAt && row.status !== "REVOKED") await tx.artifactPublication.update({ where: { id: row.id }, data: {
        status: "REVOKED", revokedAt: new Date(), ...(row.mode === "VERSION_SET" ? { revision: { increment: 1 } } : {})
      } });
      return true;
    });
  }
  function manifest(row: PublicationRow): ArtifactPublicManifest | null {
    const versions = row.mode === "VERSION_SET" ? row.members.map(member => member.version) : row.artifactVersion ? [row.artifactVersion] : [];
    const fallback = row.mode === "VERSION_SET" ? versions.find(version => version.id === row.defaultVersionId) : versions[0];
    if (!fallback || versions.length > ARTIFACT_LIMITS.maxPublicationVersions || versions.some(version => version.status !== "READY")) return null;
    return { mode: row.mode === "VERSION_SET" ? "version_set" : "single", title: row.mode === "SINGLE" ? row.title! : fallback.title,
      kind: row.mode === "SINGLE" ? row.kind! : fallback.kind, expiresAt: row.expiresAt?.toISOString() ?? null,
      defaultVersionNumber: fallback.versionNumber, versions: versions.map(version => ({ versionNumber: version.versionNumber,
        title: row.mode === "SINGLE" ? row.title! : version.title, kind: row.mode === "SINGLE" ? row.kind! : version.kind })) };
  }
  async function publicRow(token: string) {
    // Prisma relation reads share a snapshot; membership/default can never be
    // assembled from different concurrent owner mutations.
    return boundedArtifactWork(() => db.$transaction(tx => tx.artifactPublication.findFirst({ where: publicWhere(token), include: publicationInclude }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }));
  }
  async function publicManifest(token: string) {
    const row = await publicRow(token);
    return row ? manifest(row) : null;
  }
  async function publicMetadata(token: string) {
    const value = await publicManifest(token);
    return value ? { title: value.title, kind: value.kind, expiresAt: value.expiresAt } : null;
  }
  async function resolvePublic(token: string, versionNumber?: number) {
    if (versionNumber !== undefined && (!Number.isSafeInteger(versionNumber) || versionNumber < 1 || versionNumber > ARTIFACT_MAX_VERSION_NUMBER)) return null;
    const row = await publicRow(token);
    if (!row || !manifest(row)) return null;
    const number = versionNumber ?? manifest(row)!.defaultVersionNumber;
    const selected = row.mode === "SINGLE" ? row.artifactVersion : row.members.find(member => member.version.versionNumber === number)?.version;
    if (!selected || selected.versionNumber !== number) return null;
    if (row.mode === "SINGLE") {
      if (!row.bundleStorageKey || !row.checksum || row.byteSize === null || !row.title || !row.kind) return null;
      return { publicationId: row.id, id: selected.id, artifactId: row.artifactId, ownerUserId: row.ownerUserId,
        versionNumber: selected.versionNumber, title: row.title, kind: row.kind, manifest: row.publicManifest,
        bundleStorageKey: row.bundleStorageKey, checksum: row.checksum, byteSize: row.byteSize };
    }
    const version = await db.artifactVersion.findFirst({ where: { id: selected.id, artifactId: row.artifactId, status: "READY" } });
    return version ? { ...version, publicationId: row.id, ownerUserId: row.ownerUserId } : null;
  }
  async function stillPublic(token: string, row: { publicationId: string; id: string }) {
    return !!await db.artifactPublication.findFirst({ where: { ...publicWhere(token), id: row.publicationId, AND: [{ OR: [
      { mode: "SINGLE", artifactVersionId: row.id },
      { mode: "VERSION_SET", members: { some: { versionId: row.id, version: { status: "READY" } } } }
    ] }] }, select: { id: true } });
  }
  async function publicBundle(token: string, mainFile = false, versionNumber?: number) {
    try {
      const row = await resolvePublic(token, versionNumber);
      if (!row || !await stillPublic(token, row)) return null;
      const rendered = mainFile && row.kind === "svg"
        ? await boundedArtifactWork(async () => renderArtifactBundle(await objects.hydrate(row.ownerUserId, row.id, await objects.readBundle(row)), true))
        : await objects.rendered(row);
      if (!await stillPublic(token, row)) return null;
      const extension = mainFile && row.kind === "svg" ? "svg" : rendered.contentType.startsWith("image/")
        ? rendered.contentType === "image/jpeg" ? "jpg" : rendered.contentType.split("/")[1]! : "html";
      // Source file metadata remains a positive projection; private provenance
      // and storage identities never cross the anonymous boundary.
      return { ...rendered, fileName: artifactDownloadName(row.title, extension).utf8, title: row.title, kind: row.kind, versionNumber: row.versionNumber, manifest: publicManifestFromPrivate(row.manifest) };
    } catch (error) { if (error instanceof ArtifactPublicBusyError) throw error; return null; }
  }
  async function publicZip(token: string, versionNumber?: number) {
    try {
      const row = await resolvePublic(token, versionNumber);
      if (!row || !await stillPublic(token, row)) return null;
      return await boundedArtifactWork(async () => {
        const bundle = await objects.hydrate(row.ownerUserId, row.id, await objects.readBundle(row));
        const body = artifactZip(bundle);
        if (!await stillPublic(token, row)) return null;
        return { body, contentType: "application/zip", fileName: artifactDownloadName(row.title, "zip").utf8, title: row.title, versionNumber: row.versionNumber };
      });
    } catch (error) { if (error instanceof ArtifactPublicBusyError) throw error; return null; }
  }
  return { publication, versionPage, publicationPage, publishSet, mutatePublication, reissue, revoke, publicManifest, publicMetadata, publicBundle, publicZip };
}
