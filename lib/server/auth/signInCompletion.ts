import type { Prisma } from "@prisma/client";
import type { AuthSessionSignInMethod } from "@/lib/contracts/authSignInMethods";
import type { CreateAuthSessionInput } from "./requestAuth";
import { isSecondFactorSignInMethod, type SecondFactorSignInMethod } from "./secondFactorChallenge";
import { readTotpFactorBinding, type SecondFactorProof } from "./totpFactor";

/** The session fields a sign-in prepares; the issuing transaction adds the user and method. */
export type SignInSessionInput = Omit<CreateAuthSessionInput, "signInMethod" | "userId">;

/**
 * How a verified first factor ends. `second_factor_required` carries the factor state the
 * challenge binds to, so a challenge goes stale once that state changes. `refused` creates
 * nothing: SCIM deactivated the account and the deactivation waits for a Project ownership
 * transfer.
 */
export type SessionIssuanceDecision =
  | { kind: "refused" }
  | { kind: "session" }
  | { factorBinding: string; kind: "second_factor_required" };

export type SignInSessionIssuance =
  | { kind: "refused" }
  | {
      kind: "session";
      session: Prisma.AuthSessionGetPayload<{ include: { user: true } }>;
    }
  | {
      factorBinding: string;
      kind: "second_factor_required";
      signInMethod: SecondFactorSignInMethod;
      userId: string;
    };

/**
 * The one place that decides how a sign-in whose first factor was just verified ends. It runs
 * inside the transaction that proved that factor, so the decision sees the same locked state
 * (the password path re-checks its hash there). A pending SCIM deactivation refuses every
 * method except the bootstrap token, the break-glass sign-in. Password and LDAP sign-ins of a
 * user with a confirmed TOTP factor need a second factor; every other method (bootstrap token,
 * invite, Google, Yandex, OIDC, SAML, trusted header) ends in a session. A proof verified in the
 * same transaction for the same user satisfies the second factor.
 */
export async function decideSessionIssuance(
  tx: Prisma.TransactionClient,
  input: { secondFactor?: SecondFactorProof; signInMethod: AuthSessionSignInMethod; userId: string }
): Promise<SessionIssuanceDecision> {
  if (input.signInMethod !== "bootstrap") {
    // A shared lock on the account row: SCIM locks the row before it records a deactivation
    // and revokes sessions, so a session is either issued first and revoked by it, or refused.
    const [user] = await tx.$queryRaw<Array<{ scimDeactivatedAt: Date | null }>>`
      SELECT "scimDeactivatedAt" FROM "User" WHERE "id" = ${input.userId} FOR SHARE
    `;
    if (user?.scimDeactivatedAt) return { kind: "refused" };
  }

  if (!isSecondFactorSignInMethod(input.signInMethod) || input.secondFactor?.userId === input.userId) {
    return { kind: "session" };
  }

  const factorBinding = await readTotpFactorBinding(tx, input.userId);

  return factorBinding ? { factorBinding, kind: "second_factor_required" } : { kind: "session" };
}

/**
 * Ends a verified sign-in inside its transaction: the seam decides, and a `session` decision
 * creates the session row with the method that proved the sign-in. Every sign-in that creates
 * a session goes through here; a `second_factor_required` decision creates nothing and the
 * caller hands the user a second-factor challenge instead.
 */
export async function issueSignInSession(
  tx: Prisma.TransactionClient,
  input: {
    secondFactor?: SecondFactorProof;
    session: SignInSessionInput;
    signInMethod: AuthSessionSignInMethod;
    userId: string;
  }
): Promise<SignInSessionIssuance> {
  const decision = await decideSessionIssuance(tx, {
    ...(input.secondFactor ? { secondFactor: input.secondFactor } : {}),
    signInMethod: input.signInMethod,
    userId: input.userId
  });

  if (decision.kind === "refused") {
    return decision;
  }

  if (decision.kind === "second_factor_required") {
    if (!isSecondFactorSignInMethod(input.signInMethod)) {
      throw new Error("second_factor_method_invalid");
    }

    return {
      factorBinding: decision.factorBinding,
      kind: "second_factor_required",
      signInMethod: input.signInMethod,
      userId: input.userId
    };
  }

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
