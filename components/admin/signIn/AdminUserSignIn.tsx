"use client";

import {
  adminSignInErrorMessage,
  changeAdminUserSignIn,
  requestAdminUserSignIn
} from "@/components/admin/signIn/adminSignInApi";
import {
  formatSignInTime,
  membershipManagerLabel,
  signInMethodLabels,
  syncWarningMessage
} from "@/components/admin/signIn/signInView";
import { sectionHeadingClass } from "@/components/admin/users/usersPrimitives";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminUserSignIn, AdminUserSignInIdentity } from "@/lib/contracts/adminSignIn";
import { useCallback, useEffect, useRef, useState } from "react";

const helpClass = "text-xs leading-5 text-ink-muted";

export type AdminUserSignInState = Readonly<{
  busy: boolean;
  error: string | null;
  refresh(): Promise<void>;
  /** Unlinks one identity; returns the refusal code, or null once unlinked. */
  unlink(identityId: string, confirmLastSignInMethod: boolean): Promise<string | null>;
  user: AdminUserSignIn | null;
}>;

/** One user's sign-in identities and IdP-managed memberships, owned by the user page. */
export function useAdminUserSignIn(userId: string, membershipKey: string): AdminUserSignInState {
  const [user, setUser] = useState<AdminUserSignIn | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const apply = useCallback((result: Awaited<ReturnType<typeof requestAdminUserSignIn>>) => {
    if (result.ok) {
      setUser(result.data);
      setError(null);
    } else {
      setError(adminSignInErrorMessage(result.error));
    }
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const result = await requestAdminUserSignIn(userId);
    if (mountedRef.current && generation === generationRef.current) apply(result);
  }, [apply, userId]);

  // Membership changes can make a membership managed, so the page passes a key of them.
  useEffect(() => {
    const generation = ++generationRef.current;
    void requestAdminUserSignIn(userId).then((result) => {
      if (mountedRef.current && generation === generationRef.current) apply(result);
    });
  }, [apply, membershipKey, userId]);

  const unlink = useCallback(async (identityId: string, confirmLastSignInMethod: boolean) => {
    setBusy(true);
    ++generationRef.current;
    try {
      const result = await changeAdminUserSignIn(userId, {
        action: "unlink_identity",
        ...(confirmLastSignInMethod ? { confirmLastSignInMethod: true as const } : {}),
        identityId
      });
      if (!mountedRef.current) return null;
      if (result.ok) {
        setUser(result.data);
        return null;
      }
      if (result.error === "identity_not_found") void refresh();
      return result.error;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [refresh, userId]);

  return { busy, error, refresh, unlink, user };
}

/** The memberships an IdP or SCIM manages, under the user's group editor. */
export function AdminUserManagedGroups({
  groups,
  signIn
}: Readonly<{ groups: readonly AdminGroup[]; signIn: AdminUserSignInState }>) {
  const managed = signIn.user?.managedGroups ?? [];
  if (!managed.length) return null;
  const names = new Map(groups.map((group) => [group.id, group.name]));
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="admin-user-managed-groups">
      <ul aria-label="Managed memberships" className="flex min-w-0 flex-wrap gap-2">
        {managed.map((membership) => (
          <li
            className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-control bg-control-surface px-2.5 py-1 text-xs text-ink-secondary"
            data-testid="admin-user-managed-group"
            key={membership.groupId}
          >
            <span className="min-w-0 break-words font-medium text-ink [overflow-wrap:anywhere]">
              {names.get(membership.groupId) ?? "Group"}
            </span>
            <span className="shrink-0">· Managed by {membershipManagerLabel(membership.managedBy)}</span>
          </li>
        ))}
      </ul>
      <p className={helpClass}>
        These memberships follow the identity provider; the next sign-in or SCIM push would undo a manual change, so they
        cannot be changed here.
      </p>
    </div>
  );
}

function IdentityRow({
  identity,
  signIn
}: Readonly<{ identity: AdminUserSignInIdentity; signIn: AdminUserSignInState }>) {
  const [step, setStep] = useState<"confirm" | "confirm_last" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const label = signInMethodLabels[identity.provider];
  const synced = formatSignInTime(identity.lastSyncedAt);

  const unlink = async (confirmLast: boolean) => {
    setMessage(null);
    const refusal = await signIn.unlink(identity.id, confirmLast);
    if (refusal === "identity_last_sign_in_method") {
      setStep("confirm_last");
      return;
    }
    setStep(null);
    if (refusal) setMessage(adminSignInErrorMessage(refusal));
  };

  return (
    <li className="flex min-w-0 flex-col gap-1.5 py-3" data-provider={identity.provider} data-testid="admin-user-identity">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{label}</p>
          <p className={helpClass}>
            Linked {formatSignInTime(identity.createdAt) ?? "—"}
            {synced ? ` · Groups synced ${synced}` : ""}
          </p>
        </div>
        {step === null ? (
          <UiV2Button disabled={signIn.busy} onClick={() => setStep("confirm")} tone="ghost" type="button">
            Unlink identity
          </UiV2Button>
        ) : null}
      </div>
      {identity.sourceCurrent === false ? (
        <p className="text-xs leading-5 text-caution" data-testid="admin-user-identity-source-changed">
          This identity belongs to a previous {label} source and no longer signs in. Unlink it so the next sign-in links
          again under the email rules.
        </p>
      ) : null}
      {identity.lastSyncWarning ? (
        <p className={helpClass} data-testid="admin-user-identity-sync-warning">{syncWarningMessage(identity.lastSyncWarning)}</p>
      ) : null}
      {step ? (
        <div
          className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-caution/25 bg-caution/5 px-3 py-2.5"
          data-testid="admin-user-identity-unlink-confirm"
          role="group"
        >
          <p className="text-xs leading-5 text-ink-secondary">
            {step === "confirm_last"
              ? `This is the user's only way to sign in. After unlinking, their next ${label} sign-in links again only if it asserts the account's verified email.`
              : `The user can no longer sign in with this ${label} identity. Their next ${label} sign-in links again under the email rules.`}
          </p>
          <div className="flex flex-wrap gap-2">
            <UiV2Button
              busy={signIn.busy}
              onClick={() => void unlink(step === "confirm_last")}
              tone="destructive"
              type="button"
            >
              {step === "confirm_last" ? "Unlink anyway" : "Unlink"}
            </UiV2Button>
            <UiV2Button disabled={signIn.busy} onClick={() => setStep(null)} tone="ghost" type="button">
              Cancel
            </UiV2Button>
          </div>
        </div>
      ) : null}
      {message ? <p className="text-xs leading-5 text-critical" role="alert">{message}</p> : null}
    </li>
  );
}

/** The user's sign-in identities with their last group sync and source status. */
export function AdminUserSignInSection({ signIn }: Readonly<{ signIn: AdminUserSignInState }>) {
  const user = signIn.user;
  return (
    <section aria-labelledby="admin-user-sign-in-heading" className="flex flex-col gap-3 border-t border-trace-subtle pt-5" data-testid="admin-user-sign-in">
      <h3 className={sectionHeadingClass} id="admin-user-sign-in-heading">Sign-in</h3>
      {user ? (
        <>
          <p className={helpClass}>{user.hasPassword ? "Has a password." : "No password."}</p>
          {user.identities.length ? (
            <ul aria-label="Sign-in identities" className="divide-y divide-trace-subtle">
              {user.identities.map((identity) => <IdentityRow identity={identity} key={identity.id} signIn={signIn} />)}
            </ul>
          ) : (
            <p className={helpClass}>No identities from Google, Yandex or an identity provider.</p>
          )}
        </>
      ) : (
        <p className={helpClass}>{signIn.error ?? "Loading sign-in identities…"}</p>
      )}
    </section>
  );
}
