import type { AuthIdentityProvider, Prisma, PrismaClient, User, UserRole } from "@prisma/client";
import {
  isExternalGroupSource,
  scimConfigSchema,
  type AuthSessionSignInMethod,
  type ExternalGroupPolicyConfig
} from "@/lib/contracts/authSignInMethods";
import { syncExternalGroups } from "./groupMembership";
import { isPlausibleEmail, normalizeAuthEmail } from "./password";
import { provisionActiveUser, type ProvisioningGroupInput } from "./provisioning";
import {
  findEnabledAccessRuleMatch,
  replaceProvisionalDisplayName,
  type ApprovalMatch
} from "./registrationRepository";
import type { SecondFactorChallengeSubject } from "./secondFactorChallenge";
import { issueSignInSession, type SignInSessionInput } from "./signInCompletion";
import {
  lockActiveAdmins,
  lockAuthIdentity,
  lockAuthRegistrationEmail,
  lockAuthUser
} from "./transactionLocks";

export type ExternalIdentityProvider = Exclude<AuthIdentityProvider, "password">;

/** Providers whose identities carry no source: the provider itself is the only authority. */
const SOURCELESS_PROVIDERS: ReadonlySet<ExternalIdentityProvider> = new Set(["google", "yandex"]);

/** Groups admission with empty `allowedGroups` admits anyone the source authenticated. */
export type ExternalIdentityAdmission =
  | { kind: "access_rules" }
  | { allowedGroups: readonly string[]; kind: "groups" };

export type ExternalIdentityPolicy = {
  adminGroups: readonly string[];
  admission: ExternalIdentityAdmission;
  autoCreateUsers: boolean;
  syncGroups: boolean;
  trustUnverifiedEmail: boolean;
};

export type ExternalIdentityInput = {
  displayName: string;
  /** A missing or unusable email refuses the sign-in with `email_missing`. */
  email: string | null;
  /** Whether the source asserted that it verified the email. */
  emailVerified: boolean;
  /** The source's group or role values; null when its claim or attribute was missing. */
  groups: readonly string[] | null;
  now: Date;
  policy: ExternalIdentityPolicy;
  provider: ExternalIdentityProvider;
  /** The configured source (issuer, directory, IdP entity); null exactly for Google and Yandex. */
  source: string | null;
  /** The source's stable account subject. */
  subject: string;
};

export type ExternalIdentityWarning = "groups_claim_missing" | "last_admin_kept";

export type ExternalIdentityOutcome =
  | { status: "active"; userId: string; warning?: ExternalIdentityWarning }
  | { status: "account_conflict" | "email_missing" | "not_allowed" | "pending" | "source_changed" };

/**
 * `second_factor_required` (LDAP with TOTP only) creates no session: the caller signs the
 * challenge into the second-factor cookie (`createSecondFactorChallengeCookie`).
 */
export type ExternalSignInResult =
  | (Extract<ExternalIdentityOutcome, { status: "active" }> & { sessionId: string })
  | (Omit<Extract<ExternalIdentityOutcome, { status: "active" }>, "status"> & {
      challenge: SecondFactorChallengeSubject;
      status: "second_factor_required";
    })
  | Exclude<ExternalIdentityOutcome, { status: "active" }>;

export type ExternalAdminRoleChange = "demote" | "keep_last_admin" | "none" | "promote";

type SettledUser = Pick<User, "id" | "role" | "roleManagedBy">;

/** The settlement policy of a method whose source asserts groups. */
export function externalIdentityPolicy(config: ExternalGroupPolicyConfig): ExternalIdentityPolicy {
  return {
    adminGroups: config.adminGroups,
    admission: { allowedGroups: config.allowedGroups, kind: "groups" },
    autoCreateUsers: config.autoCreateUsers,
    syncGroups: config.syncGroups,
    trustUnverifiedEmail: config.trustUnverifiedEmail ?? false
  };
}

/**
 * Who manages an admin role a source granted. The provider is part of it because one IdP can
 * serve two methods under the same name (a Keycloak realm is both OIDC issuer and SAML entity).
 */
export function externalRoleManager(provider: ExternalIdentityProvider, source: string | null): string {
  return source === null ? provider : `${provider}:${source}`;
}

/**
 * The admin-role decision for a source that manages admins: members of its admin groups become
 * admins; an admin it promoted itself loses the role when it no longer lists them, unless no
 * other active admin would remain. Manual admins and admins another source promoted keep it.
 */
export function externalAdminRoleChange(input: {
  adminGroups: readonly string[];
  groups: readonly string[];
  manager: string;
  otherActiveAdmins: number;
  role: UserRole;
  roleManagedBy: string | null;
}): ExternalAdminRoleChange {
  const adminGroups = new Set(input.adminGroups);

  if (input.groups.some((value) => adminGroups.has(value))) {
    return input.role === "admin" ? "none" : "promote";
  }

  if (input.role !== "admin" || input.roleManagedBy !== input.manager) {
    return "none";
  }

  return input.otherActiveAdmins > 0 ? "demote" : "keep_last_admin";
}

/** Groups admission fails closed when allowed groups are set but the source sent none. */
function admittedByGroups(admission: ExternalIdentityAdmission, groups: readonly string[] | null): boolean {
  if (admission.kind !== "groups" || admission.allowedGroups.length === 0) {
    return true;
  }

  const allowedGroups = new Set(admission.allowedGroups);

  return groups !== null && groups.some((value) => allowedGroups.has(value));
}

function fallbackDisplayName(displayName: string, normalizedEmail: string): string {
  return displayName.trim().slice(0, 160) || normalizedEmail.split("@")[0] || "AIQSA User";
}

async function activateUser(
  tx: Prisma.TransactionClient,
  input: { groups: ProvisioningGroupInput[]; userId: string }
): Promise<void> {
  await tx.user.update({
    data: {
      status: "active"
    },
    where: {
      id: input.userId
    }
  });
  await provisionActiveUser(tx, input);
}

/**
 * Whether an email may stand for its owner: the source verified it, or the operator trusts this
 * method's unverified emails. Only such an email links to, approves or claims an account email.
 */
function emailTrusted(input: ExternalIdentityInput): boolean {
  return input.emailVerified || input.policy.trustUnverifiedEmail;
}

/** Disabled or denied, or deactivated by SCIM while that waits for a Project ownership transfer. */
function signInBlocked(user: Pick<User, "scimDeactivatedAt" | "status">): boolean {
  return user.status === "disabled" || user.status === "denied" || user.scimDeactivatedAt !== null;
}

/**
 * The SCIM link rule: an account SCIM provisioned links its first identity of the method SCIM
 * links users to by email, even when that method does not trust unverified emails, because the
 * same IdP that pushed the account vouches for its email. Only while SCIM is active, only for
 * that method's provider, and only while the account has no identity of that provider.
 */
async function scimProvisionedLink(
  tx: Prisma.TransactionClient,
  input: ExternalIdentityInput,
  user: Pick<User, "id" | "scimExternalId">
): Promise<boolean> {
  if (user.scimExternalId === null || !["ldap", "oidc", "saml"].includes(input.provider)) {
    return false;
  }

  const scim = await tx.authSignInMethodSetting.findUnique({
    select: { activeConfig: true, enabled: true },
    where: { method: "scim" }
  });
  const config = scim?.enabled ? scimConfigSchema.safeParse(scim.activeConfig) : null;

  if (!config?.success || config.data.linkMethod !== input.provider) {
    return false;
  }

  const identities = await tx.authIdentity.count({ where: { provider: input.provider, userId: user.id } });

  return identities === 0;
}

/**
 * Activates a pending account when admission vouches for it: an enabled access rule for the
 * account's trusted email, or the source's groups admission (already passed). False keeps it
 * pending.
 */
async function activatePendingUser(
  tx: Prisma.TransactionClient,
  policy: ExternalIdentityPolicy,
  input: { emailTrusted: boolean; normalizedEmail: string; userId: string }
): Promise<boolean> {
  let groups: ProvisioningGroupInput[] = [];

  if (policy.admission.kind === "access_rules") {
    const approval = input.emailTrusted ? await findEnabledAccessRuleMatch(tx, input.normalizedEmail) : null;

    if (!approval) {
      return false;
    }

    groups = approval.groups;
  }

  await activateUser(tx, { groups, userId: input.userId });

  return true;
}

async function applyExternalAdminRole(
  tx: Prisma.TransactionClient,
  input: {
    activeAdmins: readonly { id: string }[];
    adminGroups: readonly string[];
    groups: readonly string[];
    manager: string;
    user: SettledUser;
  }
): Promise<ExternalIdentityWarning | undefined> {
  const change = externalAdminRoleChange({
    adminGroups: input.adminGroups,
    groups: input.groups,
    manager: input.manager,
    otherActiveAdmins: input.activeAdmins.filter((admin) => admin.id !== input.user.id).length,
    role: input.user.role,
    roleManagedBy: input.user.roleManagedBy
  });

  if (change === "keep_last_admin") {
    return "last_admin_kept";
  }

  if (change !== "none") {
    await tx.user.update({
      data: change === "promote"
        ? { role: "admin", roleManagedBy: input.manager }
        : { role: "user", roleManagedBy: null },
      where: {
        id: input.user.id
      }
    });
  }

  return undefined;
}

/** Applies what the source manages for an active account: group memberships and the admin role. */
async function finishActiveSignIn(
  tx: Prisma.TransactionClient,
  input: ExternalIdentityInput,
  context: {
    activeAdmins: { id: string }[] | null;
    identityId: string;
    user: SettledUser;
  }
): Promise<ExternalIdentityOutcome> {
  const { policy } = input;
  let warning: ExternalIdentityWarning | undefined;

  if (policy.syncGroups) {
    if (!isExternalGroupSource(input.provider)) {
      throw new Error("external_group_sync_unsupported");
    }

    const sync = await syncExternalGroups(tx, {
      source: input.provider,
      userId: context.user.id,
      values: input.groups
    });
    warning = sync.warning;
  }

  if (context.activeAdmins) {
    // A missing claim changes nothing, the admin role included.
    const roleWarning = input.groups === null
      ? "groups_claim_missing"
      : await applyExternalAdminRole(tx, {
          activeAdmins: context.activeAdmins,
          adminGroups: policy.adminGroups,
          groups: input.groups,
          manager: externalRoleManager(input.provider, input.source),
          user: context.user
        });
    warning ??= roleWarning;
  }

  if (policy.syncGroups || context.activeAdmins) {
    await tx.authIdentity.update({
      data: {
        lastSyncWarning: warning ?? null,
        lastSyncedAt: input.now
      },
      where: {
        id: context.identityId
      }
    });
  }

  return warning
    ? { status: "active", userId: context.user.id, warning }
    : { status: "active", userId: context.user.id };
}

async function settleKnownSubject(
  tx: Prisma.TransactionClient,
  input: ExternalIdentityInput,
  context: { identity: { id: string; userId: string }; locksAdmins: boolean; normalizedEmail: string }
): Promise<ExternalIdentityOutcome> {
  await lockAuthIdentity(tx, context.identity.id);
  const activeAdmins = context.locksAdmins ? await lockActiveAdmins(tx) : null;
  await lockAuthUser(tx, context.identity.userId);

  const identity = await tx.authIdentity.findUnique({
    include: {
      user: true
    },
    where: {
      id: context.identity.id
    }
  });

  if (!identity) {
    return { status: "not_allowed" };
  }

  // The same subject under another configuration of the method is not this account.
  if (identity.source !== input.source) {
    return { status: "source_changed" };
  }

  if (signInBlocked(identity.user)) {
    return { status: "not_allowed" };
  }

  const currentEmailIdentity = await tx.authIdentity.findUnique({
    select: {
      id: true
    },
    where: {
      provider_normalizedEmail: {
        normalizedEmail: context.normalizedEmail,
        provider: input.provider
      }
    }
  });

  if (currentEmailIdentity && currentEmailIdentity.id !== identity.id) {
    return { status: "account_conflict" };
  }

  if (
    identity.user.status !== "active" &&
    !(await activatePendingUser(tx, input.policy, {
      emailTrusted: identity.emailVerifiedAt !== null || input.policy.trustUnverifiedEmail,
      normalizedEmail: identity.normalizedEmail,
      userId: identity.userId
    }))
  ) {
    return { status: "pending" };
  }

  return finishActiveSignIn(tx, input, {
    activeAdmins,
    identityId: identity.id,
    user: identity.user
  });
}

async function settleNewIdentity(
  tx: Prisma.TransactionClient,
  input: ExternalIdentityInput,
  context: { locksAdmins: boolean; normalizedEmail: string }
): Promise<ExternalIdentityOutcome> {
  const { normalizedEmail } = context;
  const emailIdentity = await tx.authIdentity.findUnique({
    select: {
      id: true
    },
    where: {
      provider_normalizedEmail: {
        normalizedEmail,
        provider: input.provider
      }
    }
  });

  if (emailIdentity) {
    return { status: "account_conflict" };
  }

  const candidate = await tx.user.findUnique({
    select: {
      id: true
    },
    where: {
      email: normalizedEmail
    }
  });
  const activeAdmins = context.locksAdmins ? await lockActiveAdmins(tx) : null;
  let user: User | null = null;

  if (candidate) {
    await lockAuthUser(tx, candidate.id);
    user = await tx.user.findUnique({
      where: {
        id: candidate.id
      }
    });
  }

  const trusted = emailTrusted(input);

  // Linking reaches an existing account only through an email the source verified, one the
  // operator explicitly trusts for this method, or the SCIM link rule.
  if (user && !trusted && !(await scimProvisionedLink(tx, input, user))) {
    return { status: "account_conflict" };
  }

  if (user && signInBlocked(user)) {
    return { status: "not_allowed" };
  }

  let approval: ApprovalMatch | null = null;

  if (input.policy.admission.kind === "access_rules" && user?.status !== "active") {
    approval = trusted ? await findEnabledAccessRuleMatch(tx, normalizedEmail) : null;

    if (!user && !approval) {
      return { status: "not_allowed" };
    }
  }

  if (!user && !input.policy.autoCreateUsers) {
    return { status: "not_allowed" };
  }

  const displayName = fallbackDisplayName(input.displayName, normalizedEmail);

  if (user) {
    await replaceProvisionalDisplayName(tx, {
      displayName,
      userId: user.id
    });
  }

  // An account created from an untrusted email does not claim the address: a later verified
  // sign-in or registration for it must never link into this subject's account.
  user ??= await tx.user.create({
    data: {
      displayName,
      email: trusted ? normalizedEmail : null,
      role: "user",
      status: "pending"
    }
  });

  const identity = await tx.authIdentity.create({
    data: {
      emailVerifiedAt: input.emailVerified ? input.now : null,
      normalizedEmail,
      passwordHash: null,
      provider: input.provider,
      providerAccountId: input.subject,
      source: input.source,
      userId: user.id
    }
  });

  if (user.status !== "active") {
    if (input.policy.admission.kind === "access_rules" && !approval) {
      return { status: "pending" };
    }

    await activateUser(tx, { groups: approval?.groups ?? [], userId: user.id });
  }

  return finishActiveSignIn(tx, input, {
    activeAdmins,
    identityId: identity.id,
    user
  });
}

/**
 * Settles one external sign-in (OIDC, LDAP, SAML, trusted header, Google, Yandex) inside the
 * caller's transaction. The source's subject, never its mutable email, finds a linked identity.
 * Only a trusted email (verified by the source, or trusted by the policy) links a new identity
 * to an existing account, counts for access rules, or becomes a new account's email; the one
 * exception is the SCIM link rule (`scimProvisionedLink`). A new account is created only when
 * admission passed and the policy creates users. A pending SCIM deactivation refuses like a
 * disabled account.
 *
 * Lock order, shared by every external sign-in:
 *   1. the normalized email (advisory, `lockAuthRegistrationEmail`);
 *   2. the identity matched by subject (`lockAuthIdentity`);
 *   3. whenever the policy manages admins (non-empty `adminGroups`), the active-admin set
 *      (`lockActiveAdmins`), which `setUserRole` and `disableUser` also take before their
 *      target row;
 *   4. the user (`lockAuthUser`).
 * Admin commands lock neither emails nor identities, and every writer of the active-admin set
 * takes it before a user row, so no two of these transactions wait on each other in a cycle.
 */
export async function settleExternalIdentity(
  tx: Prisma.TransactionClient,
  input: ExternalIdentityInput
): Promise<ExternalIdentityOutcome> {
  if ((input.source === null) !== SOURCELESS_PROVIDERS.has(input.provider)) {
    throw new Error("external_identity_source_invalid");
  }

  const normalizedEmail = input.email === null ? "" : normalizeAuthEmail(input.email);

  if (!isPlausibleEmail(normalizedEmail)) {
    return { status: "email_missing" };
  }

  // Groups admission depends only on what the source asserted, so it is decided before any
  // account is read: a refused sign-in learns nothing about existing accounts.
  if (!admittedByGroups(input.policy.admission, input.groups)) {
    return { status: "not_allowed" };
  }

  await lockAuthRegistrationEmail(tx, normalizedEmail);

  const subjectIdentity = await tx.authIdentity.findUnique({
    select: {
      id: true,
      userId: true
    },
    where: {
      provider_providerAccountId: {
        provider: input.provider,
        providerAccountId: input.subject
      }
    }
  });
  const locksAdmins = input.policy.adminGroups.length > 0;

  return subjectIdentity
    ? settleKnownSubject(tx, input, { identity: subjectIdentity, locksAdmins, normalizedEmail })
    : settleNewIdentity(tx, input, { locksAdmins, normalizedEmail });
}

/**
 * Settles an external sign-in and ends it through the completion seam in one transaction, so
 * the session decision sees the settled account.
 */
export async function completeExternalSignIn(
  prisma: PrismaClient,
  input: ExternalIdentityInput & { session: SignInSessionInput; signInMethod: AuthSessionSignInMethod }
): Promise<ExternalSignInResult> {
  return prisma.$transaction(async (tx) => {
    const outcome = await settleExternalIdentity(tx, input);

    if (outcome.status !== "active") {
      return outcome;
    }

    const issued = await issueSignInSession(tx, {
      session: input.session,
      signInMethod: input.signInMethod,
      userId: outcome.userId
    });

    if (issued.kind === "refused") {
      return { status: "not_allowed" };
    }

    if (issued.kind === "second_factor_required") {
      // Only LDAP among external methods asks for a second factor; its challenge binds to the
      // identity that proved the first factor, which settlement has locked.
      const identity = await tx.authIdentity.findUniqueOrThrow({
        select: { id: true },
        where: { provider_providerAccountId: { provider: input.provider, providerAccountId: input.subject } }
      });

      return {
        ...(outcome.warning ? { warning: outcome.warning } : {}),
        challenge: {
          credential: identity.id,
          factorBinding: issued.factorBinding,
          identityId: identity.id,
          signInMethod: issued.signInMethod,
          userId: outcome.userId
        },
        status: "second_factor_required",
        userId: outcome.userId
      };
    }

    return { ...outcome, sessionId: issued.session.id };
  });
}
