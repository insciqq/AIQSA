"use client";

import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type RefObject } from "react";
import {
  fieldClassName,
  formClassName,
  invalidFieldClassName,
  primaryButtonClassName,
  secondaryButtonClassName
} from "./authFormStyles";

type CodeKind = "recovery" | "totp";

const errorMessages: Record<string, string> = {
  auth_admission_unavailable: "Sign-in is temporarily unavailable. Try again later.",
  code_required: "Enter the code.",
  network_error: "Could not reach the server. Check your connection and try again.",
  rate_limited: "Too many attempts. Wait a bit before trying again.",
  two_factor_unavailable: "Two-factor sign-in is unavailable on this server. Contact the operator."
};

function errorMessage(code: string, kind: CodeKind): string {
  const message = code === "invalid_code"
    ? kind === "totp"
      ? "That code did not work. Use the current code from your authenticator app."
      : "That recovery code is not valid or was already used."
    : errorMessages[code] ?? "Verification failed. Try again.";

  return `${message} (${code})`;
}

function stableErrorCode(value: unknown): string {
  const code = typeof value === "object" && value && "error" in value ? value.error : null;

  return typeof code === "string" && /^[a-z][a-z0-9_]{0,127}$/u.test(code) ? code : "second_factor_failed";
}

/**
 * The second sign-in step after a verified password (or LDAP) of an account with two-factor
 * sign-in: a TOTP code, or a recovery code instead. The challenge lives in an HttpOnly cookie
 * the first step set; this step only sends the code.
 */
export function SecondFactorStep({
  feedbackId,
  inputRef,
  onBack,
  onExpired,
  onSignedIn
}: Readonly<{
  feedbackId: string;
  inputRef: RefObject<HTMLInputElement | null>;
  onBack(): void;
  onExpired(): void;
  onSignedIn(): void;
}>) {
  const [kind, setKind] = useState<CodeKind>("totp");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const focusAfterRender = useRef(false);
  const inputId = kind === "totp" ? "second-factor-code" : "second-factor-recovery-code";

  useEffect(() => {
    if (!focusAfterRender.current || submitting) return;
    focusAfterRender.current = false;
    inputRef.current?.focus({ preventScroll: true });
    inputRef.current?.select();
  });

  function switchKind() {
    if (submitting) return;
    setError(null);
    setKind((current) => (current === "totp" ? "recovery" : "totp"));
    focusAfterRender.current = true;
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const value = String(new FormData(event.currentTarget).get("code") ?? "").trim();
    setError(null);

    if (!value) {
      setError(errorMessage("code_required", kind));
      focusAfterRender.current = true;
      return;
    }

    setSubmitting(true);

    try {
      const response = await fetch("/api/auth/second-factor", {
        body: JSON.stringify(kind === "totp" ? { code: value } : { recoveryCode: value }),
        headers: { "content-type": "application/json" },
        method: "POST"
      });
      const data: unknown = await response.json().catch(() => null);

      if (response.ok && typeof data === "object" && data && "user" in data) {
        onSignedIn();
        return;
      }

      const code = stableErrorCode(data);

      if (code === "challenge_expired") {
        onExpired();
        return;
      }

      setError(errorMessage(code, kind));
    } catch {
      setError(errorMessage("network_error", kind));
    }

    focusAfterRender.current = true;
    setSubmitting(false);
  }

  return (
    <form aria-busy={submitting} className={formClassName} data-testid="second-factor-form" method="post" noValidate onSubmit={submit}>
      <div>
        <label className="mb-2 block text-sm font-medium text-ink" htmlFor={inputId}>
          {kind === "totp" ? "Authentication code" : "Recovery code"}
        </label>
        <input
          aria-describedby={error ? `${inputId}-help ${feedbackId}` : `${inputId}-help`}
          aria-errormessage={error ? feedbackId : undefined}
          aria-invalid={error ? true : undefined}
          autoCapitalize={kind === "totp" ? "none" : "characters"}
          autoComplete={kind === "totp" ? "one-time-code" : "off"}
          className={`${fieldClassName} tracking-[0.12em] ${error ? invalidFieldClassName : ""}`}
          disabled={submitting}
          enterKeyHint="done"
          id={inputId}
          inputMode={kind === "totp" ? "numeric" : "text"}
          key={kind}
          maxLength={kind === "totp" ? 9 : 16}
          name="code"
          pattern={kind === "totp" ? "[0-9 ]*" : undefined}
          ref={inputRef}
          required
          spellCheck={false}
          type="text"
        />
        <p className="mt-2 text-xs leading-5 text-ink-muted" id={`${inputId}-help`}>
          {kind === "totp"
            ? "Six digits from your authenticator app. Codes change every 30 seconds."
            : "One of the recovery codes you saved when you turned on two-factor sign-in. Each works once."}
        </p>
      </div>

      <button className={primaryButtonClassName} disabled={submitting} type="submit">
        {submitting ? <LoaderCircle className="size-4 animate-spin" aria-hidden="true" /> : null}
        {submitting ? "Verifying…" : "Verify"}
      </button>

      {error ? (
        <div className="flex items-start gap-3 border-y border-trace-subtle py-3.5">
          <span className="mt-2 size-1.5 shrink-0 rounded-full bg-critical" aria-hidden="true" />
          <p className="text-sm leading-6 text-ink" id={feedbackId} role="alert">
            {error}
          </p>
        </div>
      ) : null}

      <div className="grid gap-1 sm:grid-cols-2">
        <button className={`${secondaryButtonClassName} w-full`} disabled={submitting} onClick={switchKind} type="button">
          {kind === "totp" ? "Use a recovery code" : "Use your authenticator app"}
        </button>
        <button className={`${secondaryButtonClassName} w-full`} disabled={submitting} onClick={onBack} type="button">
          Back to sign in
        </button>
      </div>
    </form>
  );
}
