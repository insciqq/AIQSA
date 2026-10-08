import { trustedHeaderSignInHref, type TrustedHeaderLoginOutcome } from "@/lib/auth/trustedHeader";
import { focusRingClassName } from "./authFormStyles";

/** What the login page knows about trusted-header sign-in; absent while it is not available. */
export type TrustedHeaderLoginProps = Readonly<{ outcome?: TrustedHeaderLoginOutcome }>;

const outcomeMessages: Record<TrustedHeaderLoginOutcome, Readonly<{ error: boolean; text: string }>> = {
  account_conflict: {
    error: true,
    text: "Your proxy sign-in could not be linked to an AIQSA account. Contact the operator."
  },
  failed: { error: true, text: "Sign-in through the proxy could not be completed. Try again." },
  invalid: {
    error: true,
    text: "The identity the proxy sent could not be read. Ask the operator to check the proxy's identity headers."
  },
  missing: {
    error: true,
    text: "The proxy in front of AIQSA did not provide an identity. Sign in at the proxy, or use another method."
  },
  not_allowed: { error: true, text: "This account is not allowed to access AIQSA." },
  pending: { error: false, text: "The proxy confirmed your account. AIQSA access is pending administrator approval." },
  source_changed: { error: true, text: "This identity belongs to an earlier sign-in setup. Contact the operator." },
  unavailable: { error: true, text: "Sign-in through the proxy is not available on this server." }
};

export function trustedHeaderOutcomeMessage(outcome: TrustedHeaderLoginOutcome): Readonly<{ error: boolean; text: string }> {
  const message = outcomeMessages[outcome];
  return message.error ? { error: true, text: `${message.text} (trusted_header_${outcome})` } : message;
}

/**
 * Shown on the login page while the trusted header can sign people in: the outcome of the last
 * attempt, if any, and a way back to it after `?local=1` or a refusal.
 */
export function TrustedHeaderSignIn({
  disabled = false,
  nextPath,
  outcome
}: TrustedHeaderLoginProps & Readonly<{ disabled?: boolean; nextPath: string }>) {
  const message = outcome ? trustedHeaderOutcomeMessage(outcome) : null;
  return (
    <div className="mt-5 grid gap-3" data-testid="trusted-header-sign-in">
      {message ? (
        <div className="flex items-start gap-3 border-y border-trace-subtle py-3.5">
          <span
            aria-hidden="true"
            className={`mt-2 size-1.5 shrink-0 rounded-full ${message.error ? "bg-critical" : "bg-positive"}`}
          />
          <p className={`text-sm leading-6 ${message.error ? "text-ink" : "text-ink-secondary"}`} role={message.error ? "alert" : "status"}>
            {message.text}
          </p>
        </div>
      ) : null}
      <a
        aria-disabled={disabled || undefined}
        className={`${focusRingClassName} flex min-h-touch w-full items-center justify-center rounded-control border border-control-boundary bg-answer-paper px-4 py-2 text-sm font-medium text-ink hover:bg-control-hover ${disabled ? "pointer-events-none cursor-not-allowed opacity-60" : ""}`}
        href={disabled ? undefined : trustedHeaderSignInHref(nextPath)}
        tabIndex={disabled ? -1 : undefined}
      >
        Continue with your proxy sign-in
      </a>
    </div>
  );
}
