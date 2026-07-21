"use client";

import {
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  LogIn,
  Mail,
  RotateCcw,
  ShieldCheck,
  UserPlus
} from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { safeInternalPath } from "@/lib/auth/internalPath";
import type { OAuthLoginOutcome, OAuthProviderId } from "@/lib/auth/oauth";

type AuthLoginProps = {
  inviteToken?: string;
  navigateAfterLogin?: (nextPath: string) => void;
  nextPath: string;
  oauthOutcome?: OAuthLoginOutcome;
  oauthProvider?: OAuthProviderId;
  oauthProviders?: OAuthProviderId[];
  resetToken?: string;
  verifyToken?: string;
};

type Mode = "check-email" | "password" | "register" | "reset-request" | "reset-complete" | "verify-email";

type PendingAction = "accept-invite" | "login" | "register" | "reset-complete" | "reset-request" | "verify";

type RegistrationOutcome = "request-received" | "verification-required";

type AuthPostResult = {
  error?: string;
  ok: boolean;
  status?: "active" | "pending" | "request_received" | "verification_required";
};

const fieldClassName =
  "h-touch w-full rounded-control border border-separator-strong bg-surface-thread px-3 text-[15px] text-content-primary caret-accent-cyan outline-none placeholder:text-content-disabled autofill:bg-surface-thread autofill:text-content-primary disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-70 focus:border-accent-cyan focus:ring-2 focus:ring-accent-cyan/25";

const focusRingClassName =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-surface-navigation";

const primaryButtonClassName = `${focusRingClassName} flex min-h-touch w-full items-center justify-center gap-2 rounded-control bg-accent-cyan px-4 py-2 text-sm font-semibold text-surface-canvas hover:bg-accent-cyan/90 disabled:cursor-not-allowed disabled:opacity-60`;

const secondaryButtonClassName = `${focusRingClassName} flex min-h-touch items-center justify-center rounded-control px-3 py-2 text-sm font-medium text-content-secondary hover:bg-surface-hover hover:text-content-primary disabled:cursor-not-allowed disabled:text-content-disabled`;

const oauthButtonClassName = `${focusRingClassName} flex min-h-touch w-full items-center justify-center rounded-control border border-separator-subtle bg-surface-raised px-3 py-2 text-sm font-medium text-content-primary hover:bg-surface-hover`;

function oauthProviderLabel(provider: OAuthProviderId | undefined): string {
  if (provider === "google") {
    return "Google";
  }

  if (provider === "yandex") {
    return "Yandex";
  }

  return "OAuth";
}

function oauthOutcomeMessage(
  outcome: OAuthLoginOutcome | undefined,
  provider: OAuthProviderId | undefined
): { error: string | null; notice: string | null } {
  if (!outcome) {
    return {
      error: null,
      notice: null
    };
  }

  const label = oauthProviderLabel(provider);

  if (outcome === "pending") {
    return {
      error: null,
      notice: `${label} confirmed your account. AIQSA access is pending administrator approval.`
    };
  }

  const messages: Record<Exclude<OAuthLoginOutcome, "pending">, string> = {
    account_conflict: `${label} could not be linked to this AIQSA account. Sign in another way or contact the operator.`,
    cancelled: `${label} sign-in was cancelled. You can try again.`,
    failed: `${label} sign-in could not be completed. Try again or use email and password.`,
    not_allowed: `This ${label} account is not allowed to access AIQSA.`
  };

  return {
    error: `${messages[outcome]} (oauth_${outcome})`,
    notice: null
  };
}

function oauthStartHref(provider: OAuthProviderId, nextPath: string): string {
  const query = new URLSearchParams({
    next: safeInternalPath(nextPath)
  });

  return `/api/auth/oauth/${provider}?${query.toString()}`;
}

function scrubAuthProofParameters() {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  const proofParameters = ["invite", "reset", "verify"];
  if (!proofParameters.some((parameter) => url.searchParams.has(parameter))) {
    return;
  }

  for (const parameter of proofParameters) {
    url.searchParams.delete(parameter);
  }
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  );
}

function AuthFeedback({ error, notice }: { error: string | null; notice: string | null }) {
  return (
    <>
      {notice ? (
        <p
          className="mt-4 max-w-[34rem] rounded-control border-l-2 border-accent-green bg-accent-green/10 px-4 py-3 text-sm leading-6 text-content-primary"
          role="status"
        >
          {notice}
        </p>
      ) : null}

      {error ? (
        <p
          className="mt-4 max-w-[34rem] rounded-control border-l-2 border-accent-rose bg-accent-rose/10 px-4 py-3 text-sm leading-6 text-content-primary"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </>
  );
}

function authErrorMessage(code: string): string {
  const messages: Record<string, string> = {
    auth_not_configured: "Authentication is not configured on this server.",
    credentials_required: "Enter email and password.",
    email_invalid: "Enter a valid email address.",
    email_required: "Enter an email address.",
    invalid_invite_token: "This invite link is invalid or expired.",
    invalid_or_expired_reset_token: "This reset link is invalid or expired.",
    invalid_or_expired_verification_token: "This verification link is invalid or expired.",
    network_error: "Could not reach the server. Check your connection and try again.",
    password_too_long: "Choose a shorter password.",
    password_too_short: "Use at least 8 characters.",
    rate_limited: "Too many attempts. Wait a bit before trying again.",
    registration_not_allowed: "This email or domain is not allowed to request access.",
    registration_required: "Enter an email address to request access.",
    invite_token_password_required: "Open the invite link and choose a password.",
    reset_token_password_required: "Enter a new password.",
    token_required: "Enter an access token.",
    unauthorized: "The credentials were not accepted.",
    verification_email_failed: "The server could not send the verification email. Ask the operator to check SMTP delivery.",
    verification_email_unavailable: "Verification email is not configured on this server. Ask the operator to configure SMTP.",
    verification_token_password_required: "Open the verification link and choose a password.",
    verification_token_required: "Open the verification link from your email."
  };

  return `${messages[code] ?? "Sign in failed."} (${code})`;
}

async function postJson(url: string, body: Record<string, unknown>): Promise<AuthPostResult> {
  const response = await fetch(url, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json"
    },
    method: "POST"
  });

  const data = (await response.json().catch(() => null)) as { error?: string; status?: AuthPostResult["status"] } | null;

  if (response.ok) {
    return {
      ok: true,
      status: data?.status
    };
  }

  return {
    error: data?.error ?? "login_failed",
    ok: false
  };
}

function PasswordVisibilityButton({
  disabled,
  inputId,
  onToggle,
  visible
}: {
  disabled: boolean;
  inputId: string;
  onToggle: () => void;
  visible: boolean;
}) {
  return (
    <button
      aria-controls={inputId}
      aria-label={visible ? "Hide password" : "Show password"}
      aria-pressed={visible}
      className={`${focusRingClassName} absolute inset-y-0 right-0 flex min-h-touch min-w-touch items-center justify-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary disabled:cursor-not-allowed disabled:text-content-disabled`}
      disabled={disabled}
      onClick={onToggle}
      type="button"
    >
      {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
    </button>
  );
}

export function AuthLogin({
  inviteToken,
  navigateAfterLogin,
  nextPath,
  oauthOutcome,
  oauthProvider,
  oauthProviders = [],
  resetToken,
  verifyToken
}: AuthLoginProps) {
  const initialOAuthMessage = oauthOutcomeMessage(oauthOutcome, oauthProvider);
  const [error, setError] = useState<string | null>(initialOAuthMessage.error);
  const [mode, setMode] = useState<Mode>(
    verifyToken ? "verify-email" : resetToken ? "reset-complete" : inviteToken ? "register" : "password"
  );
  const [notice, setNotice] = useState<string | null>(initialOAuthMessage.notice);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [registrationOutcome, setRegistrationOutcome] = useState<RegistrationOutcome>("request-received");
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const modeHeadingRef = useRef<HTMLHeadingElement>(null);
  const registerLabel = inviteToken ? "Create account" : "Request access";
  const submitting = pendingAction !== null;
  const showInitialOAuthFeedback =
    mode === "password" &&
    ((initialOAuthMessage.error !== null && error === initialOAuthMessage.error) ||
      (initialOAuthMessage.notice !== null && notice === initialOAuthMessage.notice));

  const screenCopy = (() => {
    if (mode === "password") {
      return {
        description: "Use the email and password for your active account.",
        eyebrow: "Account access",
        title: "Sign in"
      };
    }

    if (mode === "register") {
      return inviteToken
        ? {
            description: "This one-time invitation confirms your email. Choose your name and password to enter AIQSA.",
            eyebrow: "Invitation",
            title: "Create your account"
          }
        : {
            description: "Access requests are limited to approved emails or domains. Verification may be followed by admin approval.",
            eyebrow: "Private access",
            title: "Request access"
          };
    }

    if (mode === "check-email") {
      return {
        description:
          registrationOutcome === "verification-required"
            ? "Open the verification link to continue your access request."
            : "The response stays generic so account and delivery details remain private.",
        eyebrow: "Access request",
        title: registrationOutcome === "verification-required" ? "Check your email" : "Request received"
      };
    }

    if (mode === "verify-email") {
      return {
        description: "Choose a password to prove this email and finish the one-time verification link.",
        eyebrow: "Account verification",
        title: "Choose your password"
      };
    }

    if (mode === "reset-request") {
      return {
        description: "Enter your email. If an eligible account can reset, a link will be sent.",
        eyebrow: "Account recovery",
        title: "Reset your password"
      };
    }

    return {
      description: "Choose a new password with at least 8 characters. Existing sessions will be signed out.",
      eyebrow: "Account recovery",
      title: "Choose a new password"
    };
  })();

  const busyMessage = pendingAction
    ? {
        "accept-invite": "Creating account…",
        login: "Signing in…",
        register: "Sending access request…",
        "reset-complete": "Updating password…",
        "reset-request": "Requesting reset link…",
        verify: "Setting your password…"
      }[pendingAction]
    : null;

  function switchMode(nextMode: Mode) {
    if (submitting) {
      return;
    }

    if (nextMode === "password") {
      scrubAuthProofParameters();
    }

    setError(null);
    setNotice(null);
    setPasswordVisible(false);
    setMode(nextMode);
  }

  useEffect(() => {
    if (submitting) {
      return;
    }

    if (mode === "check-email") {
      modeHeadingRef.current?.focus({ preventScroll: true });
      return;
    }

    firstFieldRef.current?.focus({ preventScroll: true });
  }, [mode, submitting]);

  async function submitPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const email = String(formData.get("email") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    setError(null);
    setNotice(null);

    if (!email || !password) {
      setError(authErrorMessage("credentials_required"));
      return;
    }

    setPendingAction("login");

    try {
      const result = await postJson("/api/auth/login", { email, password });

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "unauthorized"));
        return;
      }

      const redirectTarget = safeInternalPath(nextPath, window.location.origin);
      (navigateAfterLogin ?? window.location.assign.bind(window.location))(redirectTarget);
    } catch {
      setError(authErrorMessage("network_error"));
    } finally {
      setPendingAction(null);
    }
  }

  async function submitResetRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    setError(null);
    setNotice(null);

    if (!email) {
      setError(authErrorMessage("email_required"));
      return;
    }

    setPendingAction("reset-request");

    try {
      const result = await postJson("/api/auth/password-reset/request", { email });

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "login_failed"));
        return;
      }

      setNotice("If the account can reset, a link has been sent.");
    } catch {
      setError(authErrorMessage("network_error"));
    } finally {
      setPendingAction(null);
    }
  }

  async function submitResetComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setError(null);
    setNotice(null);

    if (!password || !resetToken) {
      setError(authErrorMessage("reset_token_password_required"));
      return;
    }

    setPendingAction("reset-complete");

    try {
      const result = await postJson("/api/auth/password-reset/complete", {
        password,
        token: resetToken
      });

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "login_failed"));
        return;
      }

      setPasswordVisible(false);
      scrubAuthProofParameters();
      setMode("password");
      setNotice("Password updated. Sign in to continue.");
    } catch {
      setError(authErrorMessage("network_error"));
    } finally {
      setPendingAction(null);
    }
  }

  async function submitRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const displayName = String(formData.get("displayName") ?? "").trim();
    const email = String(formData.get("email") ?? "").trim();
    setError(null);
    setNotice(null);

    if (!email) {
      setError(authErrorMessage("registration_required"));
      return;
    }

    setPendingAction("register");

    try {
      const result = await postJson("/api/auth/register", {
        displayName,
        email
      });

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "login_failed"));
        return;
      }

      setRegistrationOutcome(result.status === "verification_required" ? "verification-required" : "request-received");
      setMode("check-email");
    } catch {
      setError(authErrorMessage("network_error"));
    } finally {
      setPendingAction(null);
    }
  }

  async function submitInviteAcceptance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const displayName = String(formData.get("displayName") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    setError(null);
    setNotice(null);

    if (!password || !inviteToken) {
      setError(authErrorMessage("invite_token_password_required"));
      return;
    }

    setPendingAction("accept-invite");

    try {
      const result = await postJson("/api/auth/invite/accept", {
        displayName,
        password,
        token: inviteToken
      });

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "invalid_invite_token"));
        return;
      }

      const redirectTarget = safeInternalPath(nextPath, window.location.origin);
      scrubAuthProofParameters();
      (navigateAfterLogin ?? window.location.assign.bind(window.location))(redirectTarget);
    } catch {
      setError(authErrorMessage("network_error"));
    } finally {
      setPendingAction(null);
    }
  }

  async function submitEmailVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setError(null);
    setNotice(null);

    if (!password || !verifyToken) {
      setError(authErrorMessage("verification_token_password_required"));
      return;
    }

    setPendingAction("verify");

    try {
      const result = await postJson("/api/auth/verify-email", {
        password,
        token: verifyToken
      });

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "invalid_or_expired_verification_token"));
        return;
      }

      setPasswordVisible(false);
      scrubAuthProofParameters();
      setMode("password");
      setNotice(
        result.status === "active"
          ? "Email verified and password set. Your account is active. Sign in to continue."
          : "Email verified and password set. Access is pending admin approval."
      );
    } catch {
      setError(authErrorMessage("network_error"));
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <main className="grid min-h-[100dvh] place-items-start pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] text-content-primary sm:place-items-center sm:pb-[max(2rem,env(safe-area-inset-bottom))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-[max(2rem,env(safe-area-inset-top))] [@media(max-height:32rem)]:!place-items-start [@media(max-height:32rem)]:!pb-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!pl-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!pr-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!pt-[max(.5rem,env(safe-area-inset-top))]">
      <section
        aria-labelledby="auth-screen-title"
        className="relative isolate w-full max-w-[42rem] overflow-hidden rounded-panel border border-separator-subtle bg-surface-navigation"
      >
        <header className="relative z-10 flex items-center gap-3 border-b border-separator-subtle bg-surface-navigation px-5 py-4 sm:px-8 sm:py-5 [@media(max-height:32rem)]:!px-5 [@media(max-height:32rem)]:!py-2">
          <div className="grid size-10 shrink-0 place-items-center rounded-control bg-surface-active text-accent-cyan [@media(max-height:32rem)]:!size-8">
            <KeyRound className="size-[18px]" aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <p className="text-base font-semibold tracking-[-0.01em]">AIQSA</p>
            <p className="text-sm text-content-muted">Private workspace access</p>
          </div>
          <ShieldCheck className="ml-auto size-[18px] shrink-0 text-content-muted" aria-hidden="true" />
        </header>

        <div className="px-5 py-6 sm:px-8 sm:py-8 [@media(max-height:32rem)]:!px-5 [@media(max-height:32rem)]:!py-2">
          <div className="max-w-[34rem]">
            <p className="text-xs font-medium text-accent-cyan">{screenCopy.eyebrow}</p>
            <h1
              className="mt-2 text-2xl font-semibold tracking-[-0.02em] focus:outline-none sm:text-[28px] [@media(max-height:32rem)]:!mt-1 [@media(max-height:32rem)]:!text-xl"
              id="auth-screen-title"
              ref={modeHeadingRef}
              tabIndex={-1}
            >
              {screenCopy.title}
            </h1>
            <p className="mt-2 text-sm leading-6 text-content-secondary [@media(max-height:32rem)]:!mt-1 [@media(max-height:32rem)]:!text-xs [@media(max-height:32rem)]:!leading-5">{screenCopy.description}</p>
          </div>

          {showInitialOAuthFeedback ? <AuthFeedback error={error} notice={notice} /> : null}

          {mode === "password" ? (
            <form aria-busy={submitting} className="mt-6 max-w-[34rem] space-y-5" noValidate onSubmit={submitPassword}>
              {oauthProviders.length ? (
                <div className="space-y-4">
                  <div className={`grid gap-2 ${oauthProviders.length > 1 ? "sm:grid-cols-2" : ""}`}>
                    {oauthProviders.map((provider) => (
                      <a
                        aria-disabled={submitting || undefined}
                        className={`${oauthButtonClassName} ${submitting ? "pointer-events-none cursor-not-allowed opacity-60" : ""}`}
                        href={oauthStartHref(provider, nextPath)}
                        key={provider}
                        tabIndex={submitting ? -1 : undefined}
                      >
                        Continue with {oauthProviderLabel(provider)}
                      </a>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-content-muted" aria-hidden="true">
                    <span className="h-px flex-1 bg-separator-subtle" />
                    <span>or use email</span>
                    <span className="h-px flex-1 bg-separator-subtle" />
                  </div>
                </div>
              ) : null}

              <div>
                <label className="mb-2 block text-sm font-medium text-content-primary" htmlFor="email">
                  Email
                </label>
                <input
                  autoCapitalize="none"
                  autoComplete="email"
                  className={fieldClassName}
                  disabled={submitting}
                  id="email"
                  inputMode="email"
                  name="email"
                  ref={firstFieldRef}
                  required
                  spellCheck={false}
                  type="email"
                />
              </div>

              <div>
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <label className="text-sm font-medium text-content-primary" htmlFor="password">
                    Password
                  </label>
                  <span className="text-xs text-content-muted" id="password-help">
                    Case-sensitive
                  </span>
                </div>
                <div className="relative">
                  <input
                    aria-describedby="password-help"
                    autoComplete="current-password"
                    className={`${fieldClassName} pr-14`}
                    disabled={submitting}
                    id="password"
                    name="password"
                    required
                    type={passwordVisible ? "text" : "password"}
                  />
                  <PasswordVisibilityButton
                    disabled={submitting}
                    inputId="password"
                    onToggle={() => setPasswordVisible((visible) => !visible)}
                    visible={passwordVisible}
                  />
                </div>
              </div>

              <button className={primaryButtonClassName} disabled={submitting} type="submit">
                {submitting ? (
                  <LoaderCircle className="size-4" aria-hidden="true" />
                ) : (
                  <LogIn className="size-4" aria-hidden="true" />
                )}
                {pendingAction === "login" ? "Signing in…" : "Sign in"}
              </button>

              <div className="grid gap-2 border-t border-separator-subtle pt-3 sm:grid-cols-2">
                <button
                  className={secondaryButtonClassName}
                  disabled={submitting}
                  onClick={() => switchMode("reset-request")}
                  type="button"
                >
                  Reset password
                </button>
                <button
                  className={secondaryButtonClassName}
                  disabled={submitting}
                  onClick={() => switchMode("register")}
                  type="button"
                >
                  {registerLabel}
                </button>
              </div>
            </form>
          ) : null}

          {mode === "register" ? (
            <form
              aria-busy={submitting}
              className="mt-6 max-w-[34rem] space-y-5 sm:[@media(max-height:45rem)]:mt-3 sm:[@media(max-height:45rem)]:grid sm:[@media(max-height:45rem)]:grid-cols-2 sm:[@media(max-height:45rem)]:gap-x-3 sm:[@media(max-height:45rem)]:gap-y-3 sm:[@media(max-height:45rem)]:space-y-0"
              data-testid="register-form"
              noValidate
              onSubmit={inviteToken ? submitInviteAcceptance : submitRegister}
            >
              <div>
                <label className="mb-2 block text-sm font-medium text-content-primary" htmlFor="register-name">
                  Name
                </label>
                <input
                  aria-describedby="register-name-help"
                  autoComplete="name"
                  className={fieldClassName}
                  disabled={submitting}
                  id="register-name"
                  name="displayName"
                  ref={firstFieldRef}
                  type="text"
                />
                <p className="mt-2 text-xs leading-5 text-content-muted" id="register-name-help">
                  Optional. This is how your name appears in AIQSA.
                </p>
              </div>

              {inviteToken ? (
                <div>
                  <label className="mb-2 block text-sm font-medium text-content-primary" htmlFor="invite-password">
                    Password
                  </label>
                  <div className="relative">
                    <input
                      aria-describedby="invite-password-help"
                      autoComplete="new-password"
                      className={`${fieldClassName} pr-14`}
                      disabled={submitting}
                      id="invite-password"
                      name="password"
                      required
                      type={passwordVisible ? "text" : "password"}
                    />
                    <PasswordVisibilityButton
                      disabled={submitting}
                      inputId="invite-password"
                      onToggle={() => setPasswordVisible((visible) => !visible)}
                      visible={passwordVisible}
                    />
                  </div>
                  <p className="mt-2 text-xs leading-5 text-content-muted" id="invite-password-help">
                    Use at least 8 characters. The invitation works only once.
                  </p>
                </div>
              ) : (
                <div>
                  <label className="mb-2 block text-sm font-medium text-content-primary" htmlFor="register-email">
                    Email
                  </label>
                  <input
                    aria-describedby="register-email-help"
                    autoCapitalize="none"
                    autoComplete="email"
                    className={fieldClassName}
                    disabled={submitting}
                    id="register-email"
                    inputMode="email"
                    name="email"
                    required
                    spellCheck={false}
                    type="email"
                  />
                  <p className="mt-2 text-xs leading-5 text-content-muted" id="register-email-help">
                    Use an address approved by the operator.
                  </p>
                </div>
              )}

              <button
                className={`${primaryButtonClassName} sm:[@media(max-height:45rem)]:self-end`}
                disabled={submitting}
                type="submit"
              >
                {submitting ? (
                  <LoaderCircle className="size-4" aria-hidden="true" />
                ) : (
                  <UserPlus className="size-4" aria-hidden="true" />
                )}
                {pendingAction === "register" || pendingAction === "accept-invite" ? busyMessage : registerLabel}
              </button>
              <button
                className={`${secondaryButtonClassName} w-full`}
                disabled={submitting}
                onClick={() => switchMode("password")}
                type="button"
              >
                Back to sign in
              </button>
            </form>
          ) : null}

          {mode === "check-email" ? (
            <div className="mt-6 max-w-[34rem]">
              <div className="rounded-control border-l-2 border-accent-green bg-accent-green/10 px-4 py-4" role="status">
                <div className="flex items-start gap-3">
                  {registrationOutcome === "verification-required" ? (
                    <Mail className="mt-0.5 size-[18px] shrink-0 text-accent-green" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 size-[18px] shrink-0 text-accent-green" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium text-content-primary">Your access request is recorded.</p>
                    <p className="mt-1 text-sm leading-6 text-content-secondary">
                      Request received. If verification is needed, use the email link before signing in.
                    </p>
                  </div>
                </div>
              </div>
              <button className={`${primaryButtonClassName} mt-5`} onClick={() => switchMode("password")} type="button">
                <LogIn className="size-4" aria-hidden="true" />
                Back to sign in
              </button>
            </div>
          ) : null}

          {mode === "verify-email" ? (
            <form aria-busy={submitting} className="mt-6 max-w-[34rem] space-y-5" noValidate onSubmit={submitEmailVerification}>
              <div>
                <label className="mb-2 block text-sm font-medium text-content-primary" htmlFor="verification-password">
                  New password
                </label>
                <div className="relative">
                  <input
                    aria-describedby="verification-password-help"
                    autoComplete="new-password"
                    className={`${fieldClassName} pr-14`}
                    disabled={submitting}
                    id="verification-password"
                    name="password"
                    ref={firstFieldRef}
                    required
                    type={passwordVisible ? "text" : "password"}
                  />
                  <PasswordVisibilityButton
                    disabled={submitting}
                    inputId="verification-password"
                    onToggle={() => setPasswordVisible((visible) => !visible)}
                    visible={passwordVisible}
                  />
                </div>
                <p className="mt-2 text-xs leading-5 text-content-muted" id="verification-password-help">
                  Use at least 8 characters. The link works only once.
                </p>
              </div>
              <button className={primaryButtonClassName} disabled={submitting} type="submit">
                <ShieldCheck className="size-4" aria-hidden="true" />
                {pendingAction === "verify" ? "Setting password…" : "Set password and verify"}
              </button>
              <button
                className={`${secondaryButtonClassName} w-full`}
                disabled={submitting}
                onClick={() => switchMode("password")}
                type="button"
              >
                Back to sign in
              </button>
            </form>
          ) : null}

          {mode === "reset-request" ? (
            <form aria-busy={submitting} className="mt-6 max-w-[34rem] space-y-5" noValidate onSubmit={submitResetRequest}>
              <div>
                <label className="mb-2 block text-sm font-medium text-content-primary" htmlFor="reset-email">
                  Email
                </label>
                <input
                  aria-describedby="reset-email-help"
                  autoCapitalize="none"
                  autoComplete="email"
                  className={fieldClassName}
                  disabled={submitting}
                  id="reset-email"
                  inputMode="email"
                  name="email"
                  ref={firstFieldRef}
                  required
                  spellCheck={false}
                  type="email"
                />
                <p className="mt-2 text-xs leading-5 text-content-muted" id="reset-email-help">
                  For privacy, the result is the same whether or not an eligible account exists.
                </p>
              </div>

              <button className={primaryButtonClassName} disabled={submitting} type="submit">
                <Mail className="size-4" aria-hidden="true" />
                {pendingAction === "reset-request" ? "Requesting reset link…" : "Send reset link"}
              </button>
              <button
                className={`${secondaryButtonClassName} w-full`}
                disabled={submitting}
                onClick={() => switchMode("password")}
                type="button"
              >
                Back to sign in
              </button>
            </form>
          ) : null}

          {mode === "reset-complete" ? (
            <form aria-busy={submitting} className="mt-6 max-w-[34rem] space-y-5" noValidate onSubmit={submitResetComplete}>
              <div>
                <label className="mb-2 block text-sm font-medium text-content-primary" htmlFor="new-password">
                  New password
                </label>
                <div className="relative">
                  <input
                    aria-describedby="new-password-help"
                    autoComplete="new-password"
                    className={`${fieldClassName} pr-14`}
                    disabled={submitting}
                    id="new-password"
                    name="password"
                    ref={firstFieldRef}
                    required
                    type={passwordVisible ? "text" : "password"}
                  />
                  <PasswordVisibilityButton
                    disabled={submitting}
                    inputId="new-password"
                    onToggle={() => setPasswordVisible((visible) => !visible)}
                    visible={passwordVisible}
                  />
                </div>
                <p className="mt-2 text-xs leading-5 text-content-muted" id="new-password-help">
                  Use at least 8 characters. This link works only once.
                </p>
              </div>

              <button className={primaryButtonClassName} disabled={submitting} type="submit">
                <RotateCcw className="size-4" aria-hidden="true" />
                {pendingAction === "reset-complete" ? "Updating password…" : "Update password"}
              </button>
              <button
                className={`${secondaryButtonClassName} w-full`}
                disabled={submitting}
                onClick={() => switchMode("password")}
                type="button"
              >
                Back to sign in
              </button>
            </form>
          ) : null}

          {busyMessage ? (
            <p
              aria-live="polite"
              className="mt-4 flex max-w-[34rem] items-center gap-2 text-sm text-content-secondary"
              role="status"
            >
              <LoaderCircle className="size-4 shrink-0 text-accent-cyan" aria-hidden="true" />
              {busyMessage}
            </p>
          ) : null}

          {!showInitialOAuthFeedback ? <AuthFeedback error={error} notice={notice} /> : null}
        </div>
      </section>
    </main>
  );
}
