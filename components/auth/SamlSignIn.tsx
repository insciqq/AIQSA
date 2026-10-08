import { KeyRound } from "lucide-react";
import { safeInternalPath } from "@/lib/auth/internalPath";
import { SAML_START_PATH, type SamlLoginOutcome } from "@/lib/contracts/samlSignIn";

/** What the login page knows about an active SAML method. */
export type SamlSignInOption = Readonly<{ buttonLabel: string }>;

export function samlStartHref(nextPath: string): string {
  return `${SAML_START_PATH}?${new URLSearchParams({ next: safeInternalPath(nextPath) }).toString()}`;
}

/** The login page's message after a SAML sign-in came back (`/login?saml=<outcome>`). */
export function samlOutcomeFeedback(
  outcome: SamlLoginOutcome,
  label: string
): { error: string | null; notice: string | null } {
  if (outcome === "pending") {
    return { error: null, notice: `${label} confirmed your account. AIQSA access is pending administrator approval.` };
  }
  const messages: Record<Exclude<SamlLoginOutcome, "pending">, string> = {
    account_conflict: `${label} could not be linked to an existing AIQSA account. Sign in another way or contact the operator.`,
    email_missing: `${label} did not send a usable email address. Ask the operator to check the SAML email attribute.`,
    failed: `${label} sign-in could not be completed. Try again or contact the operator.`,
    not_allowed: `This ${label} account is not allowed to access AIQSA.`,
    source_changed: `This account belongs to an earlier ${label} configuration. Ask an administrator to unlink it, then sign in again.`
  };
  return { error: `${messages[outcome]} (saml_${outcome})`, notice: null };
}

/** "Continue with …" for SAML, shaped like the OAuth buttons it stands beside. */
export function SamlSignInLink({
  className,
  disabled = false,
  label,
  nextPath
}: Readonly<{ className: string; disabled?: boolean; label: string; nextPath: string }>) {
  return (
    <a
      aria-disabled={disabled || undefined}
      className={`${className} ${disabled ? "pointer-events-none cursor-not-allowed opacity-60" : ""}`}
      data-testid="saml-sign-in"
      href={samlStartHref(nextPath)}
      tabIndex={disabled ? -1 : undefined}
    >
      <span
        aria-hidden="true"
        className="absolute left-3 grid size-6 place-items-center rounded-control bg-control-surface text-ink-secondary"
      >
        <KeyRound className="size-3.5" />
      </span>
      Continue with {label}
    </a>
  );
}
