"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import {
  SignInField,
  SignInMethodCardFrame,
  SignInSecretField,
  SignInTextField,
  signInSecretAction,
  type AdminSignInMethodCardProps
} from "@/components/admin/signIn/SignInMethodCardFrame";
import {
  LDAP_EMAIL_FILTER,
  ldapFilterForUsernameSwitch,
  ldapPresets,
  type LdapPreset
} from "@/components/admin/signIn/ldapSignInView";
import { UiV2Button } from "@/components/ui-v2";
import { LDAP_USERNAME_PLACEHOLDER, type AuthSignInMethodConfig } from "@/lib/contracts/authSignInMethods";
import { useId, useMemo, useState, type ReactNode } from "react";

type LdapConfig = AuthSignInMethodConfig<"ldap">;

type LdapForm = {
  adminGroups: string;
  allowedGroups: string;
  autoCreateUsers: boolean;
  bindDn: string;
  caCertificatePem: string;
  displayNameAttribute: string;
  emailAttribute: string;
  groupValueForm: LdapConfig["groupValueForm"];
  groupsAttribute: string;
  idAttribute: string;
  loginUsesUsername: boolean;
  startTls: boolean;
  syncGroups: boolean;
  testUsername: string;
  tlsRejectUnauthorized: boolean;
  trustUnverifiedEmail: boolean;
  url: string;
  userSearchBase: string;
  userSearchFilter: string;
};

type LdapFormErrors = Partial<Record<"url" | "userSearchBase" | "userSearchFilter", string>>;

const helpClass = "text-xs leading-5 text-ink-muted";

function formFromConfig(config: LdapConfig | null): LdapForm {
  return {
    adminGroups: config?.adminGroups.join("\n") ?? "",
    allowedGroups: config?.allowedGroups.join("\n") ?? "",
    autoCreateUsers: config?.autoCreateUsers ?? true,
    bindDn: config?.bindDn ?? "",
    caCertificatePem: config?.caCertificatePem ?? "",
    displayNameAttribute: config?.attributes.displayName ?? "displayName",
    emailAttribute: config?.attributes.email ?? "mail",
    groupValueForm: config?.groupValueForm ?? "cn",
    groupsAttribute: config?.attributes.groups ?? "memberOf",
    idAttribute: config?.attributes.id ?? "entryUUID",
    loginUsesUsername: config?.loginUsesUsername ?? false,
    startTls: config?.startTls ?? false,
    syncGroups: config?.syncGroups ?? false,
    testUsername: config?.testUsername ?? "",
    tlsRejectUnauthorized: config?.tlsRejectUnauthorized ?? true,
    trustUnverifiedEmail: config?.trustUnverifiedEmail ?? true,
    url: config?.url ?? "",
    userSearchBase: config?.userSearchBase ?? "",
    userSearchFilter: config?.userSearchFilter ?? LDAP_EMAIL_FILTER
  };
}

/** One value per line, blank lines dropped. */
function groupLines(value: string): string[] {
  return value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function isLdaps(url: string): boolean {
  return url.trim().toLowerCase().startsWith("ldaps://");
}

function configFromForm(form: LdapForm) {
  const url = form.url.trim();
  return {
    adminGroups: groupLines(form.adminGroups),
    allowedGroups: groupLines(form.allowedGroups),
    attributes: {
      displayName: form.displayNameAttribute.trim(),
      email: form.emailAttribute.trim(),
      groups: form.groupsAttribute.trim(),
      id: form.idAttribute.trim()
    },
    autoCreateUsers: form.autoCreateUsers,
    bindDn: form.bindDn.trim() || null,
    caCertificatePem: form.caCertificatePem.trim() || null,
    groupValueForm: form.groupValueForm,
    loginUsesUsername: form.loginUsesUsername,
    startTls: form.startTls && !isLdaps(url),
    syncGroups: form.syncGroups,
    testUsername: form.testUsername.trim() || null,
    tlsRejectUnauthorized: form.tlsRejectUnauthorized,
    trustUnverifiedEmail: form.trustUnverifiedEmail,
    url,
    userSearchBase: form.userSearchBase.trim(),
    userSearchFilter: form.userSearchFilter.trim()
  };
}

function validate(form: LdapForm): LdapFormErrors {
  const errors: LdapFormErrors = {};
  if (!/^ldaps?:\/\/[^/?#\s]+\/?$/iu.test(form.url.trim())) errors.url = "Enter the server as ldaps://host or ldap://host, with an optional port.";
  if (!form.userSearchBase.trim()) errors.userSearchBase = "Enter the DN to search users under.";
  if (!form.userSearchFilter.includes(LDAP_USERNAME_PLACEHOLDER)) {
    errors.userSearchFilter = `The filter must contain ${LDAP_USERNAME_PLACEHOLDER}.`;
  }
  return errors;
}

function Checkbox({
  checked,
  children,
  disabled,
  help,
  onChange
}: Readonly<{ checked: boolean; children: ReactNode; disabled: boolean; help?: ReactNode; onChange(checked: boolean): void }>) {
  const helpId = useId();
  return (
    <div className="min-w-0">
      <label className="flex min-w-0 items-start gap-2 text-sm text-ink">
        <input
          aria-describedby={help ? helpId : undefined}
          checked={checked}
          className="mt-0.5 size-4 shrink-0 accent-proof"
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.checked)}
          type="checkbox"
        />
        <span className="min-w-0">{children}</span>
      </label>
      {help ? <span className={`block pl-6 ${helpClass}`} id={helpId}>{help}</span> : null}
    </div>
  );
}

function TextArea({
  disabled,
  help,
  label,
  onChange,
  placeholder,
  rows = 3,
  value
}: Readonly<{ disabled: boolean; help?: ReactNode; label: string; onChange(value: string): void; placeholder?: string; rows?: number; value: string }>) {
  return (
    <SignInField
      help={help}
      label={label}
      render={(props) => (
        <textarea
          {...props}
          className={`${inputClass} min-h-20 resize-y py-2 font-mono text-xs`}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          rows={rows}
          spellCheck={false}
          value={value}
        />
      )}
    />
  );
}

/**
 * LDAP or Active Directory: the server and TLS, the service bind, the user search with AD and
 * OpenLDAP presets, attribute mapping, groups admission and sync, and a sample name for the
 * tester.
 */
export function LdapSignInCard({ controller, state }: AdminSignInMethodCardProps<"ldap">) {
  const saved = useMemo(() => formFromConfig(state.draft.config), [state.draft.config]);
  const [edits, setEdits] = useState<Partial<LdapForm>>({});
  const [bindPassword, setBindPassword] = useState("");
  const [bindPasswordCleared, setBindPasswordCleared] = useState(false);
  const [errors, setErrors] = useState<LdapFormErrors>({});
  const form: LdapForm = useMemo(() => ({ ...saved, ...edits }), [edits, saved]);
  const busy = controller.state.busy !== null;
  const passwordConfigured = state.draft.secrets.bindPassword === true;
  const dirty = (Object.keys(edits) as (keyof LdapForm)[]).some((key) => edits[key] !== saved[key]) ||
    bindPassword.length > 0 || bindPasswordCleared;
  const ldaps = isLdaps(form.url);

  const set = <K extends keyof LdapForm>(key: K, value: LdapForm[K]) => {
    setEdits((current) => ({ ...current, [key]: value }));
    if (key === "url" || key === "userSearchBase" || key === "userSearchFilter") {
      setErrors((current) => ({ ...current, [key]: undefined }));
    }
  };

  const applyPreset = (preset: LdapPreset) => {
    const values = ldapPresets[preset];
    setEdits((current) => ({
      ...current,
      displayNameAttribute: values.attributes.displayName,
      emailAttribute: values.attributes.email,
      groupValueForm: values.groupValueForm,
      groupsAttribute: values.attributes.groups,
      idAttribute: values.attributes.id,
      loginUsesUsername: values.loginUsesUsername,
      userSearchFilter: values.userSearchFilter
    }));
    setErrors((current) => ({ ...current, userSearchFilter: undefined }));
  };

  const draft = useMemo(() => ({
    build() {
      const nextErrors = validate(form);
      setErrors(nextErrors);
      if (Object.values(nextErrors).some(Boolean)) return null;
      return {
        config: configFromForm(form),
        secretActions: { bindPassword: signInSecretAction(bindPassword, bindPasswordCleared) }
      };
    },
    dirty,
    reset() {
      setEdits({});
      setBindPassword("");
      setBindPasswordCleared(false);
      setErrors({});
    }
  }), [bindPassword, bindPasswordCleared, dirty, form]);

  return (
    <SignInMethodCardFrame
      controller={controller}
      description="An LDAP or Active Directory server. People sign in on the login form with their directory name or email and password; accounts with a local password keep it, also for administrators locked out of the directory."
      draft={draft}
      state={state}
      title="LDAP / Active Directory"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid="admin-sign-in-ldap-presets">
        <span className={helpClass}>Start from:</span>
        <UiV2Button disabled={busy} onClick={() => applyPreset("active_directory")} tone="ghost" type="button">
          Active Directory
        </UiV2Button>
        <UiV2Button disabled={busy} onClick={() => applyPreset("openldap")} tone="ghost" type="button">
          OpenLDAP
        </UiV2Button>
      </div>

      <h4 className={sectionHeadingClass}>Server</h4>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SignInTextField
          disabled={busy}
          error={errors.url}
          label="Server URL"
          onChange={(value) => set("url", value)}
          placeholder="ldaps://dc1.example.com"
          value={form.url}
        />
        <div className="grid min-w-0 content-start gap-3 md:pt-6">
          <Checkbox
            checked={form.startTls && !ldaps}
            disabled={busy || ldaps}
            help={ldaps ? "ldaps:// is encrypted from the start." : "Upgrades an ldap:// connection to TLS before any password is sent."}
            onChange={(checked) => set("startTls", checked)}
          >
            Use StartTLS
          </Checkbox>
          <Checkbox
            checked={form.tlsRejectUnauthorized}
            disabled={busy}
            help="The host name is checked either way."
            onChange={(checked) => set("tlsRejectUnauthorized", checked)}
          >
            Verify the server certificate
          </Checkbox>
        </div>
      </div>
      {!form.tlsRejectUnauthorized ? (
        <p
          className="rounded-[10px] border border-caution/30 bg-caution/10 px-3 py-2 text-xs leading-5 text-caution"
          data-testid="admin-sign-in-ldap-tls-warning"
          role="note"
        >
          Certificate verification is off: anyone on the network path can pose as the directory and read the passwords people type. Paste the directory&apos;s CA certificate instead.
        </p>
      ) : null}
      <TextArea
        disabled={busy}
        help="Optional. When set, it is the only certificate authority trusted for this server; otherwise the system's are."
        label="CA certificate (PEM)"
        onChange={(value) => set("caCertificatePem", value)}
        placeholder="-----BEGIN CERTIFICATE-----"
        value={form.caCertificatePem}
      />

      <h4 className={sectionHeadingClass}>Service account and user search</h4>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SignInTextField
          disabled={busy}
          help="Leave empty to search anonymously."
          label="Bind DN"
          onChange={(value) => set("bindDn", value)}
          placeholder="CN=aiqsa-bind,OU=Service,DC=example,DC=com"
          value={form.bindDn}
        />
        <SignInSecretField
          clear={{ cleared: bindPasswordCleared, onChange: setBindPasswordCleared }}
          configured={passwordConfigured}
          disabled={busy}
          label="Bind password"
          onChange={setBindPassword}
          value={bindPassword}
        />
        <SignInTextField
          disabled={busy}
          error={errors.userSearchBase}
          label="User search base"
          onChange={(value) => set("userSearchBase", value)}
          placeholder="DC=example,DC=com"
          value={form.userSearchBase}
        />
        <SignInTextField
          disabled={busy}
          error={errors.userSearchFilter}
          help={
            <>
              {LDAP_USERNAME_PLACEHOLDER} becomes the escaped sign-in name. Active Directory: (sAMAccountName={LDAP_USERNAME_PLACEHOLDER}), OpenLDAP: (uid={LDAP_USERNAME_PLACEHOLDER}), by email: {LDAP_EMAIL_FILTER}.
            </>
          }
          label="User search filter"
          onChange={(value) => set("userSearchFilter", value)}
          value={form.userSearchFilter}
        />
      </div>
      <Checkbox
        checked={form.loginUsesUsername}
        disabled={busy}
        help="The login form then asks for a username or email."
        onChange={(checked) => {
          set("loginUsesUsername", checked);
          set("userSearchFilter", ldapFilterForUsernameSwitch({
            filter: form.userSearchFilter,
            idAttribute: form.idAttribute,
            loginUsesUsername: checked
          }));
        }}
      >
        People sign in with a username
      </Checkbox>

      <h4 className={sectionHeadingClass}>Attributes</h4>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SignInTextField
          disabled={busy}
          help="A stable id: entryUUID (OpenLDAP) or objectGUID (Active Directory)."
          label="Id attribute"
          onChange={(value) => set("idAttribute", value)}
          value={form.idAttribute}
        />
        <SignInTextField disabled={busy} label="Email attribute" onChange={(value) => set("emailAttribute", value)} value={form.emailAttribute} />
        <SignInTextField
          disabled={busy}
          help="Falls back to cn."
          label="Display name attribute"
          onChange={(value) => set("displayNameAttribute", value)}
          value={form.displayNameAttribute}
        />
        <SignInTextField
          disabled={busy}
          help="OpenLDAP fills memberOf only with the memberof overlay (osixia/openldap enables it for groupOfUniqueNames groups with uniqueMember)."
          label="Groups attribute"
          onChange={(value) => set("groupsAttribute", value)}
          value={form.groupsAttribute}
        />
        <SignInField
          help="How group values compare with the external names of AIQSA groups: CN=ad-engineers,CN=Users,DC=… is ad-engineers as first CN."
          label="Group values"
          render={(props) => (
            <select
              {...props}
              className={inputClass}
              disabled={busy}
              onChange={(event) => set("groupValueForm", event.currentTarget.value === "dn" ? "dn" : "cn")}
              value={form.groupValueForm}
            >
              <option value="cn">First CN of the group DN</option>
              <option value="dn">Full group DN</option>
            </select>
          )}
        />
      </div>

      <h4 className={sectionHeadingClass}>Access</h4>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <TextArea
          disabled={busy}
          help="One group value per line. Empty lets in everyone the directory authenticates."
          label="Allowed groups"
          onChange={(value) => set("allowedGroups", value)}
          value={form.allowedGroups}
        />
        <TextArea
          disabled={busy}
          help="One group value per line. Members become administrators; the directory removes only the role it granted."
          label="Administrator groups"
          onChange={(value) => set("adminGroups", value)}
          value={form.adminGroups}
        />
      </div>
      <div className="grid min-w-0 gap-3">
        <Checkbox checked={form.autoCreateUsers} disabled={busy} onChange={(checked) => set("autoCreateUsers", checked)}>
          Create accounts on first sign-in
        </Checkbox>
        <Checkbox
          checked={form.syncGroups}
          disabled={busy}
          help="Changes only memberships of AIQSA groups that have an LDAP external name."
          onChange={(checked) => set("syncGroups", checked)}
        >
          Sync group memberships from the directory
        </Checkbox>
        <Checkbox
          checked={form.trustUnverifiedEmail}
          disabled={busy}
          help="On by default: the directory owns its email addresses, so a directory user whose email matches an existing account signs in to that account. Turn it off if people can edit their own email in the directory."
          onChange={(checked) => set("trustUnverifiedEmail", checked)}
        >
          Link accounts by directory email
        </Checkbox>
      </div>

      <h4 className={sectionHeadingClass}>Test</h4>
      <SignInTextField
        disabled={busy}
        help="Test binds with the service account and searches for this name; it never signs in as the user. Leave empty to check only the connection and search base."
        label="Sample sign-in name"
        onChange={(value) => set("testUsername", value)}
        placeholder="jdoe"
        value={form.testUsername}
      />
    </SignInMethodCardFrame>
  );
}
