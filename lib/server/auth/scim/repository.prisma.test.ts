// @vitest-environment node
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import {
  createInboundMcpTestClient,
  INBOUND_MCP_TEST_AUTHORITIES,
  liveInboundMcpFamilyCount
} from "@/tests/support/inboundMcpOAuth";
import { prisma } from "../../prisma";
import { createPrismaProjectRepository } from "../../projects/prismaRepository";
import { createPrismaAdminRepository } from "../adminRepository";
import { deactivateUserAsSystem } from "../adminUserSessionCommands";
import { externalIdentityPolicy, settleExternalIdentity, type ExternalIdentityInput } from "../externalIdentity";
import { issueSignInSession } from "../signInCompletion";
import { hashToken } from "../token";
import { authentik, entra, okta } from "./clients.testFixtures";
import { ScimRequestError } from "./protocol";
import { createPrismaScimRepository, type ScimGroupWriteResult, type ScimUserWriteResult } from "./repository";
import { parseScimGroupBody, parseScimGroupPatch, parseScimUserBody, parseScimUserPatch } from "./requests";

const now = new Date("2026-10-08T12:00:00.000Z");
const scim = createPrismaScimRepository(prisma);
const admins = createPrismaAdminRepository(prisma);
const projects = createPrismaProjectRepository(prisma);

type Fixture = {
  adminId: string;
  email(localPart: string): string;
  externalId(name: string): string;
  /** A group named for this run, optionally with members. */
  group(label: string, members?: string[]): Promise<{ id: string; name: string }>;
  groupName(label: string): string;
  /** An installation MCP server granted to one group, with a ready runtime revision. */
  mcpServer(label: string, grantedGroupId: string): Promise<{ revisionId: string; serverId: string }>;
  /** The user's enabled preference for a server, with a desired runtime generation. */
  mcpPreference(server: { revisionId: string; serverId: string }, userId: string): Promise<void>;
  /** A Project the user creates and so owns alone. */
  ownedProject(ownerId: string, label: string): Promise<string>;
  user(localPart: string, input?: { role?: "admin" | "user"; scimExternalId?: string | null; status?: "active" | "disabled" | "pending" }): Promise<string>;
};

async function withScimData<T>(run: (fixture: Fixture) => Promise<T>): Promise<T> {
  const id = randomUUID();
  const domain = `scim-${id}.example.com`;
  const groupIds: string[] = [];
  const projectIds: string[] = [];
  const serverIds: string[] = [];
  const email = (localPart: string) => `${localPart}@${domain}`;
  const admin = await prisma.user.create({
    data: { displayName: "SCIM Test Admin", email: email("operator"), role: "admin", status: "active" }
  });

  try {
    return await run({
      adminId: admin.id,
      email,
      externalId: (name) => `${name}-${id}`,
      async group(label, members = []) {
        const group = await prisma.group.create({
          data: { name: `${label} ${id}`, users: { create: members.map((userId) => ({ userId })) } }
        });
        groupIds.push(group.id);
        return { id: group.id, name: group.name };
      },
      groupName: (label) => `${label} ${id}`,
      async mcpPreference(server, userId) {
        const preference = await prisma.mcpUserServer.create({ data: { enabled: true, serverId: server.serverId, userId } });
        const generation = await prisma.mcpRuntimeGeneration.create({
          data: { fingerprint: randomUUID(), revisionId: server.revisionId, state: "ready", userServerId: preference.id }
        });
        await prisma.mcpUserServer.update({ data: { desiredRuntimeGenerationId: generation.id }, where: { id: preference.id } });
      },
      async mcpServer(label, grantedGroupId) {
        const server = await prisma.mcpServer.create({
          data: { displayName: `SCIM ${label}`, enabled: true, namespace: `scim_${label}_${id.replaceAll("-", "")}` }
        });
        serverIds.push(server.id);
        const revision = await prisma.mcpRevision.create({
          data: {
            configuration: {},
            draftHash: "a".repeat(64),
            identityHash: `scim-${label}`,
            revisionNumber: 1,
            serverId: server.id,
            validationEvidence: {}
          }
        });
        await prisma.mcpGrant.create({ data: { canUse: true, groupId: grantedGroupId, serverId: server.id } });
        return { revisionId: revision.id, serverId: server.id };
      },
      async ownedProject(ownerId, label) {
        const created = await projects.create({
          actorDisplayName: "SCIM Project Owner",
          description: "SCIM deactivation fixture",
          name: `${label} ${id}`,
          userId: ownerId
        });
        if (created.kind !== "ok") throw new Error(`project_fixture_${created.kind}`);
        projectIds.push(created.value.id);
        return created.value.id;
      },
      async user(localPart, input = {}) {
        const user = await prisma.user.create({
          data: {
            displayName: `SCIM ${localPart}`,
            email: email(localPart),
            role: input.role ?? "user",
            scimExternalId: input.scimExternalId === undefined ? null : input.scimExternalId,
            status: input.status ?? "active"
          }
        });
        return user.id;
      }
    });
  } finally {
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.mcpRuntimeGeneration.deleteMany({ where: { revision: { serverId: { in: serverIds } } } });
    await prisma.mcpRevision.deleteMany({ where: { serverId: { in: serverIds } } });
    await prisma.mcpServer.deleteMany({ where: { id: { in: serverIds } } });
    await prisma.authSession.deleteMany({ where: { user: { email: { endsWith: `@${domain}` } } } });
    await prisma.user.deleteMany({ where: { email: { endsWith: `@${domain}` } } });
    await prisma.group.deleteMany({ where: { OR: [{ id: { in: groupIds } }, { name: { contains: id } }] } });
  }
}

class RolledBack extends Error {
  constructor(readonly value: unknown) {
    super("rolled_back");
  }
}

/** Runs in a transaction that always rolls back, so changes to shared rows never persist. */
async function rolledBack<T>(run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    await prisma.$transaction(async (tx) => {
      throw new RolledBack(await run(tx));
    });
  } catch (error) {
    if (error instanceof RolledBack) return error.value as T;
    throw error;
  }
  throw new Error("rolled_back_transaction_committed");
}

function startBarrier(parties: number) {
  let waiting = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    waiting += 1;
    if (waiting === parties) release();
    await released;
  };
}

function userId(result: ScimUserWriteResult): string {
  if (result.kind !== "ok") throw new Error(`scim_user_${result.kind}`);
  return result.userId;
}

function groupId(result: ScimGroupWriteResult): string {
  if (result.kind !== "ok") throw new Error(`scim_group_${result.kind}`);
  return result.groupId;
}

async function session(userId: string): Promise<string> {
  const tokenHash = hashToken(randomUUID());
  await prisma.authSession.create({ data: { expiresAt: new Date("2099-01-01T00:00:00.000Z"), tokenHash, userId } });
  return tokenHash;
}

function account(id: string) {
  return prisma.user.findUniqueOrThrow({
    select: { displayName: true, email: true, scimDeactivatedAt: true, scimExternalId: true, status: true },
    where: { id }
  });
}

async function members(groupIdValue: string): Promise<string[]> {
  return (await prisma.userGroup.findMany({ select: { userId: true }, where: { groupId: groupIdValue } }))
    .map((membership) => membership.userId)
    .sort();
}

async function setProjectOwner(projectId: string, actorId: string, targetId: string) {
  const project = await prisma.project.findUniqueOrThrow({ select: { accessRevision: true }, where: { id: projectId } });
  const granted = await projects.addGrant({
    actorDisplayName: "SCIM Project Owner",
    expectedAccessRevision: project.accessRevision,
    projectId,
    role: "OWNER",
    targetUserId: targetId,
    userId: actorId
  });
  if (granted.kind !== "ok") throw new Error(`project_grant_${granted.kind}`);
}

describe("SCIM repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("creates users from Entra ID, Okta and Authentik requests with the provisioning defaults", async () => {
    await withScimData(async (fixture) => {
      const ada = userId(await scim.createUser(parseScimUserBody({
        ...entra.createUser,
        emails: [{ primary: true, type: "work", value: fixture.email("ada") }],
        externalId: fixture.externalId("entra-ada"),
        userName: fixture.email("Ada")
      }), now));
      const grace = userId(await scim.createUser(parseScimUserBody({
        ...okta.createUser,
        emails: [{ primary: true, type: "work", value: fixture.email("grace") }],
        externalId: fixture.externalId("okta-grace"),
        userName: fixture.email("grace")
      }), now));
      const katherine = userId(await scim.createUser(parseScimUserBody({
        ...authentik.createUser,
        emails: [{ primary: true, type: "other", value: fixture.email("katherine") }],
        externalId: fixture.externalId("authentik-katherine")
      }), now));
      const unkeyed = userId(await scim.createUser(parseScimUserBody({ active: false, userName: fixture.email("unkeyed") }), now));

      await expect(account(ada)).resolves.toEqual({
        displayName: "Ada Lovelace",
        email: fixture.email("ada"),
        scimDeactivatedAt: null,
        scimExternalId: fixture.externalId("entra-ada"),
        status: "active"
      });
      await expect(prisma.userSettings.count({ where: { userId: { in: [ada, grace, katherine] } } })).resolves.toBe(3);
      await expect(account(katherine)).resolves.toMatchObject({ email: fixture.email("katherine"), status: "active" });
      // Without an externalId the account is SCIM-managed under its own id, and SCIM may
      // re-enable it because SCIM disabled it.
      await expect(account(unkeyed)).resolves.toMatchObject({ scimDeactivatedAt: now, scimExternalId: unkeyed, status: "disabled" });
      await expect(scim.getUser(grace)).resolves.toMatchObject({ email: fixture.email("grace"), groups: [], status: "active" });
    });
  });

  it("links an account with the same email instead of duplicating it, and refuses conflicts", async () => {
    await withScimData(async (fixture) => {
      const existing = await fixture.user("existing", { status: "pending" });
      const linked = await scim.createUser(parseScimUserBody({
        externalId: fixture.externalId("existing"),
        name: { familyName: "Person", givenName: "Existing" },
        userName: fixture.email("existing")
      }), now);

      expect(linked).toEqual({ kind: "ok", userId: existing });
      // The SCIM client is an admin-level integration: its POST approves a pending account.
      await expect(account(existing)).resolves.toMatchObject({
        displayName: "Existing Person",
        scimExternalId: fixture.externalId("existing"),
        status: "active"
      });
      await expect(scim.createUser(parseScimUserBody({ externalId: fixture.externalId("other"), userName: fixture.email("existing") }), now))
        .resolves.toEqual({ kind: "uniqueness" });
      await expect(scim.createUser(parseScimUserBody({ externalId: fixture.externalId("existing"), userName: fixture.email("fresh") }), now))
        .resolves.toEqual({ kind: "uniqueness" });
      await expect(prisma.user.count({ where: { email: fixture.email("fresh") } })).resolves.toBe(0);
    });
  });

  it("filters and pages users by userName, emails and externalId", async () => {
    await withScimData(async (fixture) => {
      const ada = userId(await scim.createUser(parseScimUserBody({ externalId: fixture.externalId("ada"), userName: fixture.email("ada") }), now));
      const keyedById = userId(await scim.createUser(parseScimUserBody({ userName: fixture.email("keyed") }), now));
      const page = { count: 100, startIndex: 1 };

      await expect(scim.listUsers({ ...page, clauses: [{ attribute: "userName", value: fixture.email("ADA") }] }))
        .resolves.toMatchObject({ resources: [{ id: ada }], totalResults: 1 });
      await expect(scim.listUsers({ ...page, clauses: [{ attribute: "emails.value", value: fixture.email("ada") }] }))
        .resolves.toMatchObject({ totalResults: 1 });
      await expect(scim.listUsers({ ...page, clauses: [{ attribute: "externalId", value: fixture.externalId("ada") }] }))
        .resolves.toMatchObject({ resources: [{ id: ada }], totalResults: 1 });
      // An account keyed by its own id has no externalId to find.
      await expect(scim.listUsers({ ...page, clauses: [{ attribute: "externalId", value: keyedById }] }))
        .resolves.toEqual({ resources: [], totalResults: 0 });
      await expect(scim.listUsers({ ...page, clauses: [{ attribute: "userName", value: "kjohnson" }] }))
        .resolves.toEqual({ resources: [], totalResults: 0 });
      await expect(scim.listUsers({ clauses: [{ attribute: "id", value: ada }], count: 0, startIndex: 1 }))
        .resolves.toEqual({ resources: [], totalResults: 1 });
      await expect(scim.listUsers({ clauses: [{ attribute: "id", value: ada }], count: 10, startIndex: 2 }))
        .resolves.toEqual({ resources: [], totalResults: 1 });
    });
  });

  it("updates profiles with PATCH and PUT and refuses a taken email or externalId", async () => {
    await withScimData(async (fixture) => {
      const ada = userId(await scim.createUser(parseScimUserBody({ externalId: fixture.externalId("ada"), userName: fixture.email("ada") }), now));
      const bob = userId(await scim.createUser(parseScimUserBody({ externalId: fixture.externalId("bob"), userName: fixture.email("bob") }), now));

      await expect(scim.patchUser(ada, parseScimUserPatch({
        ...entra.replaceUserName,
        Operations: [{ op: "Replace", path: "userName", value: fixture.email("ada.king") }]
      }), now)).resolves.toEqual({ kind: "ok", userId: ada });
      await expect(scim.patchUser(ada, parseScimUserPatch({
        Operations: [
          { op: "replace", path: "name.givenName", value: "Augusta" },
          { op: "replace", path: "name.familyName", value: "King" }
        ]
      }), now)).resolves.toMatchObject({ kind: "ok" });
      await expect(account(ada)).resolves.toMatchObject({ displayName: "Augusta King", email: fixture.email("ada.king") });

      await expect(scim.patchUser(ada, parseScimUserPatch({
        Operations: [{ op: "replace", path: "userName", value: fixture.email("bob") }]
      }), now)).resolves.toEqual({ kind: "uniqueness" });
      await expect(scim.replaceUser(ada, parseScimUserBody({
        externalId: fixture.externalId("bob"),
        userName: fixture.email("ada.king")
      }), now)).resolves.toEqual({ kind: "uniqueness" });
      await expect(account(ada)).resolves.toMatchObject({ email: fixture.email("ada.king"), scimExternalId: fixture.externalId("ada") });
      await expect(account(bob)).resolves.toMatchObject({ email: fixture.email("bob") });
      await expect(scim.patchUser(randomUUID(), parseScimUserPatch(entra.disableUser), now)).resolves.toEqual({ kind: "not_found" });
    });
  });

  it("revokes sessions and connected-app grants at once when SCIM deactivates a user", async () => {
    await withScimData(async (fixture) => {
      const mcp = await createInboundMcpTestClient(prisma, new Date());
      try {
        const leaver = userId(await scim.createUser(parseScimUserBody({ externalId: fixture.externalId("leaver"), userName: fixture.email("leaver") }), now));
        const tokenHash = await session(leaver);
        const connections = [
          await mcp.connect(leaver, INBOUND_MCP_TEST_AUTHORITIES.memory),
          await mcp.connect(leaver, INBOUND_MCP_TEST_AUTHORITIES.hub)
        ];

        await expect(scim.patchUser(leaver, parseScimUserPatch(entra.disableUserLegacy), now)).resolves.toEqual({ kind: "ok", userId: leaver });

        await expect(account(leaver)).resolves.toMatchObject({ scimDeactivatedAt: now, status: "disabled" });
        await expect(prisma.authSession.findUniqueOrThrow({
          select: { revokedAt: true, revokedByUserId: true, revokedReason: true },
          where: { tokenHash }
        })).resolves.toEqual({ revokedAt: expect.any(Date), revokedByUserId: null, revokedReason: "scim_deactivated" });
        for (const connection of connections) {
          await expect(mcp.access(connection)).resolves.toBe(false);
        }
        await expect(liveInboundMcpFamilyCount(prisma, leaver)).resolves.toBe(0);
        // DELETE never erases: it deactivates, and an inactive account stays as it is.
        await expect(scim.deactivateUser(leaver, new Date(now.getTime() + 1_000))).resolves.toEqual({ kind: "ok", userId: leaver });
        await expect(account(leaver)).resolves.toMatchObject({ scimDeactivatedAt: now, status: "disabled" });
      } finally {
        await mcp.cleanup();
      }
    });
  });

  it("keeps a sole Project Owner active with access revoked until ownership moves, then disables on retry", async () => {
    await withScimData(async (fixture) => {
      const owner = userId(await scim.createUser(parseScimUserBody({ externalId: fixture.externalId("owner"), userName: fixture.email("owner") }), now));
      const successor = await fixture.user("successor");
      const projectId = await fixture.ownedProject(owner, "Sole owner");
      const tokenHash = await session(owner);
      const signInSession = { expiresAt: new Date("2099-01-01T00:00:00.000Z"), tokenHash: hashToken(randomUUID()) };

      await expect(scim.deactivateUser(owner, now)).resolves.toEqual({ kind: "owner_transfer_required", projectCount: 1 });
      await expect(account(owner)).resolves.toMatchObject({ scimDeactivatedAt: now, status: "active" });
      await expect(prisma.authSession.findUniqueOrThrow({ select: { revokedReason: true }, where: { tokenHash } }))
        .resolves.toEqual({ revokedReason: "scim_deactivated" });
      // Every sign-in but the break-glass bootstrap token is refused while the deactivation waits.
      await expect(rolledBack((tx) => issueSignInSession(tx, { session: signInSession, signInMethod: "password", userId: owner })))
        .resolves.toEqual({ kind: "refused" });
      await expect(rolledBack((tx) => issueSignInSession(tx, { session: signInSession, signInMethod: "oidc", userId: owner })))
        .resolves.toEqual({ kind: "refused" });
      await expect(rolledBack(async (tx) => (await issueSignInSession(tx, { session: signInSession, signInMethod: "bootstrap", userId: owner })).kind))
        .resolves.toBe("session");
      await expect(rolledBack((tx) => settleExternalIdentity(tx, {
        displayName: "Owner",
        email: fixture.email("owner"),
        emailVerified: true,
        groups: [],
        now,
        policy: externalIdentityPolicy({ adminGroups: [], allowedGroups: [], autoCreateUsers: true, syncGroups: false }),
        provider: "oidc",
        source: "https://idp.example.test/realms/scim",
        subject: `owner-${randomUUID()}`
      }))).resolves.toEqual({ status: "not_allowed" });
      const dashboard = await admins.listDashboard(fixture.adminId);
      expect(dashboard.users.find((entry) => entry.id === owner)?.scimDeactivationPending).toEqual({ projectCount: 1 });

      await setProjectOwner(projectId, owner, successor);
      const dashboardAfterTransfer = await admins.listDashboard(fixture.adminId);
      expect(dashboardAfterTransfer.users.find((entry) => entry.id === owner)?.scimDeactivationPending).toEqual({ projectCount: 0 });

      await expect(scim.deactivateUser(owner, new Date(now.getTime() + 60_000))).resolves.toEqual({ kind: "ok", userId: owner });
      await expect(account(owner)).resolves.toMatchObject({ scimDeactivatedAt: now, status: "disabled" });
      await expect(prisma.projectGrant.count({
        where: { groupId: null, projectId, role: "OWNER", user: { status: "active" } }
      })).resolves.toBe(1);
    });
  });

  it("never deactivates the last administrator who can still sign in", async () => {
    await withScimData(async (fixture) => {
      const target = await fixture.user("admin-target", { role: "admin", scimExternalId: fixture.externalId("admin-target") });
      const pendingAdmin = await fixture.user("admin-pending", { role: "admin" });
      await prisma.user.update({ data: { scimDeactivatedAt: now }, where: { id: pendingAdmin } });
      const usableAdmin = await fixture.user("admin-usable", { role: "admin" });

      // The caller locked these as the active-admin set; an admin whose own deactivation waits
      // cannot sign in and does not count.
      await expect(rolledBack((tx) => deactivateUserAsSystem(tx, {
        activeAdmins: [{ id: target }, { id: pendingAdmin }],
        now,
        userId: target
      }))).resolves.toEqual({ kind: "last_admin" });
      await expect(rolledBack(async (tx) => ({
        result: await deactivateUserAsSystem(tx, { activeAdmins: [{ id: target }, { id: usableAdmin }], now, userId: target }),
        status: (await tx.user.findUniqueOrThrow({ select: { status: true }, where: { id: target } })).status
      }))).resolves.toEqual({ result: { kind: "disabled" }, status: "disabled" });
      await expect(account(target)).resolves.toMatchObject({ scimDeactivatedAt: null, status: "active" });
    });
  });

  it("re-enables only accounts SCIM disabled", async () => {
    await withScimData(async (fixture) => {
      const scimDisabled = userId(await scim.createUser(parseScimUserBody({ externalId: fixture.externalId("returning"), userName: fixture.email("returning") }), now));
      await scim.deactivateUser(scimDisabled, now);
      await expect(scim.patchUser(scimDisabled, parseScimUserPatch(okta.deactivateUser), now)).resolves.toMatchObject({ kind: "ok" });
      await expect(scim.patchUser(scimDisabled, parseScimUserPatch({ Operations: [{ op: "replace", value: { active: true } }] }), now))
        .resolves.toEqual({ kind: "ok", userId: scimDisabled });
      await expect(account(scimDisabled)).resolves.toMatchObject({ scimDeactivatedAt: null, status: "active" });

      const adminDisabled = await fixture.user("admin-disabled", { scimExternalId: fixture.externalId("admin-disabled") });
      await expect(admins.disableUser({ revokedByUserId: fixture.adminId, userId: adminDisabled })).resolves.toBe("disabled");
      await expect(scim.patchUser(adminDisabled, parseScimUserPatch({
        Operations: [
          { op: "replace", path: "displayName", value: "Renamed while refused" },
          { op: "replace", path: "active", value: true }
        ]
      }), now)).resolves.toEqual({ kind: "admin_disabled" });
      await expect(account(adminDisabled)).resolves.toMatchObject({ displayName: "SCIM admin-disabled", status: "disabled" });

      // An administrator's disable that completes a waiting SCIM deactivation is still the
      // administrator's: SCIM cannot undo it.
      const owner = userId(await scim.createUser(parseScimUserBody({ externalId: fixture.externalId("pending"), userName: fixture.email("pending") }), now));
      const successor = await fixture.user("pending-successor");
      const projectId = await fixture.ownedProject(owner, "Pending owner");
      await expect(scim.deactivateUser(owner, now)).resolves.toMatchObject({ kind: "owner_transfer_required" });
      await expect(scim.patchUser(owner, parseScimUserPatch({ Operations: [{ op: "replace", path: "active", value: "True" }] }), now))
        .resolves.toMatchObject({ kind: "ok" });
      await expect(account(owner)).resolves.toMatchObject({ scimDeactivatedAt: null, status: "active" });
      await expect(scim.deactivateUser(owner, now)).resolves.toMatchObject({ kind: "owner_transfer_required" });
      await setProjectOwner(projectId, owner, successor);
      await expect(admins.disableUser({ revokedByUserId: fixture.adminId, userId: owner })).resolves.toBe("disabled");
      await expect(account(owner)).resolves.toMatchObject({ scimDeactivatedAt: null, status: "disabled" });
      await expect(scim.patchUser(owner, parseScimUserPatch(entra.updateUserLegacyNoPath), now)).resolves.toEqual({ kind: "admin_disabled" });
    });
  });
});

describe("SCIM groups", () => {
  it("creates groups, links a same-named group keeping its grants, and runs the membership side effects", async () => {
    await withScimData(async (fixture) => {
      const kept = await fixture.user("kept");
      const manual = await fixture.user("manual");
      const pushed = await fixture.user("pushed");
      const precreated = await fixture.group("Engineering", [manual, kept]);
      const server = await fixture.mcpServer("engineering", precreated.id);
      for (const id of [kept, manual, pushed]) await fixture.mcpPreference(server, id);

      await expect(scim.createGroup(parseScimGroupBody({
        ...entra.createGroup,
        displayName: precreated.name,
        externalId: fixture.externalId("engineering"),
        members: [{ value: kept }, { value: pushed }]
      }))).resolves.toEqual({ groupId: precreated.id, kind: "ok" });

      await expect(prisma.group.findUniqueOrThrow({ select: { scimExternalId: true }, where: { id: precreated.id } }))
        .resolves.toEqual({ scimExternalId: fixture.externalId("engineering") });
      await expect(prisma.mcpGrant.count({ where: { groupId: precreated.id, serverId: server.serverId } })).resolves.toBe(1);
      await expect(members(precreated.id)).resolves.toEqual([kept, pushed].sort());
      const preferences = await prisma.mcpUserServer.findMany({
        select: { desiredRuntimeGenerationId: true, enabled: true, userId: true },
        where: { serverId: server.serverId }
      });
      expect(preferences.find((entry) => entry.userId === manual)).toEqual({ desiredRuntimeGenerationId: null, enabled: false, userId: manual });
      expect(preferences.find((entry) => entry.userId === pushed)).toEqual({ desiredRuntimeGenerationId: null, enabled: true, userId: pushed });

      await expect(scim.createGroup(parseScimGroupBody({ displayName: precreated.name }))).resolves.toMatchObject({ kind: "uniqueness" });
      const oktaGroup = groupId(await scim.createGroup(parseScimGroupBody({
        ...okta.createGroup,
        displayName: fixture.groupName("Compilers"),
        members: [{ value: pushed }]
      })));
      await expect(prisma.group.findUniqueOrThrow({ select: { scimExternalId: true }, where: { id: oktaGroup } }))
        .resolves.toEqual({ scimExternalId: oktaGroup });
      await expect(scim.listGroups({
        clauses: [{ attribute: "displayName", value: fixture.groupName("Compilers") }],
        count: 100,
        members: true,
        startIndex: 1
      })).resolves.toMatchObject({ resources: [{ id: oktaGroup, members: [{ id: pushed }] }], totalResults: 1 });
      await expect(scim.listGroups({ clauses: [{ attribute: "members.value", value: kept }], count: 100, members: false, startIndex: 1 }))
        .resolves.toMatchObject({ resources: [{ id: precreated.id, members: null }], totalResults: 1 });
      await expect(scim.createGroup(parseScimGroupBody({ displayName: "full ACCESS" }))).resolves.toMatchObject({ kind: "uniqueness" });
    });
  });

  it("patches members in every client's form and refuses manual edits of the memberships it manages", async () => {
    await withScimData(async (fixture) => {
      const first = await fixture.user("first");
      const second = await fixture.user("second");
      const group = groupId(await scim.createGroup(parseScimGroupBody({ displayName: fixture.groupName("Mission control") })));
      const server = await fixture.mcpServer("mission", group);
      for (const id of [first, second]) await fixture.mcpPreference(server, id);

      await expect(scim.patchGroup(group, parseScimGroupPatch({
        ...entra.addMembers,
        Operations: [{ op: "Add", path: "members", value: [{ $ref: null, value: first }, { $ref: null, value: second }] }]
      }))).resolves.toEqual({ groupId: group, kind: "ok" });
      await expect(members(group)).resolves.toEqual([first, second].sort());

      await expect(scim.patchGroup(group, parseScimGroupPatch({
        ...okta.removeMember,
        Operations: [{ op: "remove", path: `members[value eq "${first}"]` }]
      }))).resolves.toMatchObject({ kind: "ok" });
      await expect(members(group)).resolves.toEqual([second]);
      await expect(prisma.mcpUserServer.findFirstOrThrow({ select: { enabled: true }, where: { serverId: server.serverId, userId: first } }))
        .resolves.toEqual({ enabled: false });

      await expect(scim.patchGroup(group, parseScimGroupPatch({
        ...authentik.addMembers,
        Operations: [{ op: "add", path: "members", value: [{ value: first }] }]
      }))).resolves.toMatchObject({ kind: "ok" });
      await expect(scim.patchGroup(group, parseScimGroupPatch({
        Operations: [{ op: "Remove", path: "members", value: [{ value: second }] }]
      }))).resolves.toMatchObject({ kind: "ok" });
      await expect(members(group)).resolves.toEqual([first]);

      await expect(scim.patchGroup(group, parseScimGroupPatch({
        Operations: [{ op: "add", path: "members", value: [{ value: second }, { value: randomUUID() }] }]
      }))).rejects.toBeInstanceOf(ScimRequestError);
      await expect(scim.patchGroup(group, parseScimGroupPatch({
        Operations: [{ op: "add", path: "members", value: Array.from({ length: 1_001 }, () => ({ value: randomUUID() })) }]
      }))).rejects.toMatchObject({ detail: "A request may change at most 1000 members.", status: 400 });
      await expect(members(group)).resolves.toEqual([first]);

      await expect(admins.setUserGroups({ expectedGroupIds: [group], groupIds: [], userId: first }))
        .resolves.toBe("group_membership_managed");
      await expect(admins.setUserGroups({ expectedGroupIds: [], groupIds: [group], userId: second }))
        .resolves.toBe("group_membership_managed");
    });
  });

  it("replaces members on PUT and archives on DELETE under a name the IdP can push again", async () => {
    await withScimData(async (fixture) => {
      const stays = await fixture.user("stays");
      const leaves = await fixture.user("leaves");
      const group = groupId(await scim.createGroup(parseScimGroupBody({
        displayName: fixture.groupName("Platform"),
        externalId: fixture.externalId("platform"),
        members: [{ value: stays }, { value: leaves }]
      })));

      await expect(scim.replaceGroup(group, parseScimGroupBody({
        displayName: fixture.groupName("Platform Engineering"),
        members: [{ value: stays }]
      }))).resolves.toMatchObject({ kind: "ok" });
      await expect(prisma.group.findUniqueOrThrow({ select: { name: true, scimExternalId: true }, where: { id: group } }))
        .resolves.toEqual({ name: fixture.groupName("Platform Engineering"), scimExternalId: fixture.externalId("platform") });
      await expect(members(group)).resolves.toEqual([stays]);

      await expect(scim.deleteGroup(group)).resolves.toMatchObject({ kind: "ok" });
      await expect(prisma.group.findUniqueOrThrow({ select: { archivedAt: true, name: true, scimExternalId: true }, where: { id: group } }))
        .resolves.toEqual({
          archivedAt: expect.any(Date),
          name: `${fixture.groupName("Platform Engineering")} (archived ${group.slice(0, 8)})`,
          scimExternalId: null
        });
      await expect(members(group)).resolves.toEqual([stays]);
      await expect(scim.getGroup(group, true)).resolves.toBeNull();
      await expect(scim.deleteGroup(group)).resolves.toEqual({ kind: "not_found" });

      // The IdP may push the group again: a new group, without the archived one's grants.
      const again = groupId(await scim.createGroup(parseScimGroupBody({ displayName: fixture.groupName("Platform Engineering") })));
      expect(again).not.toBe(group);
      // A group an administrator archived is not resurrected under its name.
      const archivedByAdmin = await fixture.group("Archived by admin");
      await expect(admins.archiveGroup(archivedByAdmin.id)).resolves.toBe(true);
      await expect(scim.createGroup(parseScimGroupBody({ displayName: archivedByAdmin.name })))
        .resolves.toEqual({ detail: "An archived group has this name.", kind: "uniqueness" });
    });
  });

  it("links the protected Full access group by id but never renames or archives it", async () => {
    const full = await prisma.group.findUniqueOrThrow({
      select: { id: true, name: true, scimExternalId: true },
      where: { systemRole: "full_access" }
    });
    const externalId = `full-access-${randomUUID()}`;
    try {
      // No member operations: the shared Full access memberships stay untouched.
      await expect(scim.patchGroup(full.id, parseScimGroupPatch({ Operations: [{ op: "replace", path: "externalId", value: externalId }] })))
        .resolves.toEqual({ groupId: full.id, kind: "ok" });
      await expect(scim.patchGroup(full.id, parseScimGroupPatch(entra.renameGroup)))
        .rejects.toMatchObject({ scimType: "mutability", status: 400 });
      await expect(scim.deleteGroup(full.id)).resolves.toEqual({ groupId: full.id, kind: "ok" });
      await expect(prisma.group.findUniqueOrThrow({ select: { archivedAt: true, name: true, scimExternalId: true }, where: { id: full.id } }))
        .resolves.toEqual({ archivedAt: null, name: full.name, scimExternalId: null });
    } finally {
      await prisma.group.update({ data: { scimExternalId: full.scimExternalId }, where: { id: full.id } });
    }
  });

  it("never lets a manual membership edit land on a group a racing SCIM push links", async () => {
    await withScimData(async (fixture) => {
      const person = await fixture.user("racing");
      const group = await fixture.group("Racing");

      for (let round = 0; round < 4; round += 1) {
        const wait = startBarrier(2);
        const [pushed, manual] = await Promise.all([
          wait().then(() => scim.createGroup(parseScimGroupBody({
            displayName: group.name,
            externalId: fixture.externalId(`racing-${round}`),
            members: []
          }))),
          wait().then(() => admins.setUserGroups({ expectedGroupIds: [], groupIds: [group.id], userId: person }))
        ]);

        expect(pushed).toEqual({ groupId: group.id, kind: "ok" });
        // Either the manual edit ran first and the push replaced the members, or it was refused.
        expect(["applied", "group_membership_managed", "user_access_stale"]).toContain(manual);
        await expect(members(group.id)).resolves.toEqual([]);
        await prisma.group.update({ data: { scimExternalId: null }, where: { id: group.id } });
      }
    });
  });
});

describe("SCIM sign-in link rule", () => {
  const source = "https://idp.example.test/realms/scim";

  /** The installation's SCIM setting exists only inside this always-rolled-back transaction. */
  async function withScimLink<T>(
    linkMethod: "ldap" | "none" | "oidc" | "saml" | null,
    run: (tx: Prisma.TransactionClient) => Promise<T>
  ): Promise<T> {
    return rolledBack(async (tx) => {
      await tx.authSignInMethodSetting.deleteMany({ where: { method: "scim" } });
      if (linkMethod !== null) {
        await tx.authSignInMethodSetting.create({
          data: { activatedAt: now, activeConfig: { linkMethod }, activeVersion: 1, enabled: true, method: "scim" }
        });
      }
      return run(tx);
    });
  }

  function oidcInput(email: string, subject: string): ExternalIdentityInput {
    return {
      displayName: "Directory Person",
      email,
      emailVerified: false,
      groups: [],
      now,
      policy: externalIdentityPolicy({ adminGroups: [], allowedGroups: [], autoCreateUsers: true, syncGroups: false }),
      provider: "oidc",
      source,
      subject: `${subject}-${randomUUID()}`
    };
  }

  it("links a SCIM-provisioned account on its first sign-in with the configured method by email", async () => {
    await withScimData(async (fixture) => {
      const provisioned = await fixture.user("provisioned", { scimExternalId: fixture.externalId("provisioned") });
      await fixture.user("local");

      await expect(withScimLink("oidc", async (tx) => {
        const outcome = await settleExternalIdentity(tx, oidcInput(fixture.email("provisioned"), "provisioned"));
        const identity = await tx.authIdentity.findFirst({ select: { emailVerifiedAt: true, userId: true }, where: { provider: "oidc", userId: provisioned } });
        return { identity, outcome };
      })).resolves.toEqual({
        identity: { emailVerifiedAt: null, userId: provisioned },
        outcome: { status: "active", userId: provisioned }
      });

      // Only for the configured method, only for SCIM-provisioned accounts, only while SCIM is active.
      await expect(withScimLink("saml", (tx) => settleExternalIdentity(tx, oidcInput(fixture.email("provisioned"), "other-method"))))
        .resolves.toEqual({ status: "account_conflict" });
      await expect(withScimLink("oidc", (tx) => settleExternalIdentity(tx, oidcInput(fixture.email("local"), "local"))))
        .resolves.toEqual({ status: "account_conflict" });
      await expect(withScimLink(null, (tx) => settleExternalIdentity(tx, oidcInput(fixture.email("provisioned"), "scim-off"))))
        .resolves.toEqual({ status: "account_conflict" });
      await expect(withScimLink("none", (tx) => settleExternalIdentity(tx, oidcInput(fixture.email("provisioned"), "no-link"))))
        .resolves.toEqual({ status: "account_conflict" });

      // Never for an administrator, nor for an account that already signs in some other way: an
      // unverified email must not take over a real account, even one SCIM linked by its email.
      await fixture.user("provisioned-admin", { role: "admin", scimExternalId: fixture.externalId("provisioned-admin") });
      await expect(withScimLink("oidc", (tx) => settleExternalIdentity(tx, oidcInput(fixture.email("provisioned-admin"), "admin"))))
        .resolves.toEqual({ status: "account_conflict" });
      const linkedLocal = await fixture.user("linked-local", { scimExternalId: fixture.externalId("linked-local") });
      await prisma.authIdentity.create({
        data: {
          emailVerifiedAt: now,
          normalizedEmail: fixture.email("linked-local"),
          passwordHash: "aiqsa-scrypt-v1$synthetic",
          provider: "password",
          providerAccountId: fixture.email("linked-local"),
          userId: linkedLocal
        }
      });
      await expect(withScimLink("oidc", (tx) => settleExternalIdentity(tx, oidcInput(fixture.email("linked-local"), "linked-local"))))
        .resolves.toEqual({ status: "account_conflict" });
      await prisma.authIdentity.create({
        data: {
          normalizedEmail: `former-${fixture.email("provisioned")}`,
          provider: "oidc",
          providerAccountId: `former-${randomUUID()}`,
          source,
          userId: provisioned
        }
      });
      await expect(withScimLink("oidc", (tx) => settleExternalIdentity(tx, oidcInput(fixture.email("provisioned"), "second"))))
        .resolves.toEqual({ status: "account_conflict" });
      // A verified email still links as it always did.
      await expect(withScimLink("oidc", (tx) => settleExternalIdentity(tx, {
        ...oidcInput(fixture.email("linked-local"), "verified"),
        emailVerified: true
      }))).resolves.toEqual({ status: "active", userId: linkedLocal });
    });
  });
});
