"use client";

import {
  CheckCircle2,
  Eye,
  EyeOff,
  LoaderCircle,
  Mail
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
  sessionExpired?: boolean;
  verifyToken?: string;
};

type Mode = "check-email" | "password" | "register" | "reset-request" | "reset-complete" | "verify-email";

type ActiveAuthProof =
  | { kind: "invite"; token: string }
  | { kind: "reset"; token: string }
  | { kind: "verify"; token: string }
  | null;

type PendingAction = "accept-invite" | "login" | "register" | "reset-complete" | "reset-request" | "verify";

type RegistrationOutcome = "request-received" | "verification-required";

type AuthPostResult = {
  error?: string;
  ok: boolean;
  status?: "active" | "pending" | "request_received" | "verification_required";
};

type AuthRequestGeneration = {
  proof: number;
  request: number;
};

const fieldClassName =
  "h-touch w-full rounded-control border border-trace-strong bg-answer-paper px-3.5 text-[15px] text-ink caret-proof outline-none placeholder:text-ink-disabled autofill:bg-answer-paper autofill:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-70 focus:border-proof focus:ring-2 focus:ring-proof/20";

const invalidFieldClassName =
  "border-critical/60 focus:border-critical focus:ring-critical/20";

const focusRingClassName =
  "outline-none focus-visible:ring-2 focus-visible:ring-proof/55 focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper";

const primaryButtonClassName = `${focusRingClassName} flex min-h-touch w-full items-center justify-center gap-2 rounded-control bg-proof px-4 py-2 text-sm font-semibold text-proof-contrast hover:bg-proof-hover disabled:cursor-not-allowed disabled:opacity-60`;

const secondaryButtonClassName = `${focusRingClassName} flex min-h-touch items-center justify-center rounded-control px-3 py-2 text-sm font-medium text-ink-secondary hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled`;

const oauthButtonClassName = `${focusRingClassName} relative flex min-h-touch w-full items-center justify-center rounded-control border border-trace-strong bg-answer-paper px-10 py-2 text-sm font-medium text-ink hover:bg-control-hover`;

const formClassName =
  "mt-7 space-y-5 [@media(max-height:32rem)]:!mt-3 [@media(max-height:32rem)]:!space-y-3";

function oauthProviderLabel(provider: OAuthProviderId | undefined): string {
  if (provider === "google") {
    return "Google";
  }

  if (provider === "yandex") {
    return "Yandex";
  }

  return "OAuth";
}

function oauthProviderInitial(provider: OAuthProviderId): string {
  return provider === "google" ? "G" : "Y";
}

function initialAuthProof({
  inviteToken,
  resetToken,
  verifyToken
}: Pick<AuthLoginProps, "inviteToken" | "resetToken" | "verifyToken">): ActiveAuthProof {
  if (verifyToken) {
    return { kind: "verify", token: verifyToken };
  }
  if (resetToken) {
    return { kind: "reset", token: resetToken };
  }
  if (inviteToken) {
    return { kind: "invite", token: inviteToken };
  }
  return null;
}

function modeForAuthProof(proof: ActiveAuthProof): Mode {
  if (proof?.kind === "verify") {
    return "verify-email";
  }
  if (proof?.kind === "reset") {
    return "reset-complete";
  }
  if (proof?.kind === "invite") {
    return "register";
  }
  return "password";
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

function initialAuthFeedback(
  sessionExpired: boolean | undefined,
  outcome: OAuthLoginOutcome | undefined,
  provider: OAuthProviderId | undefined
): { error: string | null; notice: string | null } {
  const oauthMessage = oauthOutcomeMessage(outcome, provider);
  if (oauthMessage.error || oauthMessage.notice || !sessionExpired) {
    return oauthMessage;
  }

  return {
    error: "Your session ended or was revoked. Sign in again to continue. (session_expired)",
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

function AuthFeedback({
  adjacent = false,
  error,
  feedbackId,
  notice
}: {
  adjacent?: boolean;
  error: string | null;
  feedbackId?: string;
  notice: string | null;
}) {
  const marginClassName = adjacent ? "" : "mt-5";

  return (
    <>
      {notice ? (
        <div className={`${marginClassName} flex items-start gap-3 border-y border-trace-subtle py-3.5`}>
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-positive" aria-hidden="true" />
          <p className="text-sm leading-6 text-ink-secondary" id={feedbackId} role="status">
            {notice}
          </p>
        </div>
      ) : null}

      {error ? (
        <div className={`${marginClassName} flex items-start gap-3 border-y border-trace-subtle py-3.5`}>
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-critical" aria-hidden="true" />
          <p className="text-sm leading-6 text-ink" id={feedbackId} role="alert">
            {error}
          </p>
        </div>
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
      className={`${focusRingClassName} absolute inset-y-0 right-0 flex min-h-touch min-w-touch items-center justify-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled`}
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
  sessionExpired,
  verifyToken
}: AuthLoginProps) {
  const initialFeedback = initialAuthFeedback(sessionExpired, oauthOutcome, oauthProvider);
  const proofInputKey = JSON.stringify([verifyToken ?? null, resetToken ?? null, inviteToken ?? null]);
  const previousProofInputKeyRef = useRef(proofInputKey);
  const proofGenerationRef = useRef(0);
  const requestGenerationRef = useRef(0);
  const [activeProof, setActiveProof] = useState<ActiveAuthProof>(() =>
    initialAuthProof({ inviteToken, resetToken, verifyToken })
  );
  const [error, setError] = useState<string | null>(initialFeedback.error);
  const [loginFieldErrorCode, setLoginFieldErrorCode] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>(() => modeForAuthProof(activeProof));
  const [notice, setNotice] = useState<string | null>(initialFeedback.notice);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [proofSessionGeneration, setProofSessionGeneration] = useState(0);
  const [registrationOutcome, setRegistrationOutcome] = useState<RegistrationOutcome>("request-received");
  const submitting = pendingAction !== null;
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const modeHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousModeRef = useRef<Mode | null>(mode === "password" ? mode : null);
  const previousSubmittingRef = useRef(submitting);
  const activeInviteToken = activeProof?.kind === "invite" ? activeProof.token : null;
  const activeResetToken = activeProof?.kind === "reset" ? activeProof.token : null;
  const activeVerifyToken = activeProof?.kind === "verify" ? activeProof.token : null;
  const registerLabel = activeInviteToken ? "Create account" : "Request access";
  const showInitialAuthFeedback =
    mode === "password" &&
    ((initialFeedback.error !== null && error === initialFeedback.error) ||
      (initialFeedback.notice !== null && notice === initialFeedback.notice));
  const loginEmailInvalid =
    loginFieldErrorCode === "credentials_required" ||
    loginFieldErrorCode === "email_invalid" ||
    loginFieldErrorCode === "email_required" ||
    loginFieldErrorCode === "unauthorized";
  const loginPasswordInvalid =
    loginFieldErrorCode === "credentials_required" ||
    loginFieldErrorCode === "unauthorized";

  useEffect(() => {
    if (proofInputKey === previousProofInputKeyRef.current) {
      return;
    }

    previousProofInputKeyRef.current = proofInputKey;
    requestGenerationRef.current += 1;
    proofGenerationRef.current += 1;
    const nextProof = initialAuthProof({ inviteToken, resetToken, verifyToken });
    setActiveProof(nextProof);
    setError(null);
    setLoginFieldErrorCode(null);
    setNotice(null);
    setPendingAction(null);
    setPasswordVisible(false);
    setProofSessionGeneration(proofGenerationRef.current);
    setMode(modeForAuthProof(nextProof));
  }, [inviteToken, proofInputKey, resetToken, verifyToken]);

  const screenCopy = (() => {
    if (mode === "password") {
      return {
        description: "Use the email and password for your active account.",
        eyebrow: "Account access",
        title: "Sign in"
      };
    }

    if (mode === "register") {
      return activeInviteToken
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

  function beginRequest(): AuthRequestGeneration {
    requestGenerationRef.current += 1;
    return {
      proof: proofGenerationRef.current,
      request: requestGenerationRef.current
    };
  }

  function requestIsCurrent(owner: AuthRequestGeneration, proofBound = false): boolean {
    return (
      owner.request === requestGenerationRef.current &&
      (!proofBound || owner.proof === proofGenerationRef.current)
    );
  }

  function switchMode(nextMode: Mode) {
    if (submitting) {
      return;
    }

    if (nextMode === "password") {
      scrubAuthProofParameters();
      setActiveProof(null);
    }

    setError(null);
    setLoginFieldErrorCode(null);
    setNotice(null);
    setPasswordVisible(false);
    setMode(nextMode);
  }

  useEffect(() => {
    const modeChanged = previousModeRef.current !== mode;
    const requestSettled = previousSubmittingRef.current && !submitting;
    previousModeRef.current = mode;
    previousSubmittingRef.current = submitting;

    if (submitting) {
      return;
    }
    if (!modeChanged && !requestSettled) {
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
    setLoginFieldErrorCode(null);
    setNotice(null);

    if (!email || !password) {
      setLoginFieldErrorCode("credentials_required");
      setError(authErrorMessage("credentials_required"));
      return;
    }

    const owner = beginRequest();
    setPendingAction("login");

    try {
      const result = await postJson("/api/auth/login", { email, password });
      if (!requestIsCurrent(owner)) {
        return;
      }

      if (!result.ok) {
        const errorCode = result.error ?? "unauthorized";
        setLoginFieldErrorCode(errorCode);
        setError(authErrorMessage(errorCode));
        return;
      }

      const redirectTarget = safeInternalPath(nextPath, window.location.origin);
      (navigateAfterLogin ?? window.location.assign.bind(window.location))(redirectTarget);
    } catch {
      if (requestIsCurrent(owner)) {
        setLoginFieldErrorCode(null);
        setError(authErrorMessage("network_error"));
      }
    } finally {
      if (requestIsCurrent(owner)) {
        setPendingAction(null);
      }
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

    const owner = beginRequest();
    setPendingAction("reset-request");

    try {
      const result = await postJson("/api/auth/password-reset/request", { email });
      if (!requestIsCurrent(owner)) {
        return;
      }

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "login_failed"));
        return;
      }

      setNotice("If the account can reset, a link has been sent.");
    } catch {
      if (requestIsCurrent(owner)) {
        setError(authErrorMessage("network_error"));
      }
    } finally {
      if (requestIsCurrent(owner)) {
        setPendingAction(null);
      }
    }
  }

  async function submitResetComplete(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setError(null);
    setNotice(null);

    if (!password || !activeResetToken) {
      setError(authErrorMessage("reset_token_password_required"));
      return;
    }

    const owner = beginRequest();
    setPendingAction("reset-complete");

    try {
      const result = await postJson("/api/auth/password-reset/complete", {
        password,
        token: activeResetToken
      });
      if (!requestIsCurrent(owner, true)) {
        return;
      }

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "login_failed"));
        return;
      }

      setPasswordVisible(false);
      scrubAuthProofParameters();
      setActiveProof(null);
      setMode("password");
      setNotice("Password updated. Sign in to continue.");
    } catch {
      if (requestIsCurrent(owner, true)) {
        setError(authErrorMessage("network_error"));
      }
    } finally {
      if (requestIsCurrent(owner, true)) {
        setPendingAction(null);
      }
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

    const owner = beginRequest();
    setPendingAction("register");

    try {
      const result = await postJson("/api/auth/register", {
        displayName,
        email
      });
      if (!requestIsCurrent(owner)) {
        return;
      }

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "login_failed"));
        return;
      }

      setRegistrationOutcome(result.status === "verification_required" ? "verification-required" : "request-received");
      setMode("check-email");
    } catch {
      if (requestIsCurrent(owner)) {
        setError(authErrorMessage("network_error"));
      }
    } finally {
      if (requestIsCurrent(owner)) {
        setPendingAction(null);
      }
    }
  }

  async function submitInviteAcceptance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const displayName = String(formData.get("displayName") ?? "").trim();
    const password = String(formData.get("password") ?? "");
    setError(null);
    setNotice(null);

    if (!password || !activeInviteToken) {
      setError(authErrorMessage("invite_token_password_required"));
      return;
    }

    const owner = beginRequest();
    setPendingAction("accept-invite");

    try {
      const result = await postJson("/api/auth/invite/accept", {
        displayName,
        password,
        token: activeInviteToken
      });
      if (!requestIsCurrent(owner, true)) {
        return;
      }

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "invalid_invite_token"));
        return;
      }

      const redirectTarget = safeInternalPath(nextPath, window.location.origin);
      scrubAuthProofParameters();
      setActiveProof(null);
      (navigateAfterLogin ?? window.location.assign.bind(window.location))(redirectTarget);
    } catch {
      if (requestIsCurrent(owner, true)) {
        setError(authErrorMessage("network_error"));
      }
    } finally {
      if (requestIsCurrent(owner, true)) {
        setPendingAction(null);
      }
    }
  }

  async function submitEmailVerification(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const password = String(new FormData(event.currentTarget).get("password") ?? "");
    setError(null);
    setNotice(null);

    if (!password || !activeVerifyToken) {
      setError(authErrorMessage("verification_token_password_required"));
      return;
    }

    const owner = beginRequest();
    setPendingAction("verify");

    try {
      const result = await postJson("/api/auth/verify-email", {
        password,
        token: activeVerifyToken
      });
      if (!requestIsCurrent(owner, true)) {
        return;
      }

      if (!result.ok) {
        setError(authErrorMessage(result.error ?? "invalid_or_expired_verification_token"));
        return;
      }

      setPasswordVisible(false);
      scrubAuthProofParameters();
      setActiveProof(null);
      setMode("password");
      setNotice(
        result.status === "active"
          ? "Email verified and password set. Your account is active. Sign in to continue."
          : "Email verified and password set. Access is pending admin approval."
      );
    } catch {
      if (requestIsCurrent(owner, true)) {
        setError(authErrorMessage("network_error"));
      }
    } finally {
      if (requestIsCurrent(owner, true)) {
        setPendingAction(null);
      }
    }
  }

  return (
    <main
      className="grid min-h-[100dvh] overflow-x-hidden bg-answer-paper pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] text-ink sm:pb-[max(2rem,env(safe-area-inset-bottom))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] sm:pt-[max(2rem,env(safe-area-inset-top))] [@media(max-height:32rem)]:!pb-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!pl-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!pr-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!pt-[max(.5rem,env(safe-area-inset-top))]"
      data-testid="auth-root"
    >
      <section
        aria-labelledby="auth-screen-title"
        className="mx-auto flex w-full max-w-[42rem] flex-col self-stretch"
        data-auth-mode={mode}
        data-testid="auth-workspace"
      >
        <header className="flex shrink-0 items-center justify-between gap-6 border-b border-trace-subtle pb-4 [@media(max-height:32rem)]:!pb-2">
          <div className="min-w-0">
            <p className="text-xl font-semibold tracking-[-0.035em]">AIQSA</p>
            <p className="mt-0.5 text-xs text-ink-muted">Research workspace</p>
          </div>
          <p className="hidden shrink-0 text-xs font-medium text-ink-muted sm:block">
            Question <span className="px-1.5 text-proof">→</span> Search <span className="px-1.5 text-proof">→</span> Answer
          </p>
        </header>

        <div className="flex flex-1 items-center py-8 sm:py-10 [@media(max-height:32rem)]:!items-start [@media(max-height:32rem)]:!py-3">
          <div className="mx-auto w-full max-w-[30rem]">
            <p className="text-xs font-medium text-proof">{screenCopy.eyebrow}</p>
            <h1
              className="mt-2 text-[28px] font-semibold leading-tight tracking-[-0.035em] text-ink focus:outline-none [@media(max-height:32rem)]:!mt-1 [@media(max-height:32rem)]:!text-2xl"
              id="auth-screen-title"
              ref={modeHeadingRef}
              tabIndex={-1}
            >
              {screenCopy.title}
            </h1>
            <p className="mt-2 text-sm leading-6 text-ink-secondary [@media(max-height:32rem)]:!mt-1 [@media(max-height:32rem)]:!text-xs [@media(max-height:32rem)]:!leading-5">{screenCopy.description}</p>

            {showInitialAuthFeedback ? <AuthFeedback error={error} notice={notice} /> : null}

          {mode === "password" ? (
            <form aria-busy={submitting} className={formClassName} noValidate onSubmit={submitPassword}>
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
                        <span
                          aria-hidden="true"
                          className="absolute left-3 grid size-6 place-items-center rounded-control bg-control-surface text-incidental font-semibold text-ink-secondary"
                        >
                          {oauthProviderInitial(provider)}
                        </span>
                        Continue with {oauthProviderLabel(provider)}
                      </a>
                    ))}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-ink-muted" aria-hidden="true">
                    <span className="h-px flex-1 bg-trace-subtle" />
                    <span>or use email</span>
                    <span className="h-px flex-1 bg-trace-subtle" />
                  </div>
                </div>
              ) : null}

              <div>
                <label className="mb-2 block text-sm font-medium text-ink" htmlFor="email">
                  Email
                </label>
                <input
                  aria-describedby={loginEmailInvalid ? "login-feedback" : undefined}
                  aria-errormessage={loginEmailInvalid ? "login-feedback" : undefined}
                  aria-invalid={loginEmailInvalid || undefined}
                  autoCapitalize="none"
                  autoComplete="email"
                  className={`${fieldClassName} ${loginEmailInvalid ? invalidFieldClassName : ""}`}
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
                  <label className="text-sm font-medium text-ink" htmlFor="password">
                    Password
                  </label>
                  <span className="text-xs text-ink-muted" id="password-help">
                    Case-sensitive
                  </span>
                </div>
                <div className="relative">
                  <input
                    aria-describedby={loginPasswordInvalid ? "password-help login-feedback" : "password-help"}
                    aria-errormessage={loginPasswordInvalid ? "login-feedback" : undefined}
                    aria-invalid={loginPasswordInvalid || undefined}
                    autoComplete="current-password"
                    className={`${fieldClassName} pr-14 ${loginPasswordInvalid ? invalidFieldClassName : ""}`}
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
                  <LoaderCircle
                    className="size-4 animate-spin"
                    data-testid="auth-submit-spinner"
                    aria-hidden="true"
                  />
                ) : null}
                {pendingAction === "login" ? "Signing in…" : "Sign in"}
              </button>

              {!showInitialAuthFeedback ? (
                <AuthFeedback
                  adjacent
                  error={error}
                  feedbackId="login-feedback"
                  notice={notice}
                />
              ) : null}

              <div className="grid gap-2 border-t border-trace-subtle pt-3 sm:grid-cols-2">
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
              className={`${formClassName} sm:[@media(max-height:45rem)]:mt-3 sm:[@media(max-height:45rem)]:grid sm:[@media(max-height:45rem)]:grid-cols-2 sm:[@media(max-height:45rem)]:gap-x-3 sm:[@media(max-height:45rem)]:gap-y-3 sm:[@media(max-height:45rem)]:space-y-0`}
              data-testid="register-form"
              key={activeInviteToken ? `auth-proof-${proofSessionGeneration}` : "access-request"}
              noValidate
              onSubmit={activeInviteToken ? submitInviteAcceptance : submitRegister}
            >
              <div>
                <label className="mb-2 block text-sm font-medium text-ink" htmlFor="register-name">
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
                <p className="mt-2 text-xs leading-5 text-ink-muted" id="register-name-help">
                  Optional. This is how your name appears in AIQSA.
                </p>
              </div>

              {activeInviteToken ? (
                <div>
                  <label className="mb-2 block text-sm font-medium text-ink" htmlFor="invite-password">
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
                  <p className="mt-2 text-xs leading-5 text-ink-muted" id="invite-password-help">
                    Use at least 8 characters. The invitation works only once.
                  </p>
                </div>
              ) : (
                <div>
                  <label className="mb-2 block text-sm font-medium text-ink" htmlFor="register-email">
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
                  <p className="mt-2 text-xs leading-5 text-ink-muted" id="register-email-help">
                    Use an address approved by the operator.
                  </p>
                </div>
              )}

              <button
                className={`${primaryButtonClassName} sm:[@media(max-height:45rem)]:self-end`}
                disabled={submitting}
                type="submit"
              >
                {submitting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
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
            <div className="mt-7 [@media(max-height:32rem)]:!mt-3">
              <div className="border-y border-trace-subtle py-5 [@media(max-height:32rem)]:!py-3" role="status">
                <div className="flex items-start gap-3">
                  {registrationOutcome === "verification-required" ? (
                    <Mail className="mt-0.5 size-[18px] shrink-0 text-positive" aria-hidden="true" />
                  ) : (
                    <CheckCircle2 className="mt-0.5 size-[18px] shrink-0 text-positive" aria-hidden="true" />
                  )}
                  <div className="min-w-0">
                    <p className="font-medium text-ink">Your access request is recorded.</p>
                    <p className="mt-1 text-sm leading-6 text-ink-secondary">
                      Request received. If verification is needed, use the email link before signing in.
                    </p>
                  </div>
                </div>
              </div>
              <button className={`${primaryButtonClassName} mt-5`} onClick={() => switchMode("password")} type="button">
                Back to sign in
              </button>
            </div>
          ) : null}

          {mode === "verify-email" ? (
            <form
              aria-busy={submitting}
              className={formClassName}
              key={`auth-proof-${proofSessionGeneration}`}
              noValidate
              onSubmit={submitEmailVerification}
            >
              <div>
                <label className="mb-2 block text-sm font-medium text-ink" htmlFor="verification-password">
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
                <p className="mt-2 text-xs leading-5 text-ink-muted" id="verification-password-help">
                  Use at least 8 characters. The link works only once.
                </p>
              </div>
              <button className={primaryButtonClassName} disabled={submitting} type="submit">
                {pendingAction === "verify" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
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
            <form aria-busy={submitting} className={formClassName} noValidate onSubmit={submitResetRequest}>
              <div>
                <label className="mb-2 block text-sm font-medium text-ink" htmlFor="reset-email">
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
                <p className="mt-2 text-xs leading-5 text-ink-muted" id="reset-email-help">
                  For privacy, the result is the same whether or not an eligible account exists.
                </p>
              </div>

              <button className={primaryButtonClassName} disabled={submitting} type="submit">
                {pendingAction === "reset-request" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
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
            <form
              aria-busy={submitting}
              className={formClassName}
              key={`auth-proof-${proofSessionGeneration}`}
              noValidate
              onSubmit={submitResetComplete}
            >
              <div>
                <label className="mb-2 block text-sm font-medium text-ink" htmlFor="new-password">
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
                <p className="mt-2 text-xs leading-5 text-ink-muted" id="new-password-help">
                  Use at least 8 characters. This link works only once.
                </p>
              </div>

              <button className={primaryButtonClassName} disabled={submitting} type="submit">
                {pendingAction === "reset-complete" ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
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

          {mode !== "password" && !showInitialAuthFeedback ? (
            <AuthFeedback error={error} notice={notice} />
          ) : null}
          </div>
        </div>
      </section>
    </main>
  );
}
