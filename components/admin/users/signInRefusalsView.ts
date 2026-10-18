import { formatSignInTime, signInMethodLabels } from "@/components/admin/signIn/signInView";
import type {
  AdminSignInRefusal,
  AdminSignInRefusalAccount,
  SignInRefusalCode
} from "@/lib/contracts/adminSignInRefusals";

/** Refused sign-ins shown before `Show N more`. */
export const ADMIN_SIGN_IN_REFUSALS_PREVIEW = 5;

/** Why a sign-in was refused, in plain words. */
export const signInRefusalReasonLabels: Readonly<Record<SignInRefusalCode, string>> = {
  account_conflict: "Could not be linked to the existing account",
  account_inactive: "Account is disabled or denied",
  account_pending: "Account awaits approval",
  email_missing: "The provider sent no email",
  email_unverified: "Email not verified yet",
  invalid_code: "Wrong two-factor code",
  invalid_credentials: "Wrong password",
  not_allowed: "Not allowed to sign in",
  source_changed: "Linked to a previous sign-in source"
};

const statusLabels: Readonly<Record<AdminSignInRefusalAccount["status"], string | null>> = {
  active: null,
  denied: "denied",
  disabled: "disabled",
  pending: "pending"
};

/**
 * What the row says: who (an email, an account, or nobody the method vouches for), what the
 * Invite or Open user action may target, and one detail line with method, reason, attempts
 * and the last attempt's time.
 */
export type SignInRefusalPresentation = Readonly<{
  /** The account to open; null when nobody has the email or the row names nobody. */
  account: AdminSignInRefusalAccount | null;
  detail: string;
  /** The verified email to invite; only for an email nobody has an account with. */
  invitableEmail: string | null;
  /** The row names nobody (no verified email, or past the day's limit). */
  muted: boolean;
  title: string;
}>;

function accountIdentity(account: AdminSignInRefusalAccount, email: string | null): string {
  return [email ?? "no email", statusLabels[account.status]].filter((part): part is string => part !== null).join(" · ");
}

export function signInRefusalPresentation(refusal: AdminSignInRefusal): SignInRefusalPresentation {
  const attempts = `${refusal.attempts} ${refusal.attempts === 1 ? "attempt" : "attempts"}`;
  const facts = [
    signInMethodLabels[refusal.method],
    signInRefusalReasonLabels[refusal.code],
    attempts,
    formatSignInTime(refusal.lastSeenAt)
  ];
  const detail = (identity: string | null) =>
    [identity, ...facts].filter((part): part is string => Boolean(part)).join(" · ");
  const { subject } = refusal;
  switch (subject.kind) {
    case "email":
      return subject.account
        ? { account: subject.account, detail: detail(accountIdentity(subject.account, subject.email)), invitableEmail: null,
            muted: false, title: subject.account.displayName }
        : { account: null, detail: detail(null), invitableEmail: subject.email, muted: false, title: subject.email };
    case "account":
      return { account: subject.account, detail: detail(accountIdentity(subject.account, subject.account.email)),
        invitableEmail: null, muted: false, title: subject.account.displayName };
    case "no_verified_email":
      return { account: null, detail: detail(null), invitableEmail: null, muted: true, title: "No verified email" };
    case "overflow":
      return { account: null, detail: detail(null), invitableEmail: null, muted: true,
        title: "More attempts (daily limit reached)" };
  }
}
