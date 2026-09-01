"use client";

import {
  changeAccountPassword,
  loadAccountProfile,
  updateAccountDisplayName
} from "@/components/app-shell/accountApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import { UiV2Button } from "@/components/ui-v2";
import { accountInitialsV2 } from "@/features/navigation-v2/AccountMenuV2";
import {
  ACCOUNT_DISPLAY_NAME_MAX_LENGTH,
  type AccountProfileWire
} from "@/lib/contracts/account";
import { useEffect, useState, type FormEvent } from "react";
import { SettingsRowV2 } from "./SettingsV2";

type PasswordFormState =
  | Readonly<{ kind: "closed" }>
  | Readonly<{ kind: "editing"; error: string | null; saving: boolean }>
  | Readonly<{ kind: "saved" }>;

/**
 * Account identity, Display name and Password rows (PRD §4.9). The profile is
 * read from the server on mount; the password row is hidden for accounts that
 * sign in only through an external identity provider.
 */
export function AccountSettingsRowsV2({
  accountEmail,
  adminEntryVisible
}: Readonly<{ accountEmail: string | null; adminEntryVisible: boolean }>) {
  const [profile, setProfile] = useState<AccountProfileWire | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [password, setPassword] = useState<PasswordFormState>({ kind: "closed" });

  useEffect(() => {
    let cancelled = false;
    void loadAccountProfile().then(
      (loaded) => {
        if (cancelled) return;
        setProfile(loaded);
        setNameDraft(loaded.displayName);
      },
      (error) => {
        if (!cancelled) setProfileError(errorMessage(error));
      }
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const email = profile?.email ?? accountEmail;
  const nameDirty = profile !== null && nameDraft.trim() !== profile.displayName;

  const saveName = () => {
    if (!profile || !nameDirty || nameSaving) return;
    setNameSaving(true);
    setNameError(null);
    void updateAccountDisplayName(nameDraft).then(
      (updated) => {
        setProfile(updated);
        setNameDraft(updated.displayName);
        setNameSaving(false);
      },
      (error) => {
        setNameError(errorMessage(error));
        setNameSaving(false);
      }
    );
  };

  const submitPassword = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password.kind !== "editing" || password.saving) return;
    const form = new FormData(event.currentTarget);
    const currentPassword = String(form.get("currentPassword") ?? "");
    const newPassword = String(form.get("newPassword") ?? "");
    const confirmPassword = String(form.get("confirmPassword") ?? "");
    if (newPassword !== confirmPassword) {
      setPassword({ error: "The new passwords do not match.", kind: "editing", saving: false });
      return;
    }
    setPassword({ error: null, kind: "editing", saving: true });
    void changeAccountPassword({ currentPassword, newPassword }).then(
      () => setPassword({ kind: "saved" }),
      (error) => setPassword({ error: errorMessage(error), kind: "editing", saving: false })
    );
  };

  return (
    <>
      <div className="v2-settings-identity" data-testid="settings-account-identity">
        <span className="v2-navigation-account-avatar" aria-hidden="true">
          {accountInitialsV2(profile?.displayName ?? email)}
        </span>
        <div>
          <strong>{profile?.displayName ?? email ?? "Account"}</strong>
          <small>
            {[email, adminEntryVisible ? "Administrator" : "Member"].filter(Boolean).join(" · ")}
          </small>
        </div>
      </div>
      {profileError ? <p className="v2-settings-note" role="alert">{profileError}</p> : null}
      <SettingsRowV2
        description="Shown to Project members next to your questions."
        testId="settings-display-name"
        title="Display name"
      >
        <input
          aria-label="Display name"
          className="v2-settings-input"
          disabled={!profile || nameSaving}
          maxLength={ACCOUNT_DISPLAY_NAME_MAX_LENGTH}
          type="text"
          value={nameDraft}
          onBlur={saveName}
          onChange={(event) => setNameDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              saveName();
            }
          }}
        />
        {nameError ? <span className="v2-live-menu-error" role="alert">{nameError}</span> : null}
      </SettingsRowV2>
      {profile?.hasPassword ? (
        <SettingsRowV2
          description={password.kind === "saved"
            ? "Password changed. Other sessions were signed out."
            : "Change the password used for e-mail sign-in."}
          testId="settings-password"
          title="Password"
        >
          {password.kind === "editing" ? null : (
            <UiV2Button onClick={() => setPassword({ error: null, kind: "editing", saving: false })}>
              Change…
            </UiV2Button>
          )}
        </SettingsRowV2>
      ) : null}
      {password.kind === "editing" ? (
        <form className="v2-settings-form" data-testid="settings-password-form" onSubmit={submitPassword}>
          <label>
            <span>Current password</span>
            <input autoComplete="current-password" className="v2-settings-input" name="currentPassword" required type="password" />
          </label>
          <label>
            <span>New password</span>
            <input autoComplete="new-password" className="v2-settings-input" minLength={8} name="newPassword" required type="password" />
          </label>
          <label>
            <span>Confirm new password</span>
            <input autoComplete="new-password" className="v2-settings-input" minLength={8} name="confirmPassword" required type="password" />
          </label>
          {password.error ? <span className="v2-live-menu-error" role="alert">{password.error}</span> : null}
          <div className="v2-settings-form-actions">
            <UiV2Button disabled={password.saving} onClick={() => setPassword({ kind: "closed" })}>Cancel</UiV2Button>
            <UiV2Button busy={password.saving} tone="primary" type="submit">Save password</UiV2Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
