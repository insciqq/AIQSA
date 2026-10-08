import type { PrismaClient } from "@prisma/client";
import type { AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import {
  completeExternalSignIn,
  externalIdentityPolicy,
  type ExternalSignInResult
} from "../externalIdentity";
import type { SignInSessionInput } from "../signInCompletion";
import type { TrustedHeaderIdentity } from "./identityHeaders";
import { TRUSTED_HEADER_SOURCE } from "./method";

export type TrustedHeaderSignInRepository = {
  /** The account the header's identity is linked to, if any. */
  findLinkedUserId(email: string): Promise<string | null>;
  /** Ends a session the header's identity does not own; returns whether one was open. */
  revokeReplacedSession(input: { now: Date; tokenHash: string }): Promise<boolean>;
  signIn(input: {
    config: AuthSignInMethodConfig<"trusted_header">;
    identity: TrustedHeaderIdentity;
    now: Date;
    session: SignInSessionInput;
  }): Promise<ExternalSignInResult>;
};

export function createPrismaTrustedHeaderSignInRepository(prisma: PrismaClient): TrustedHeaderSignInRepository {
  return {
    async findLinkedUserId(email) {
      const identity = await prisma.authIdentity.findUnique({
        select: { source: true, userId: true },
        where: { provider_providerAccountId: { provider: "trusted_header", providerAccountId: email } }
      });
      return identity?.source === TRUSTED_HEADER_SOURCE ? identity.userId : null;
    },

    async revokeReplacedSession(input) {
      const result = await prisma.authSession.updateMany({
        data: { revokedAt: input.now, revokedReason: "trusted_header_replaced" },
        where: { revokedAt: null, tokenHash: input.tokenHash }
      });
      return result.count > 0;
    },

    signIn(input) {
      // The proxy authenticated the address, so it counts as verified; it is also the
      // subject, so a changed address is a new identity.
      return completeExternalSignIn(prisma, {
        displayName: input.identity.displayName,
        email: input.identity.email,
        emailVerified: true,
        groups: input.identity.groups,
        now: input.now,
        policy: externalIdentityPolicy(input.config),
        provider: "trusted_header",
        session: input.session,
        signInMethod: "trusted_header",
        source: TRUSTED_HEADER_SOURCE,
        subject: input.identity.email
      });
    }
  };
}
