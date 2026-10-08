import {
  externalIdentityPolicy,
  type ExternalIdentityInput,
  type ExternalSignInResult
} from "../externalIdentity";
import type { DirectoryPasswordSignIn, SafeUser } from "../handlers";
import { isPlausibleEmail, normalizeAuthEmail } from "../password";
import { prepareAuthSession } from "../requestAuth";
import { waitForAuthResponseFloor } from "../responseFloor";
import { createSecondFactorChallengeCookie } from "../secondFactorChallenge";
import type { SignInSessionInput } from "../signInCompletion";
import type { ResolvedSignInMethod } from "../signInMethods";
import type { SignInHealthRecorder } from "../signInSettings/health";
import { hashToken } from "../token";
import type { LdapConnect } from "./ldapConnection";
import { authenticateLdapUser } from "./ldapDirectory";
import { isBlankLdapPassword, ldapIdentitySource, ldapUsername } from "./ldapValues";

/**
 * The least time a directory sign-in that did not succeed takes: a missing entry, an ambiguous
 * search and a wrong password differ by one bind, and a local password routed around the
 * directory by a database read and a hash, so all of them wait to the same floor.
 */
export const LDAP_RESPONSE_FLOOR_MS = 500;
/** One directory sign-in's whole budget: resolve, connect, binds and searches. */
export const LDAP_SIGN_IN_DEADLINE_MS = 25_000;

type LdapCompletionInput = ExternalIdentityInput & { session: SignInSessionInput; signInMethod: "ldap" };

export type LdapPasswordFormDeps = {
  authenticate?: typeof authenticateLdapUser;
  clock?: () => number;
  completeSignIn(input: LdapCompletionInput): Promise<ExternalSignInResult>;
  connect(): LdapConnect;
  findUser(userId: string): Promise<SafeUser | null>;
  floorMs?: number;
  now?: () => Date;
  recordOutcome: SignInHealthRecorder;
  /** The active LDAP method, or null while LDAP sign-in is off. */
  resolveLdap(): Promise<ResolvedSignInMethod<"ldap"> | null>;
  sleep?: (milliseconds: number) => Promise<void>;
};

const SETTLEMENT_REFUSALS = {
  account_conflict: 409,
  email_missing: 403,
  not_allowed: 403,
  pending: 403,
  source_changed: 403
} as const;

function json(data: unknown, init?: ResponseInit): Response {
  return Response.json(data, init);
}

/** The account budget key of a directory name; case-folded, as directories compare names. */
export function ldapLoginRateLimitKey(username: string): string {
  return `ldap-login:account:${hashToken(username.toLowerCase()).slice(0, 32)}`;
}

/**
 * LDAP on the shared password form. An email with a usable local password keeps the local
 * password while password sign-in is on; every other name goes to the directory, also while
 * local passwords are off. Unknown names, ambiguous searches and wrong passwords all answer
 * `unauthorized` after the same floor; an unreachable directory answers `ldap_unavailable`
 * and records a content-free health code. A verified user with TOTP gets the second-factor
 * challenge instead of a session.
 */
export function createLdapPasswordFormSignIn(deps: LdapPasswordFormDeps): DirectoryPasswordSignIn {
  const clock = deps.clock ?? Date.now;

  return async (input) => {
    const ldap = await deps.resolveLdap();
    if (!ldap) return { kind: "inactive" };

    const startedAtMs = clock();
    const waitForFloor = () => waitForAuthResponseFloor({
      clock,
      floorMs: deps.floorMs ?? LDAP_RESPONSE_FLOOR_MS,
      sleep: deps.sleep,
      startedAtMs
    });
    const answered = (response: Response) => ({ kind: "answered" as const, response });
    const refused = async (response: Response) => {
      await waitForFloor();
      return answered(response);
    };

    const normalizedEmail = normalizeAuthEmail(input.identifier);
    if (
      isPlausibleEmail(normalizedEmail) &&
      (await input.passwordLoginEnabled()) &&
      (await input.localPasswordUsable(normalizedEmail))
    ) {
      return { kind: "local", waitForFloor };
    }

    const username = ldapUsername(input.identifier);
    if (!username) return refused(json({ error: "unauthorized" }, { status: 401 }));
    // Never sent: a blank password would be an unauthenticated bind many directories accept.
    if (isBlankLdapPassword(input.password)) return answered(json({ error: "credentials_required" }, { status: 400 }));

    const accountKey = ldapLoginRateLimitKey(username);
    const limited = await input.admitAccount(accountKey);
    if (limited) return answered(limited);

    const result = await (deps.authenticate ?? authenticateLdapUser)({
      config: ldap.config,
      connect: deps.connect(),
      password: input.password,
      secrets: ldap.secrets,
      signal: AbortSignal.timeout(LDAP_SIGN_IN_DEADLINE_MS),
      username
    });

    if (result.kind === "rejected") return refused(json({ error: "unauthorized" }, { status: 401 }));
    if (result.kind === "unavailable") {
      await deps.recordOutcome(ldap, result.code);
      return refused(json({ error: "ldap_unavailable" }, { status: 503 }));
    }

    const now = deps.now?.() ?? new Date();
    const session = prepareAuthSession({ now, request: input.request, secureCookie: input.config.cookieSecure });
    const { profile } = result;
    const settled = await deps.completeSignIn({
      displayName: profile.displayName,
      email: profile.email,
      // The directory does not assert verification; `trustUnverifiedEmail` (on by default for
      // LDAP) decides whether its email links accounts.
      emailVerified: false,
      groups: profile.groups,
      now,
      policy: externalIdentityPolicy(ldap.config),
      provider: "ldap",
      session: session.input,
      signInMethod: "ldap",
      source: ldapIdentitySource(ldap.config),
      subject: profile.subject
    });

    if (settled.status !== "active" && settled.status !== "second_factor_required") {
      // A pending account is the directory working as configured.
      await deps.recordOutcome(ldap, settled.status === "pending" ? "accepted" : settled.status);
      const error = settled.status === "pending" ? "account_pending" : settled.status;
      return answered(json({ error }, { status: SETTLEMENT_REFUSALS[settled.status] }));
    }

    await Promise.all([deps.recordOutcome(ldap, "accepted"), input.signedIn(accountKey)]);

    if (settled.status === "second_factor_required") {
      return answered(json(
        { status: "second_factor_required" },
        {
          headers: {
            "set-cookie": await createSecondFactorChallengeCookie(settled.challenge, { config: input.config, now })
          }
        }
      ));
    }

    const user = await deps.findUser(settled.userId);
    if (!user) return refused(json({ error: "unauthorized" }, { status: 401 }));

    return answered(json(
      {
        user: {
          displayName: user.displayName,
          email: user.email,
          id: user.id,
          role: user.role,
          status: user.status
        }
      },
      { headers: { "set-cookie": session.cookie } }
    ));
  };
}
