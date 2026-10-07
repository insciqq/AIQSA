import type { Prisma } from "@prisma/client";
import type { AuthSessionSignInMethod } from "@/lib/contracts/authSignInMethods";
import type { CreateAuthSessionInput } from "./requestAuth";

/** The session fields a sign-in prepares; the issuing transaction adds the user and method. */
export type SignInSessionInput = Omit<CreateAuthSessionInput, "signInMethod" | "userId">;

/** How a verified first factor ends. */
export type SessionIssuanceDecision = { kind: "session" };

export type SignInSessionIssuance = {
  kind: "session";
  session: Prisma.AuthSessionGetPayload<{ include: { user: true } }>;
};

/**
 * The one place that decides how a sign-in whose first factor was just verified ends. It runs
 * inside the transaction that proved that factor, so the decision sees the same locked state
 * (the password path re-checks its hash there). A second factor will be required here, for
 * password and LDAP sign-in only; until then every sign-in ends in a session.
 */
export async function decideSessionIssuance(
  _tx: Prisma.TransactionClient,
  _input: { signInMethod: AuthSessionSignInMethod; userId: string }
): Promise<SessionIssuanceDecision> {
  return { kind: "session" };
}

/**
 * Ends a verified sign-in inside its transaction: the seam decides, and a `session` decision
 * creates the session row with the method that proved the sign-in. Every sign-in that creates
 * a session goes through here.
 */
export async function issueSignInSession(
  tx: Prisma.TransactionClient,
  input: { session: SignInSessionInput; signInMethod: AuthSessionSignInMethod; userId: string }
): Promise<SignInSessionIssuance> {
  // `session` is the only decision so far; another kind must return before the insert.
  const decision = await decideSessionIssuance(tx, {
    signInMethod: input.signInMethod,
    userId: input.userId
  });
  const session = await tx.authSession.create({
    data: {
      createdByIp: input.session.createdByIp ?? null,
      createdByUserAgent: input.session.createdByUserAgent ?? null,
      expiresAt: input.session.expiresAt,
      lastSeenAt: input.session.lastSeenAt ?? null,
      signInMethod: input.signInMethod,
      tokenHash: input.session.tokenHash,
      userId: input.userId
    },
    include: {
      user: true
    }
  });

  return { kind: decision.kind, session };
}
