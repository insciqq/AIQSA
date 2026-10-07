import type { PrismaClient } from "@prisma/client";
import type { OAuthProviderId } from "../../auth/oauth";
import { settleExternalIdentity, type ExternalIdentityPolicy } from "./externalIdentity";

export type OAuthIdentitySettlementInput = {
  displayName: string;
  email: string;
  now: Date;
  provider: OAuthProviderId;
  providerAccountId: string;
};

export type OAuthIdentitySettlementResult =
  | {
      status: "active";
      userId: string;
    }
  | {
      status: "account_conflict" | "not_allowed" | "pending";
    };

export type OAuthIdentityRepository = {
  settleIdentity(input: OAuthIdentitySettlementInput): Promise<OAuthIdentitySettlementResult>;
};

/** Google and Yandex admit through the access rules and carry no groups, admin role or source. */
const OAUTH_POLICY: ExternalIdentityPolicy = {
  adminGroups: [],
  admission: { kind: "access_rules" },
  autoCreateUsers: true,
  syncGroups: false,
  trustUnverifiedEmail: false
};

/**
 * Whether the email of a settled profile is verified. Google: `verifyGoogleIdToken` accepts
 * only ID tokens with `email_verified === true`, and the callback settles only the profiles it
 * returned. Yandex: the account's default email has always linked existing accounts, and that
 * stays an explicit choice here.
 */
const OAUTH_EMAIL_VERIFIED = {
  google: true,
  yandex: true
} as const satisfies Record<OAuthProviderId, boolean>;

export function createPrismaOAuthIdentityRepository(prisma: PrismaClient): OAuthIdentityRepository {
  return {
    async settleIdentity(input) {
      const outcome = await prisma.$transaction((tx) =>
        settleExternalIdentity(tx, {
          displayName: input.displayName,
          email: input.email,
          emailVerified: OAUTH_EMAIL_VERIFIED[input.provider],
          groups: null,
          now: input.now,
          policy: OAUTH_POLICY,
          provider: input.provider,
          source: null,
          subject: input.providerAccountId
        })
      );

      switch (outcome.status) {
        case "active":
          return { status: "active", userId: outcome.userId };
        case "account_conflict":
        case "not_allowed":
        case "pending":
          return { status: outcome.status };
        default:
          // Google and Yandex identities have no source, and the callback settles only a
          // plausible email, so neither remaining outcome can occur.
          throw new Error("oauth_settlement_unexpected");
      }
    }
  };
}
