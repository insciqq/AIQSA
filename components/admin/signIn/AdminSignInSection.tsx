"use client";

import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { adminSignInMethodCards } from "@/components/admin/signIn/signInMethodCards";
import {
  useAdminSignInController,
  type AdminSignInController
} from "@/components/admin/signIn/useAdminSignInController";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button, UiV2Switch } from "@/components/ui-v2";
import type { AdminSignInMethodState, AdminSignInOverview } from "@/lib/contracts/adminSignIn";
import type { AuthSignInMethod } from "@/lib/contracts/authSignInMethods";
import { useMemo, useState, type ComponentType } from "react";
import type { AdminSignInMethodCardProps } from "@/components/admin/signIn/SignInMethodCardFrame";

const EXTERNAL_SESSION_METHODS = new Set(["google", "ldap", "oidc", "saml", "trusted_header", "yandex"]);

export type AdminSignInSectionProps = Readonly<{
  active?: boolean;
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>;

function SwitchRow({
  checked,
  description,
  disabled,
  label,
  onChange,
  testId
}: Readonly<{
  checked: boolean;
  description: string;
  disabled: boolean;
  label: string;
  onChange(next: boolean): void;
  testId: string;
}>) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 px-4 py-3.5 sm:px-5" data-testid={testId}>
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{label}</p>
        <p className="mt-0.5 text-xs leading-5 text-ink-muted">{description}</p>
      </div>
      <UiV2Switch checked={checked} className="shrink-0" disabled={disabled} label={label} onChange={onChange} />
    </div>
  );
}

function PolicyCard({
  controller,
  overview,
  requestConfirmation
}: Readonly<{
  controller: AdminSignInController;
  overview: AdminSignInOverview;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>) {
  const [message, setMessage] = useState<string | null>(null);
  const { policy } = overview;
  const busy = controller.state.busy !== null;
  const sessionMethod = overview.currentSessionSignInMethod;
  const externalSession = sessionMethod !== null && EXTERNAL_SESSION_METHODS.has(sessionMethod);

  const save = async (next: { passwordLoginEnabled: boolean; registrationEnabled: boolean }) => {
    setMessage(null);
    const outcome = await controller.actions.setPolicy(next);
    if (!outcome.ok && outcome.message) setMessage(outcome.message);
  };

  const setPassword = (enabled: boolean) => {
    if (enabled) {
      void save({ passwordLoginEnabled: true, registrationEnabled: policy.registrationEnabled });
      return;
    }
    requestConfirmation({
      body: "Nobody can sign in, request access, accept an invitation or reset a password with a password. " +
        "Sign-in goes through the active external methods; the bootstrap token keeps working as the break-glass sign-in.",
      confirmLabel: "Turn off",
      dialogLabel: "Turn password sign-in off",
      onConfirm: () => save({ passwordLoginEnabled: false, registrationEnabled: policy.registrationEnabled }),
      testId: "admin-confirm-password-sign-in-off",
      title: "Turn password sign-in off?",
      tone: "warning"
    });
  };

  return (
    <section aria-labelledby="admin-sign-in-policy-heading" className="flex min-w-0 flex-col gap-3" data-testid="admin-sign-in-policy">
      <h2 className={sectionHeadingClass} id="admin-sign-in-policy-heading">Passwords and access requests</h2>
      <div className={`${cardClass} divide-y divide-trace-subtle`}>
        <SwitchRow
          checked={policy.passwordLoginEnabled}
          description={externalSession || !policy.passwordLoginEnabled
            ? "Email and password sign-in, invitations with a password and password resets."
            : `Email and password sign-in, invitations with a password and password resets. You signed in with ${sessionMethod === "bootstrap" ? "the bootstrap token" : "a password"}; to turn passwords off, sign in through an active external method first.`}
          disabled={busy}
          label="Password sign-in"
          onChange={setPassword}
          testId="admin-sign-in-password-switch"
        />
        <SwitchRow
          checked={policy.registrationEnabled && policy.passwordLoginEnabled}
          description={policy.passwordLoginEnabled
            ? "Anyone can request access; the sign-up rules decide who gets in. Invitations work either way."
            : "Access requests need password sign-in."}
          disabled={busy || !policy.passwordLoginEnabled}
          label="Access requests"
          onChange={(enabled) => void save({ passwordLoginEnabled: policy.passwordLoginEnabled, registrationEnabled: enabled })}
          testId="admin-sign-in-registration-switch"
        />
      </div>
      {message ? (
        <p
          className="rounded-[10px] border border-critical/25 bg-critical/5 px-3 py-2 text-xs leading-5 text-critical"
          data-testid="admin-sign-in-policy-message"
          role="alert"
        >
          {message}
        </p>
      ) : null}
    </section>
  );
}

function MethodCard({ appBaseUrl, controller, state }: Readonly<{
  appBaseUrl: string;
  controller: AdminSignInController;
  state: AdminSignInMethodState;
}>) {
  const Card = adminSignInMethodCards[state.method] as ComponentType<AdminSignInMethodCardProps<AuthSignInMethod>> | undefined;
  return Card ? <Card appBaseUrl={appBaseUrl} controller={controller} state={state} /> : null;
}

/**
 * Sign-in page: the password and access-request switches, then one card per sign-in method the
 * installation can configure (draft → Test → Activate, write-only secrets).
 */
export function AdminSignInSection({ active = true, feedback, requestConfirmation }: AdminSignInSectionProps) {
  const controller = useAdminSignInController({
    active,
    onNotice: feedback.reportNotice,
    requestConfirmation
  });
  const { error, loaded, overview } = controller.state;
  const topbar = useMemo(() => ({ title: "Sign-in" }), []);
  useAdminSectionTopbar(topbar);

  if (!overview) {
    return (
      <div className="px-4 py-12 text-center sm:px-6" data-testid="admin-sign-in-section" role={loaded && error ? "alert" : "status"}>
        {loaded && error ? (
          <>
            <p className="text-sm font-semibold text-ink-secondary">{error}</p>
            <UiV2Button className="mt-4" onClick={() => void controller.actions.refresh()} tone="ghost" type="button">
              Try again
            </UiV2Button>
          </>
        ) : (
          <p className="text-sm text-ink-muted">Loading sign-in settings…</p>
        )}
      </div>
    );
  }

  const methods = overview.methods.filter((state) => adminSignInMethodCards[state.method]);

  return (
    <div className="flex max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-sign-in-section">
      <PolicyCard controller={controller} overview={overview} requestConfirmation={requestConfirmation} />
      <section aria-labelledby="admin-sign-in-methods-heading" className="flex min-w-0 flex-col gap-3">
        <h2 className={sectionHeadingClass} id="admin-sign-in-methods-heading">Sign-in methods</h2>
        <p className="text-xs leading-5 text-ink-muted">
          Save the settings, test them, then activate. Secrets are stored encrypted and never shown again.
        </p>
        <div className="grid min-w-0 gap-4 xl:grid-cols-2">
          {methods.map((state) => (
            <MethodCard appBaseUrl={overview.appBaseUrl} controller={controller} key={state.method} state={state} />
          ))}
        </div>
      </section>
    </div>
  );
}
