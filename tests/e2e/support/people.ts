import { randomUUID } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "@playwright/test";
import { hashPassword, normalizeAuthEmail } from "../../../lib/server/auth/password";
import { provisionActiveUser } from "../../../lib/server/auth/provisioning";
import { deleteAssistantRows, deleteChatWorkspaces } from "./assistants";
import { loginWithPassword } from "./workspace";

/**
 * Synthetic users, administrators and groups for multi-user browser specs.
 * Users are provisioned the way the product provisions them (verified
 * password identity, settings row, the full-access group and any extra
 * memberships), so catalog-dependent features work for them. Memory (the
 * note, past-chat search and offers) starts off unless a scenario asks for it,
 * so answers neither read a note nor search past chats. Every name carries the
 * fixture's suffix; `cleanup` removes what the fixture created.
 */

export type E2EGroup = Readonly<{ id: string; name: string }>;

export type E2EGroupMembership = Readonly<{ group: E2EGroup; role?: "manager" | "member" }>;

export type E2EUser = Readonly<{
  displayName: string;
  email: string;
  id: string;
  password: string;
  role: "admin" | "user";
}>;

export type E2EUserOptions = Readonly<{
  /** Extra groups; the user is always a member of the full-access group. */
  groups?: readonly (E2EGroup | E2EGroupMembership)[];
  /**
   * The Memory switches as a new account has them (the note, past-chat
   * search, offers). Off by default.
   */
  memory?: boolean;
}>;

export type E2ESession = Readonly<{ context: BrowserContext; page: Page; user: E2EUser }>;

export type PeopleFixture = Readonly<{
  /** An active user with the administrator role. */
  admin(label: string, options?: E2EUserOptions): Promise<E2EUser>;
  /**
   * Closes the fixture's browser contexts, waits until no run of the users
   * is still preparing or answering (a settling run still writes to its
   * chat), then removes in one transaction: the users' personal chats
   * (Temporary ones included), the Assistants they
   * own with their listing requests, publications and Skill links, Assistant
   * and Skill publications to the fixture's groups, the Skills they own,
   * memberships, the users and the groups. Run the Assistant fixture's
   * cleanup before this one. Idempotent.
   */
  cleanup(): Promise<void>;
  group(label: string): Promise<E2EGroup>;
  /** Signs in with the password form in a new browser context the fixture closes on cleanup. */
  signIn(browser: Browser, user: E2EUser, options?: BrowserContextOptions): Promise<E2ESession>;
  suffix: string;
  user(label: string, options?: E2EUserOptions): Promise<E2EUser>;
}>;

/** A short random suffix that keeps names unique within one stand. */
export function e2eSuffix(): string {
  return randomUUID().slice(0, 8);
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "user";
}

function membership(entry: E2EGroup | E2EGroupMembership): { groupId: string; role: string } {
  return "group" in entry
    ? { groupId: entry.group.id, role: entry.role ?? "member" }
    : { groupId: entry.id, role: "member" };
}

export function createPeopleFixture(
  prisma: PrismaClient,
  options: Readonly<{ suffix?: string }> = {}
): PeopleFixture {
  const suffix = options.suffix ?? e2eSuffix();
  const userIds: string[] = [];
  const groupIds: string[] = [];
  const contexts: BrowserContext[] = [];

  async function createUser(label: string, role: E2EUser["role"], userOptions: E2EUserOptions = {}): Promise<E2EUser> {
    const id = randomUUID();
    const email = normalizeAuthEmail(`e2e-${slug(label)}-${suffix}-${id.slice(0, 8)}@example.test`);
    const user: E2EUser = {
      displayName: `${label} ${suffix}`,
      email,
      id,
      password: `Synthetic-${randomUUID()}`,
      role
    };
    const passwordHash = await hashPassword(user.password);
    const fullAccess = await prisma.group.findUniqueOrThrow({
      select: { id: true },
      where: { systemRole: "full_access" }
    });
    userIds.push(id);
    await prisma.$transaction(async (tx) => {
      await tx.user.create({
        data: {
          authIdentities: {
            create: {
              emailVerifiedAt: new Date(),
              normalizedEmail: email,
              passwordHash,
              provider: "password",
              providerAccountId: email
            }
          },
          displayName: user.displayName,
          email,
          id,
          role,
          status: "active"
        }
      });
      await provisionActiveUser(tx, {
        groups: [
          { groupId: fullAccess.id, role: "member" },
          ...(userOptions.groups ?? []).map(membership)
        ],
        userId: id
      });
      const memory = userOptions.memory ?? false;
      await tx.userSettings.update({
        data: { memoryEnabled: memory, memorySuggestionsEnabled: memory, pastChatSearchEnabled: memory },
        where: { userId: id }
      });
    });
    return user;
  }

  return {
    admin: (label, userOptions) => createUser(label, "admin", userOptions),
    async cleanup() {
      const openContexts = contexts.splice(0);
      await Promise.all(openContexts.map((context) => context.close().catch(() => undefined)));
      const users = userIds.splice(0);
      const groups = groupIds.splice(0);
      if (users.length === 0 && groups.length === 0) return;
      await waitForSettledRuns(prisma, users);
      await prisma.$transaction(async (tx) => {
        // Chats first: their runs hold the Skill revisions they used.
        await deleteUserChats(tx, users);
        const assistants = await tx.assistantDefinition.findMany({
          select: { id: true },
          where: { ownerUserId: { in: users } }
        });
        await deleteAssistantRows(tx, assistants.map((assistant) => assistant.id));
        // Publications to the fixture's groups exist only because of them.
        await tx.assistantPublication.deleteMany({ where: { groupId: { in: groups } } });
        await deleteOwnedSkills(tx, users, groups);
        await tx.userGroup.deleteMany({ where: { OR: [{ userId: { in: users } }, { groupId: { in: groups } }] } });
        // A session one fixture administrator revoked restricts deleting that administrator.
        await tx.authSession.deleteMany({ where: { userId: { in: users } } });
        await tx.user.deleteMany({ where: { id: { in: users } } });
        await tx.group.deleteMany({ where: { id: { in: groups } } });
      }, { timeout: 30_000 });
    },
    async group(label) {
      const group: E2EGroup = { id: randomUUID(), name: `${label} ${suffix}` };
      groupIds.push(group.id);
      await prisma.group.create({ data: { id: group.id, name: group.name } });
      return group;
    },
    async signIn(browser, user, contextOptions = {}) {
      const context = await browser.newContext({ locale: "en-US", reducedMotion: "reduce", ...contextOptions });
      contexts.push(context);
      const page = await context.newPage();
      await loginWithPassword(page, user);
      return { context, page, user };
    },
    suffix,
    user: (label, userOptions) => createUser(label, "user", userOptions)
  };
}

/**
 * Every personal chat of the given users, Temporary chats included (Save &
 * try opens one). The database lets a Temporary chat go only once its
 * retention deadline has passed, so its deadline is moved into the past first
 * (and its creation before that, as the deadline must follow it).
 */
async function deleteUserChats(tx: Prisma.TransactionClient, userIds: readonly string[]): Promise<void> {
  const users = [...userIds];
  await tx.chat.updateMany({
    data: { createdAt: new Date(Date.now() - 2 * 86_400_000), temporaryRetentionDeadline: new Date(Date.now() - 60_000) },
    where: { memoryMode: "TEMPORARY", userId: { in: users } }
  });
  await deleteChatWorkspaces(tx, { userId: { in: users } });
  await tx.chat.deleteMany({ where: { userId: { in: users } } });
}

/** The Skills of the given users, in the order their restrictive keys require. */
async function deleteOwnedSkills(
  tx: Prisma.TransactionClient,
  userIds: readonly string[],
  groupIds: readonly string[]
): Promise<void> {
  const where = { ownerUserId: { in: [...userIds] } };
  const skillIds = (await tx.skillDefinition.findMany({ select: { id: true }, where })).map((skill) => skill.id);
  await tx.skillPublication.deleteMany({
    where: { OR: [{ skillId: { in: skillIds } }, { groupId: { in: [...groupIds] } }] }
  });
  if (skillIds.length === 0) return;
  await tx.skillShareRequest.deleteMany({ where: { skillId: { in: skillIds } } });
  await tx.skillDefinition.updateMany({ data: { currentRevisionId: null, sharedRevisionId: null }, where });
  await tx.skillRevisionFile.deleteMany({ where: { skillId: { in: skillIds } } });
  await tx.skillRevision.deleteMany({ where: { skillId: { in: skillIds } } });
  await tx.skillDefinition.deleteMany({ where });
}

const UNSETTLED_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"] as const;
const RUN_SETTLE_TIMEOUT_MS = 60_000;

/**
 * A run writes to its chat when it ends, so cleanup starts only once no run
 * of the users is still preparing or answering. Waiting is
 * bounded; a run that never settles is a finding, not something to retry.
 */
async function waitForSettledRuns(prisma: PrismaClient, userIds: readonly string[]): Promise<void> {
  const deadline = Date.now() + RUN_SETTLE_TIMEOUT_MS;
  for (;;) {
    const unsettled = await prisma.modelRun.count({
      where: { status: { in: [...UNSETTLED_RUN_STATUSES] }, userId: { in: [...userIds] } }
    });
    if (unsettled === 0) return;
    if (Date.now() > deadline) throw new Error(`e2e_cleanup_runs_not_settled: ${unsettled}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
