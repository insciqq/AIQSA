import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { retainDatabaseFailure } from "../../observability/databaseFailure";
import { archiveActiveGroup, reservedFullAccessName } from "../adminGroupGrantCommands";
import { normalizeAdminGroupName } from "../adminRepositoryInputs";
import { deactivateUserAsSystem, reactivateUserAsSystem } from "../adminUserSessionCommands";
import { applyMembershipChange } from "../groupMembership";
import { isPlausibleEmail, normalizeAuthEmail } from "../password";
import { provisionActiveUser } from "../provisioning";
import { lockActiveAdmins, lockAuthRegistrationEmail, lockAuthUser } from "../transactionLocks";
import type { ScimFilterClause, ScimGroupFilterAttribute, ScimUserFilterAttribute } from "./filter";
import {
  invalidScimValue,
  SCIM_MEMBER_CHANGES_MAX,
  type ScimGroupRecord,
  type ScimUserRecord
} from "./protocol";
import {
  applyScimMemberOperations,
  resolveScimUserPatch,
  type ScimGroupInput,
  type ScimGroupPatch,
  type ScimUserInput,
  type ScimUserPatch
} from "./requests";

export type ScimUserWriteResult =
  | { kind: "admin_disabled" }
  | { kind: "last_admin" }
  | { kind: "not_found" }
  | { kind: "ok"; userId: string }
  /** Committed: access is revoked and the deactivation recorded, the status stays active. */
  | { kind: "owner_transfer_required"; projectCount: number }
  | { kind: "uniqueness" };

export type ScimGroupWriteResult =
  | { kind: "not_found" }
  | { kind: "ok"; groupId: string }
  | { detail: string; kind: "uniqueness" };

export type ScimList<T> = { resources: T[]; totalResults: number };

export type ScimListQuery<Attribute extends string> = {
  clauses: readonly ScimFilterClause<Attribute>[];
  count: number;
  startIndex: number;
};

/**
 * What the SCIM endpoints read and write. Every user and group a SCIM write touches becomes
 * SCIM-managed: `scimExternalId` holds the client's externalId, or the resource's own id when the
 * client sent none. Writes that a refusal ends change nothing, except the committed
 * `owner_transfer_required` deactivation.
 */
export type ScimRepository = {
  createGroup(input: ScimGroupInput): Promise<ScimGroupWriteResult>;
  createUser(input: ScimUserInput, now: Date): Promise<ScimUserWriteResult>;
  /** SCIM DELETE never erases: the account is deactivated. */
  deactivateUser(id: string, now: Date): Promise<ScimUserWriteResult>;
  /** Archives the group and clears its SCIM link; the Full access group is only unlinked. */
  deleteGroup(id: string): Promise<ScimGroupWriteResult>;
  getGroup(id: string, members: boolean): Promise<ScimGroupRecord | null>;
  getUser(id: string): Promise<ScimUserRecord | null>;
  listGroups(query: ScimListQuery<ScimGroupFilterAttribute> & { members: boolean }): Promise<ScimList<ScimGroupRecord>>;
  listUsers(query: ScimListQuery<ScimUserFilterAttribute>): Promise<ScimList<ScimUserRecord>>;
  patchGroup(id: string, patch: ScimGroupPatch): Promise<ScimGroupWriteResult>;
  patchUser(id: string, patch: ScimUserPatch, now: Date): Promise<ScimUserWriteResult>;
  replaceGroup(id: string, input: ScimGroupInput): Promise<ScimGroupWriteResult>;
  replaceUser(id: string, input: ScimUserInput, now: Date): Promise<ScimUserWriteResult>;
};

/** Ends a write without committing anything. */
class ScimRefusal<T> extends Error {
  constructor(readonly result: T) {
    super("scim_write_refused");
  }
}

/** The state changed between the unlocked read and the locks; the write starts over. */
class ScimWriteRetry extends Error {
  constructor() {
    super("scim_write_retry");
  }
}

const WRITE_ATTEMPTS = 3;
const USER_TRANSACTION = { maxWait: 10_000, timeout: 15_000 } as const;
// Up to SCIM_MEMBER_CHANGES_MAX membership changes, each with its MCP side effects. Serializable,
// like the administrator's membership editor, so a manual edit that raced a SCIM link or push
// fails instead of landing on a group SCIM now manages.
const GROUP_TRANSACTION = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 10_000,
  timeout: 60_000
} as const;

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

/** Serialization failures and deadlocks, from typed queries (P2034) or the raw row locks (P2010). */
function isRetryable(error: unknown): boolean {
  return error instanceof ScimWriteRetry ||
    (error instanceof Prisma.PrismaClientKnownRequestError && (error.code === "P2034" ||
      (error.code === "P2010" && ["40001", "40P01"].includes(String(error.meta?.code)))));
}

async function attempt<T>(run: () => Promise<T>, unique: T): Promise<T> {
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ScimRefusal) return error.result as T;
      if (isUniqueViolation(error)) return unique;
      if (attemptNumber < WRITE_ATTEMPTS && isRetryable(error)) continue;
      return retainDatabaseFailure(error);
    }
  }
}

const userSelect = {
  createdAt: true,
  displayName: true,
  email: true,
  groups: { select: { group: { select: { archivedAt: true, id: true, name: true } } } },
  id: true,
  scimExternalId: true,
  status: true,
  updatedAt: true
} satisfies Prisma.UserSelect;

function userRecord(row: Prisma.UserGetPayload<{ select: typeof userSelect }>): ScimUserRecord {
  return {
    createdAt: row.createdAt,
    displayName: row.displayName,
    email: row.email,
    groups: row.groups
      .filter((membership) => membership.group.archivedAt === null)
      .map((membership) => ({ id: membership.group.id, name: membership.group.name }))
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id)),
    id: row.id,
    scimExternalId: row.scimExternalId,
    status: row.status,
    updatedAt: row.updatedAt
  };
}

const NOTHING = { id: { in: [] as string[] } };

function userClause(clause: ScimFilterClause<ScimUserFilterAttribute>): Prisma.UserWhereInput {
  switch (clause.attribute) {
    case "emails.value":
    case "userName": {
      const email = normalizeAuthEmail(clause.value);
      return isPlausibleEmail(email) ? { email } : NOTHING;
    }
    case "externalId":
      return { NOT: { id: clause.value }, scimExternalId: clause.value };
    case "id":
      return { id: clause.value };
  }
}

function groupClause(clause: ScimFilterClause<ScimGroupFilterAttribute>): Prisma.GroupWhereInput {
  switch (clause.attribute) {
    case "displayName": {
      const name = normalizeAdminGroupName(clause.value);
      return name ? { name } : NOTHING;
    }
    case "externalId":
      return { NOT: { id: clause.value }, scimExternalId: clause.value };
    case "id":
      return { id: clause.value };
    case "members.value":
      return { users: { some: { userId: clause.value } } };
  }
}

const groupSelect = {
  createdAt: true,
  id: true,
  name: true,
  scimExternalId: true,
  updatedAt: true
} satisfies Prisma.GroupSelect;

type GroupRow = Prisma.GroupGetPayload<{ select: typeof groupSelect }>;

async function withMembers(
  client: Pick<Prisma.TransactionClient, "userGroup">,
  groups: GroupRow[],
  members: boolean
): Promise<ScimGroupRecord[]> {
  if (!members || !groups.length) return groups.map((group) => ({ ...group, members: members ? [] : null }));
  const memberships = await client.userGroup.findMany({
    orderBy: [{ groupId: "asc" }, { userId: "asc" }],
    select: { groupId: true, user: { select: { displayName: true, id: true } } },
    where: { groupId: { in: groups.map((group) => group.id) } }
  });
  return groups.map((group) => ({
    ...group,
    members: memberships
      .filter((membership) => membership.groupId === group.id)
      .map((membership) => ({ displayName: membership.user.displayName, id: membership.user.id }))
  }));
}

function fallbackDisplayName(email: string): string {
  return email.split("@")[0]?.slice(0, 160) || "AIQSA User";
}

/** Whether another user (or, with `null`, any user) already carries the externalId. */
async function userExternalIdTaken(tx: Prisma.TransactionClient, externalId: string, userId: string | null) {
  const owner = await tx.user.findUnique({ select: { id: true }, where: { scimExternalId: externalId } });
  return owner !== null && owner.id !== userId;
}

type ActiveChange = { active: true } | { active: false; activeAdmins: readonly { id: string }[] };

/** The account status a SCIM write asks for, through the system-actor lifecycle commands. */
async function applyActiveChange(
  tx: Prisma.TransactionClient,
  change: ActiveChange | null,
  input: { now: Date; userId: string }
): Promise<ScimUserWriteResult> {
  if (change === null) return { kind: "ok", userId: input.userId };
  if (change.active) {
    const reactivated = await reactivateUserAsSystem(tx, { userId: input.userId });
    if (reactivated.kind !== "active") throw new ScimRefusal<ScimUserWriteResult>({ kind: reactivated.kind });
    return { kind: "ok", userId: input.userId };
  }
  const deactivated = await deactivateUserAsSystem(tx, {
    activeAdmins: change.activeAdmins,
    now: input.now,
    userId: input.userId
  });
  switch (deactivated.kind) {
    case "last_admin":
    case "not_found":
      throw new ScimRefusal<ScimUserWriteResult>({ kind: deactivated.kind });
    case "owner_transfer_required":
      return deactivated;
    default:
      return { kind: "ok", userId: input.userId };
  }
}

type UserChange = {
  active?: boolean;
  /** Undefined keeps the externalId; null falls back to the account's own id. */
  externalId?: string | null;
  profile(current: { displayName: string; email: string | null }): { displayName: string; email: string | null };
};

/**
 * Lock order of the account commands: the new email (advisory, like settlement and
 * registration), the active-admin set when the status may change, then the user row.
 */
async function updateUser(
  tx: Prisma.TransactionClient,
  id: string,
  change: UserChange,
  now: Date
): Promise<ScimUserWriteResult> {
  const before = await tx.user.findUnique({ select: { displayName: true, email: true }, where: { id } });
  if (!before) throw new ScimRefusal<ScimUserWriteResult>({ kind: "not_found" });
  const planned = change.profile(before);
  if (planned.email !== null && planned.email !== before.email) await lockAuthRegistrationEmail(tx, planned.email);
  const activeAdmins = change.active === undefined ? null : await lockActiveAdmins(tx);
  await lockAuthUser(tx, id);
  const user = await tx.user.findUnique({ where: { id } });
  if (!user) throw new ScimRefusal<ScimUserWriteResult>({ kind: "not_found" });
  const next = change.profile(user);
  if (next.email !== planned.email) throw new ScimWriteRetry();

  if (next.email !== null && next.email !== user.email &&
    await tx.user.findUnique({ select: { id: true }, where: { email: next.email } })) {
    throw new ScimRefusal<ScimUserWriteResult>({ kind: "uniqueness" });
  }
  const scimExternalId = change.externalId === undefined ? user.scimExternalId ?? user.id : change.externalId ?? user.id;
  if (scimExternalId !== user.scimExternalId && scimExternalId !== user.id &&
    await userExternalIdTaken(tx, scimExternalId, user.id)) {
    throw new ScimRefusal<ScimUserWriteResult>({ kind: "uniqueness" });
  }
  if (next.displayName !== user.displayName || next.email !== user.email || scimExternalId !== user.scimExternalId) {
    await tx.user.update({
      data: { displayName: next.displayName, email: next.email, scimExternalId },
      where: { id }
    });
  }

  return applyActiveChange(
    tx,
    change.active === undefined ? null : change.active ? { active: true } : { active: false, activeAdmins: activeAdmins ?? [] },
    { now, userId: id }
  );
}

type LockedGroup = {
  id: string;
  name: string;
  scimExternalId: string | null;
  systemRole: string | null;
};

/** Locks the group row and returns it while it is active. */
async function lockActiveGroup(tx: Prisma.TransactionClient, id: string): Promise<LockedGroup | null> {
  await tx.$queryRaw`SELECT "id" FROM "Group" WHERE "id" = ${id} FOR UPDATE`;
  return tx.group.findFirst({
    select: { id: true, name: true, scimExternalId: true, systemRole: true },
    where: { archivedAt: null, id }
  });
}

function groupUniqueness(detail: string): ScimRefusal<ScimGroupWriteResult> {
  return new ScimRefusal<ScimGroupWriteResult>({ detail, kind: "uniqueness" });
}

async function renameGroup(tx: Prisma.TransactionClient, group: LockedGroup, name: string): Promise<void> {
  if (name === group.name) return;
  if (group.systemRole === "full_access") throw invalidScimValue("The Full access group keeps its name.", "mutability");
  if (reservedFullAccessName(name) || await tx.group.findUnique({ select: { id: true }, where: { name } })) {
    throw groupUniqueness("A group with this name already exists.");
  }
  await tx.group.update({ data: { name }, where: { id: group.id } });
}

/** Undefined keeps the link (or links the group under its own id); null resets to its own id. */
async function linkGroup(tx: Prisma.TransactionClient, group: LockedGroup, externalId: string | null | undefined) {
  const next = externalId === undefined ? group.scimExternalId ?? group.id : externalId ?? group.id;
  if (next === group.scimExternalId) return;
  if (next !== group.id && await tx.group.findFirst({ select: { id: true }, where: { id: { not: group.id }, scimExternalId: next } })) {
    throw groupUniqueness("Another group has this externalId.");
  }
  await tx.group.update({ data: { scimExternalId: next }, where: { id: group.id } });
}

async function currentMembers(tx: Prisma.TransactionClient, groupId: string): Promise<Set<string>> {
  const memberships = await tx.userGroup.findMany({ select: { userId: true }, where: { groupId } });
  return new Set(memberships.map((membership) => membership.userId));
}

/**
 * Makes the group's members exactly `next` through the shared membership service, so every
 * change carries the administrator path's MCP side effects. At most `SCIM_MEMBER_CHANGES_MAX`
 * changes; every added member must be an existing user.
 */
async function setMembers(
  tx: Prisma.TransactionClient,
  groupId: string,
  current: ReadonlySet<string>,
  next: ReadonlySet<string>
): Promise<void> {
  const add = [...next].filter((userId) => !current.has(userId)).sort();
  const remove = [...current].filter((userId) => !next.has(userId)).sort();
  if (add.length + remove.length > SCIM_MEMBER_CHANGES_MAX) {
    throw invalidScimValue(`A request may change at most ${SCIM_MEMBER_CHANGES_MAX} members.`);
  }
  if (add.length && await tx.user.count({ where: { id: { in: add } } }) !== add.length) {
    throw invalidScimValue("One or more members are not users of this AIQSA installation.");
  }
  for (const userId of add) await applyMembershipChange(tx, { add: [groupId], remove: [], userId });
  for (const userId of remove) await applyMembershipChange(tx, { add: [], remove: [groupId], userId });
}

export function createPrismaScimRepository(prisma: PrismaClient): ScimRepository {
  const writeUser = (run: (tx: Prisma.TransactionClient) => Promise<ScimUserWriteResult>) =>
    attempt(() => prisma.$transaction(run, USER_TRANSACTION), { kind: "uniqueness" } as ScimUserWriteResult);
  const writeGroup = (run: (tx: Prisma.TransactionClient) => Promise<ScimGroupWriteResult>) =>
    attempt(
      () => prisma.$transaction(run, GROUP_TRANSACTION),
      { detail: "A group with this name or externalId already exists.", kind: "uniqueness" } as ScimGroupWriteResult
    );

  return {
    async listUsers(query) {
      const where: Prisma.UserWhereInput = { AND: query.clauses.map(userClause) };
      const [totalResults, rows] = await Promise.all([
        prisma.user.count({ where }),
        query.count > 0
          ? prisma.user.findMany({
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: userSelect,
              skip: query.startIndex - 1,
              take: query.count,
              where
            })
          : Promise.resolve([])
      ]).catch(retainDatabaseFailure);
      return { resources: rows.map(userRecord), totalResults };
    },

    async getUser(id) {
      const row = await prisma.user.findUnique({ select: userSelect, where: { id } }).catch(retainDatabaseFailure);
      return row ? userRecord(row) : null;
    },

    async createUser(input, now) {
      return writeUser(async (tx) => {
        await lockAuthRegistrationEmail(tx, input.email);
        const existing = await tx.user.findUnique({ select: { id: true }, where: { email: input.email } });

        if (!existing) {
          if (input.externalId !== undefined && await userExternalIdTaken(tx, input.externalId, null)) {
            throw new ScimRefusal<ScimUserWriteResult>({ kind: "uniqueness" });
          }
          const id = randomUUID();
          const active = input.active ?? true;
          await tx.user.create({
            data: {
              displayName: input.displayName ?? fallbackDisplayName(input.email),
              email: input.email,
              id,
              role: "user",
              scimDeactivatedAt: active ? null : now,
              scimExternalId: input.externalId ?? id,
              status: active ? "active" : "disabled"
            }
          });
          if (active) await provisionActiveUser(tx, { userId: id });
          return { kind: "ok", userId: id };
        }

        // An account with this email that SCIM does not manage yet is linked, not duplicated.
        const activeAdmins = await lockActiveAdmins(tx);
        await lockAuthUser(tx, existing.id);
        const user = await tx.user.findUnique({ where: { id: existing.id } });
        if (!user) throw new ScimWriteRetry();
        if (user.scimExternalId !== null ||
          (input.externalId !== undefined && await userExternalIdTaken(tx, input.externalId, user.id))) {
          throw new ScimRefusal<ScimUserWriteResult>({ kind: "uniqueness" });
        }
        await tx.user.update({
          data: { displayName: input.displayName ?? user.displayName, scimExternalId: input.externalId ?? user.id },
          where: { id: user.id }
        });
        return applyActiveChange(
          tx,
          input.active === false ? { active: false, activeAdmins } : { active: true },
          { now, userId: user.id }
        );
      });
    },

    async replaceUser(id, input, now) {
      return writeUser((tx) => updateUser(tx, id, {
        ...(input.active === undefined ? {} : { active: input.active }),
        ...(input.externalId === undefined ? {} : { externalId: input.externalId }),
        profile: (current) => ({ displayName: input.displayName ?? current.displayName, email: input.email })
      }, now));
    },

    async patchUser(id, patch, now) {
      return writeUser((tx) => updateUser(tx, id, {
        ...(patch.active === undefined ? {} : { active: patch.active }),
        ...(patch.externalId === undefined ? {} : { externalId: patch.externalId }),
        profile: (current) => resolveScimUserPatch(current, patch)
      }, now));
    },

    async deactivateUser(id, now) {
      return writeUser((tx) => updateUser(tx, id, { active: false, profile: (current) => current }, now));
    },

    async listGroups(query) {
      const where: Prisma.GroupWhereInput = { AND: [{ archivedAt: null }, ...query.clauses.map(groupClause)] };
      const [totalResults, rows] = await Promise.all([
        prisma.group.count({ where }),
        query.count > 0
          ? prisma.group.findMany({
              orderBy: [{ createdAt: "asc" }, { id: "asc" }],
              select: groupSelect,
              skip: query.startIndex - 1,
              take: query.count,
              where
            })
          : Promise.resolve([])
      ]).catch(retainDatabaseFailure);
      return { resources: await withMembers(prisma, rows, query.members).catch(retainDatabaseFailure), totalResults };
    },

    async getGroup(id, members) {
      const row = await prisma.group.findFirst({ select: groupSelect, where: { archivedAt: null, id } })
        .catch(retainDatabaseFailure);
      if (!row) return null;
      const [group] = await withMembers(prisma, [row], members).catch(retainDatabaseFailure);
      return group ?? null;
    },

    async createGroup(input) {
      return writeGroup(async (tx) => {
        const existing = await tx.group.findUnique({ select: { id: true }, where: { name: input.displayName } });
        let groupId: string;
        let current: ReadonlySet<string> = new Set();

        if (existing) {
          // Administrators pre-create groups with grants; the push links the same-named group.
          // An archived one is not resurrected.
          await tx.$queryRaw`SELECT "id" FROM "Group" WHERE "id" = ${existing.id} FOR UPDATE`;
          const group = await tx.group.findUnique({
            select: { archivedAt: true, id: true, name: true, scimExternalId: true, systemRole: true },
            where: { id: existing.id }
          });
          if (!group) throw new ScimWriteRetry();
          if (group.archivedAt) throw groupUniqueness("An archived group has this name.");
          if (group.scimExternalId !== null) throw groupUniqueness("A group with this name already exists.");
          await linkGroup(tx, group, input.externalId);
          groupId = group.id;
          current = await currentMembers(tx, groupId);
        } else {
          // The protected Full access group links only by its exact name.
          if (reservedFullAccessName(input.displayName)) throw groupUniqueness("A group with this name already exists.");
          if (input.externalId !== undefined &&
            await tx.group.findUnique({ select: { id: true }, where: { scimExternalId: input.externalId } })) {
            throw groupUniqueness("Another group has this externalId.");
          }
          groupId = randomUUID();
          await tx.group.create({ data: { id: groupId, name: input.displayName, scimExternalId: input.externalId ?? groupId } });
        }

        await setMembers(tx, groupId, current, new Set(input.members));
        return { groupId, kind: "ok" };
      });
    },

    async replaceGroup(id, input) {
      return writeGroup(async (tx) => {
        const group = await lockActiveGroup(tx, id);
        if (!group) throw new ScimRefusal<ScimGroupWriteResult>({ kind: "not_found" });
        await renameGroup(tx, group, input.displayName);
        await linkGroup(tx, group, input.externalId);
        await setMembers(tx, group.id, await currentMembers(tx, group.id), new Set(input.members));
        return { groupId: group.id, kind: "ok" };
      });
    },

    async patchGroup(id, patch) {
      return writeGroup(async (tx) => {
        const group = await lockActiveGroup(tx, id);
        if (!group) throw new ScimRefusal<ScimGroupWriteResult>({ kind: "not_found" });
        if (patch.displayName !== undefined) await renameGroup(tx, group, patch.displayName);
        await linkGroup(tx, group, patch.externalId);
        if (patch.members.length) {
          const current = await currentMembers(tx, group.id);
          await setMembers(tx, group.id, current, applyScimMemberOperations(current, patch.members));
        }
        return { groupId: group.id, kind: "ok" };
      });
    },

    async deleteGroup(id) {
      return writeGroup(async (tx) => {
        const group = await lockActiveGroup(tx, id);
        if (!group) throw new ScimRefusal<ScimGroupWriteResult>({ kind: "not_found" });
        if (group.systemRole !== "full_access") await archiveActiveGroup(tx, group.id);
        await tx.group.update({ data: { scimExternalId: null }, where: { id: group.id } });
        return { groupId: group.id, kind: "ok" };
      });
    }
  };
}
