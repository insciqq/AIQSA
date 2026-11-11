import type { Prisma } from "@prisma/client";
import { provisionActiveUser } from "./provisioning";
import { lockAuthUser } from "./transactionLocks";

/**
 * Service accounts (`User.kind = service`) run connector work, such as Discord Connect, for
 * the installation. They never sign in: every sign-in path, session issuance and session
 * resolution refuses them even when an identity or password row exists, SCIM never sees them,
 * and they are never administrators or carry an email (a database check holds the last two).
 * Administrators manage them like any account: groups, limits, Revoke sessions, disable and
 * delete. Their chats stay private like any user's (operator decision 2026-11-12).
 */
export const SERVICE_ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 160;

/** Whether an account row is a service account; rows without a kind (fixtures) are people. */
export function isServiceAccount(user: { kind?: string | null } | null | undefined): boolean {
  return user?.kind === "service";
}

export type ServiceAccountRecord = {
  displayName: string;
  id: string;
  status: "active" | "denied" | "disabled" | "pending";
};

export type ServiceAccountCreation =
  | { account: ServiceAccountRecord; kind: "created" }
  | { kind: "actor_forbidden" | "display_name_invalid" };

/**
 * Creates a service account inside the caller's transaction, so the caller can record it (for
 * example on the Discord control row) atomically. Only an active administrator who is a person
 * may create one; the caller still authorizes its own route. The account is active with the
 * `user` role, no email and no identity, and its Memory settings start off: no facts, no past
 * chats, no automatic learning.
 */
export async function createServiceAccount(
  tx: Prisma.TransactionClient,
  input: { createdByUserId: string; displayName: string }
): Promise<ServiceAccountCreation> {
  const displayName = input.displayName.trim();

  if (!displayName || displayName.length > SERVICE_ACCOUNT_DISPLAY_NAME_MAX_LENGTH) {
    return { kind: "display_name_invalid" };
  }

  // A concurrent demotion or disable of the actor either commits first and refuses here, or waits.
  await lockAuthUser(tx, input.createdByUserId);
  const actor = await tx.user.findUnique({
    select: { kind: true, role: true, status: true },
    where: { id: input.createdByUserId }
  });

  if (!actor || actor.kind !== "person" || actor.role !== "admin" || actor.status !== "active") {
    return { kind: "actor_forbidden" };
  }

  const account = await tx.user.create({
    data: {
      displayName,
      email: null,
      kind: "service",
      role: "user",
      status: "active"
    },
    select: { displayName: true, id: true, status: true }
  });

  await provisionActiveUser(tx, { userId: account.id });
  await tx.userMemorySettings.create({
    data: {
      learnAutomatically: false,
      referenceChatHistory: false,
      useMemoryFacts: false,
      userId: account.id
    },
    select: { userId: true }
  });

  return { account, kind: "created" };
}

/** The service account with this id, or null when there is none or the account is a person. */
export async function findServiceAccount(
  db: Pick<Prisma.TransactionClient, "user">,
  userId: string
): Promise<ServiceAccountRecord | null> {
  const user = await db.user.findUnique({
    select: { displayName: true, id: true, kind: true, status: true },
    where: { id: userId }
  });

  return user && isServiceAccount(user)
    ? { displayName: user.displayName, id: user.id, status: user.status }
    : null;
}
