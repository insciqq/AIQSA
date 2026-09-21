import { Prisma, type PrismaClient } from "@prisma/client";
import type { AdminSkillFileDiff, AdminSkillShareRequestDetail, AdminSkillShareRequestSummary } from "../../contracts/adminSkills";
import type { SkillAudience, SkillRevisionSummary, SkillShareRequestState, SkillShareRequestSummary } from "../../contracts/skills";
import { renderSkillMarkdown } from "./bundle";

export class SkillSharingError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}

export const skillRevisionSummary = (revision: { id: string; revisionNumber: number; name: string; createdAt: Date }): SkillRevisionSummary => ({
  id: revision.id, revisionNumber: revision.revisionNumber, name: revision.name, createdAt: revision.createdAt.toISOString()
});
export function skillShareRequestSummary(request: {
  id: string; revisionId: string; state: SkillShareRequestState; createdAt: Date; reviewedAt: Date | null; reviewNote: string | null;
  revision: { revisionNumber: number };
}): SkillShareRequestSummary {
  return { id: request.id, revisionId: request.revisionId, revisionNumber: request.revision.revisionNumber,
    state: request.state, createdAt: request.createdAt.toISOString(), reviewedAt: request.reviewedAt?.toISOString() ?? null,
    reviewNote: request.reviewNote };
}

async function lockSkill(tx: Prisma.TransactionClient, skillId: string) {
  await tx.$queryRaw`SELECT "id" FROM "SkillDefinition" WHERE "id" = ${skillId} FOR UPDATE`;
  return tx.skillDefinition.findUnique({ where: { id: skillId }, include: { currentRevision: true } });
}

/** Caller keeps audience creation in this same transaction. The definition lock
 * serializes requests, decisions and lifecycle changes; content stays immutable. */
export async function ensureSkillShareRequest(tx: Prisma.TransactionClient, input: {
  userId: string; skillId: string; expectedVersion?: number; explicit?: boolean; firstAudience?: boolean;
}) {
  const skill = await lockSkill(tx, input.skillId);
  if (!skill || skill.ownerUserId !== input.userId || skill.deletedAt || !skill.currentRevision?.bundleReady) {
    throw new SkillSharingError("skill_not_available", 404);
  }
  if (skill.archivedAt) throw new SkillSharingError("skill_archived");
  if (input.expectedVersion !== undefined && skill.version !== input.expectedVersion) throw new SkillSharingError("skill_version_conflict");
  if (skill.sharedRevisionId === skill.currentRevisionId) return;
  if (!input.explicit && (skill.sharedRevisionId || !input.firstAudience)) return;
  const [actor] = await tx.$queryRaw<Array<{ role: string }>>`
    SELECT "role" FROM "User" WHERE "id" = ${input.userId} AND "status" = 'active' FOR SHARE`;
  if (!actor) throw new SkillSharingError("skill_not_available", 404);
  const pending = await tx.skillShareRequest.findFirst({ where: { skillId: skill.id, state: "pending" } });
  // A lost response can be retried with the same content version. Reuse that
  // request instead of invalidating an administrator's open review page.
  if (pending?.revisionId === skill.currentRevisionId && actor.role !== "admin") return;
  const latest = await tx.skillShareRequest.findFirst({ where: { skillId: skill.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  // Transactions may begin before their definition lock is acquired. Keep the
  // owner's latest-request projection in the same order as serialized writes,
  // even with a backward clock jump or several requests in one millisecond.
  const createdAt = new Date(Math.max(Date.now(), (latest?.createdAt.getTime() ?? 0) + 1));
  await tx.skillShareRequest.updateMany({ where: { skillId: skill.id, state: "pending" }, data: { state: "superseded" } });
  const approved = actor.role === "admin";
  await tx.skillShareRequest.create({ data: {
    skillId: skill.id, revisionId: skill.currentRevisionId!, requestedByUserId: input.userId, createdAt,
    ...(approved ? { state: "approved", reviewedByUserId: input.userId, reviewedAt: new Date() } : {})
  } });
  if (approved) await tx.skillDefinition.update({ where: { id: skill.id }, data: { sharedRevisionId: skill.currentRevisionId } });
}

type DiffFile = { path: string; checksum: string; byteSize: number; kind: string; executable: boolean };
export function skillFileDiff(previous: readonly DiffFile[], requested: readonly DiffFile[]): AdminSkillFileDiff[] {
  const before = new Map(previous.map((file) => [file.path, file]));
  const after = new Map(requested.map((file) => [file.path, file]));
  return [...new Set([...before.keys(), ...after.keys()])].sort().flatMap((path): AdminSkillFileDiff[] => {
    const old = before.get(path), next = after.get(path), file = next ?? old!;
    if (old && next && old.checksum === next.checksum && old.executable === next.executable && old.kind === next.kind) return [];
    return [{ path, byteSize: file.byteSize, kind: file.kind === "text" ? "text" : "binary", executable: file.executable,
      change: !old ? "added" : !next ? "removed" : "changed", ...(old ? { previousExecutable: old.executable } : {}) }];
  });
}

const fileSelect = { path: true, byteSize: true, checksum: true, kind: true, executable: true } satisfies Prisma.SkillRevisionFileSelect;
const requestInclude = {
  revision: { include: { files: { select: fileSelect, orderBy: { path: "asc" as const } } } },
  skill: { include: {
    owner: { select: { displayName: true } }, currentRevision: true,
    sharedRevision: { include: { files: { select: fileSelect, orderBy: { path: "asc" as const } } } },
    publications: { include: { group: { select: { id: true, name: true } } } },
    projectBindings: { select: { id: true } }
  } }
} satisfies Prisma.SkillShareRequestInclude;
type RequestRecord = Prisma.SkillShareRequestGetPayload<{ include: typeof requestInclude }>;

function adminSummary(row: Pick<RequestRecord, "id" | "revisionId" | "state" | "createdAt" | "reviewedAt" | "reviewNote" | "skillId"> & {
  revision: { name: string; revisionNumber: number; bundleReady: boolean };
  skill: { archivedAt: Date | null; deletedAt: Date | null; owner: { displayName: string } };
}): AdminSkillShareRequestSummary {
  return { ...skillShareRequestSummary(row), skillId: row.skillId, name: row.revision.name,
    ownerDisplayName: row.skill.owner.displayName,
    canReview: row.state === "pending" && !row.skill.archivedAt && !row.skill.deletedAt && row.revision.bundleReady };
}
function adminDetail(row: RequestRecord): AdminSkillShareRequestDetail {
  const revision = row.revision, previous = row.skill.sharedRevision;
  const audiences: SkillAudience[] = row.skill.publications.map((entry) => entry.scope === "installation"
    ? { id: entry.id, kind: "everyone", name: "Everyone" }
    : { id: entry.id, kind: "workspace", name: entry.group!.name, workspaceId: entry.group!.id });
  audiences.push(...row.skill.projectBindings.map((binding): SkillAudience => ({ id: `project:${binding.id}`, kind: "project", name: "Project publication" })));
  const skillMarkdown = renderSkillMarkdown(revision);
  return { ...adminSummary(row), audiences,
    currentRevision: row.skill.currentRevision ? skillRevisionSummary(row.skill.currentRevision) : null,
    sharedRevision: previous ? skillRevisionSummary(previous) : null,
    requestedRevision: { ...skillRevisionSummary(revision), description: revision.description, instructions: revision.instructions, skillMarkdown,
      files: revision.files.map((file) => ({ path: file.path, byteSize: file.byteSize, executable: file.executable, kind: file.kind === "text" ? "text" : "binary" })),
      bundle: { fileCount: revision.fileCount, totalBytes: revision.bundleByteSize, hasExecutables: revision.hasExecutables } },
    diff: { skillMarkdownChanged: !previous || renderSkillMarkdown(previous) !== skillMarkdown,
      files: skillFileDiff(previous?.files ?? [], revision.files) } };
}

async function requireAdmin(tx: Prisma.TransactionClient, userId: string) {
  const [admin] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "User" WHERE "id" = ${userId} AND "role" = 'admin' AND "status" = 'active' FOR SHARE`;
  if (!admin) throw new SkillSharingError("forbidden", 403);
}

export function createSkillSharingService(db: PrismaClient) {
  async function transaction<T>(write: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await db.$transaction(write); }
      catch (error) {
        const retryable = error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" ||
          (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code))) ||
          (error.code === "P2002" && (error.meta?.target === "SkillShareRequest_pending_skill_key" ||
            Array.isArray(error.meta?.target) && error.meta.target.length === 1 && error.meta.target[0] === "skillId")));
        if (!retryable) throw error;
        if (attempt >= 2) throw new SkillSharingError("skill_share_request_conflict");
      }
    }
  }
  return {
    request(userId: string, skillId: string, expectedVersion: number) {
      return transaction((tx) => ensureSkillShareRequest(tx, { userId, skillId, expectedVersion, explicit: true }));
    },
    withdraw(userId: string, skillId: string, requestId: string) {
      return transaction(async (tx) => {
        const skill = await lockSkill(tx, skillId);
        if (!skill || skill.ownerUserId !== userId || skill.deletedAt) throw new SkillSharingError("skill_not_available", 404);
        const result = await tx.skillShareRequest.updateMany({ where: { id: requestId, skillId, state: "pending" }, data: { state: "withdrawn" } });
        if (result.count !== 1) throw new SkillSharingError("skill_share_request_conflict");
      });
    },
    list(userId: string, input: { state: SkillShareRequestState; limit: number; cursor?: { id: string; createdAt: Date } }) {
      return transaction(async (tx) => {
        await requireAdmin(tx, userId);
        const rows = await tx.skillShareRequest.findMany({ where: { state: input.state,
          ...(input.cursor ? { OR: [{ createdAt: { lt: input.cursor.createdAt } }, { createdAt: input.cursor.createdAt, id: { gt: input.cursor.id } }] } : {}) },
          orderBy: [{ createdAt: "desc" }, { id: "asc" }], take: input.limit + 1,
          include: { revision: { select: { name: true, revisionNumber: true, bundleReady: true } },
            skill: { select: { archivedAt: true, deletedAt: true, owner: { select: { displayName: true } } } } } });
        const pendingCount = await tx.skillShareRequest.count({ where: { state: "pending", skill: { archivedAt: null, deletedAt: null } } });
        const page = rows.slice(0, input.limit), last = page.at(-1);
        return { requests: page.map(adminSummary), pendingCount,
          nextCursor: rows.length > input.limit && last ? Buffer.from(JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString() })).toString("base64url") : null };
      });
    },
    detail(userId: string, requestId: string) {
      return transaction(async (tx) => {
        await requireAdmin(tx, userId);
        const row = await tx.skillShareRequest.findUnique({ where: { id: requestId }, include: requestInclude });
        if (!row) throw new SkillSharingError("skill_share_request_not_available", 404);
        return adminDetail(row);
      });
    },
    file(userId: string, requestId: string, path: string) {
      return transaction(async (tx) => {
        await requireAdmin(tx, userId);
        const row = await tx.skillShareRequest.findUnique({ where: { id: requestId }, select: { revision: { select: { files: { where: { path } } } } } });
        if (!row) throw new SkillSharingError("skill_share_request_not_available", 404);
        const file = row.revision.files[0];
        if (!file) throw new SkillSharingError("skill_file_not_found", 404);
        if (file.kind !== "text" || file.textContent === null) throw new SkillSharingError("skill_file_binary", 400);
        return { path: file.path, content: file.textContent, bytes: file.byteSize };
      });
    },
    decide(userId: string, requestId: string, action: "approve" | "reject", note: string | null) {
      return transaction(async (tx) => {
        await requireAdmin(tx, userId);
        const request = await tx.skillShareRequest.findUnique({ where: { id: requestId }, select: { skillId: true } });
        if (!request) throw new SkillSharingError("skill_share_request_not_available", 404);
        const skill = await lockSkill(tx, request.skillId);
        if (!skill || skill.deletedAt) throw new SkillSharingError("skill_share_request_not_available", 404);
        if (skill.archivedAt) throw new SkillSharingError("skill_archived");
        const pending = await tx.skillShareRequest.findFirst({ where: { id: requestId, state: "pending", revision: { bundleReady: true } } });
        if (!pending) throw new SkillSharingError("skill_share_request_conflict");
        const result = await tx.skillShareRequest.updateMany({ where: { id: requestId, state: "pending" }, data: {
          state: action === "approve" ? "approved" : "rejected", reviewedByUserId: userId, reviewedAt: new Date(), reviewNote: note
        } });
        if (result.count !== 1) throw new SkillSharingError("skill_share_request_conflict");
        if (action === "approve") await tx.skillDefinition.update({ where: { id: skill.id }, data: { sharedRevisionId: pending.revisionId } });
        return adminDetail(await tx.skillShareRequest.findUniqueOrThrow({ where: { id: requestId }, include: requestInclude }));
      });
    }
  };
}
export type SkillSharingService = ReturnType<typeof createSkillSharingService>;
