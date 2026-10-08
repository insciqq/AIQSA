"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import {
  SignInField,
  SignInMethodCardFrame,
  SignInSecretField,
  SignInTextField,
  signInSecretAction,
  type AdminSignInMethodCardProps
} from "@/components/admin/signIn/SignInMethodCardFrame";
import { appUrl } from "@/components/admin/signIn/signInView";
import {
  EXTERNAL_GROUP_LIST_MAX,
  EXTERNAL_GROUP_NAME_MAX_LENGTH,
  isMultiTenantOidcIssuer,
  OIDC_GROUPS_FROM,
  type AuthSignInMethodConfig
} from "@/lib/contracts/authSignInMethods";
import { useMemo, useState } from "react";

type OidcConfig = AuthSignInMethodConfig<"oidc">;
type GroupsFrom = OidcConfig["groupsFrom"];

type OidcForm = {
  adminGroups: string;
  allowedGroups: string;
  autoCreateUsers: boolean;
  autoRedirect: boolean;
  buttonLabel: string;
  clientId: string;
  groupsClaimPath: string;
  groupsFrom: GroupsFrom;
  idpLogout: boolean;
  issuer: string;
  scopes: string;
  syncGroups: boolean;
  trustUnverifiedEmail: boolean;
};

type OidcFormErrors = Partial<Record<keyof OidcForm | "clientSecret", string>>;

const CLAIM_PATH = /^[^.\s]+(?:\.[^.\s]+){0,7}$/u;

const groupsFromLabels: Record<GroupsFrom, string> = {
  id_token: "ID token",
  id_token_then_userinfo: "ID token, then userinfo",
  userinfo: "Userinfo"
};

const checkboxClass = "size-4 shrink-0 accent-proof";

/** A new configuration starts here; group sync is a no-op until a group has an OIDC name. */
function formFrom(config: OidcConfig | null): OidcForm {
  return {
    adminGroups: (config?.adminGroups ?? []).join("\n"),
    allowedGroups: (config?.allowedGroups ?? []).join("\n"),
    autoCreateUsers: config?.autoCreateUsers ?? true,
    autoRedirect: config?.autoRedirect ?? false,
    buttonLabel: config?.buttonLabel ?? "SSO",
    clientId: config?.clientId ?? "",
    groupsClaimPath: config?.groupsClaimPath ?? "groups",
    groupsFrom: config?.groupsFrom ?? "id_token_then_userinfo",
    idpLogout: config?.idpLogout ?? false,
    issuer: config?.issuer ?? "",
    scopes: config?.scopes ?? "openid email profile",
    syncGroups: config?.syncGroups ?? true,
    trustUnverifiedEmail: config?.trustUnverifiedEmail ?? false
  };
}

/** One group or role value per line, exactly as the provider sends it. */
function groupLines(value: string): string[] {
  return [...new Set(value.split("\n").map((line) => line.trim()).filter(Boolean))];
}

function groupListError(value: string): string | undefined {
  const groups = groupLines(value);
  if (groups.length > EXTERNAL_GROUP_LIST_MAX) return `At most ${EXTERNAL_GROUP_LIST_MAX} values.`;
  if (groups.some((group) => group.length > EXTERNAL_GROUP_NAME_MAX_LENGTH)) {
    return `Each value has at most ${EXTERNAL_GROUP_NAME_MAX_LENGTH} characters.`;
  }
  return undefined;
}

function issuerError(value: string): string | undefined {
  const issuer = value.trim();
  if (!issuer) return "Enter the issuer URL.";
  try {
    const url = new URL(issuer);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
      return "Enter an http(s) URL without credentials or a fragment.";
    }
  } catch {
    return "Enter the issuer URL, for example https://idp.example.com/realms/main.";
  }
  if (isMultiTenantOidcIssuer(issuer)) {
    return "Multi-tenant issuers let any tenant sign in. Use your tenant's own issuer.";
  }
  return undefined;
}

function validate(form: OidcForm, secretMissing: boolean): OidcFormErrors {
  const errors: OidcFormErrors = {
    adminGroups: groupListError(form.adminGroups),
    allowedGroups: groupListError(form.allowedGroups),
    buttonLabel: form.buttonLabel.trim() ? undefined : "Enter the button label.",
    clientId: form.clientId.trim() ? undefined : "Enter the client ID.",
    clientSecret: secretMissing ? "Enter the client secret." : undefined,
    groupsClaimPath: CLAIM_PATH.test(form.groupsClaimPath.trim())
      ? undefined
      : "Enter a claim name or a dot path such as realm_access.roles.",
    issuer: issuerError(form.issuer),
    scopes: form.scopes.trim().split(/\s+/u).includes("openid") ? undefined : "Include the openid scope."
  };
  return Object.fromEntries(Object.entries(errors).filter(([, message]) => message)) as OidcFormErrors;
}

function CheckboxRow({
  checked,
  disabled,
  help,
  label,
  onChange
}: Readonly<{ checked: boolean; disabled: boolean; help: string; label: string; onChange(checked: boolean): void }>) {
  return (
    <label className="flex min-w-0 items-start gap-2.5 text-sm text-ink">
      <input
        checked={checked}
        className={`${checkboxClass} mt-0.5`}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="block text-xs leading-5 text-ink-muted">{help}</span>
      </span>
    </label>
  );
}

function GroupListField({
  disabled,
  error,
  help,
  label,
  onChange,
  value
}: Readonly<{ disabled: boolean; error?: string; help: string; label: string; onChange(value: string): void; value: string }>) {
  return (
    <SignInField
      error={error}
      help={help}
      label={label}
      render={(props) => (
        <textarea
          {...props}
          className={`${inputClass} min-h-20 py-2 font-mono text-xs`}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          spellCheck={false}
          value={value}
        />
      )}
    />
  );
}

function ProviderHints() {
  return (
    <details className="rounded-[10px] border border-trace-subtle bg-control-surface px-3 py-2.5 text-xs leading-5 text-ink-secondary">
      <summary className="cursor-pointer font-medium text-ink">Provider notes</summary>
      <ul className="mt-2 list-disc space-y-1.5 pl-4">
        <li>
          <strong className="font-medium text-ink">Entra ID:</strong> use the tenant&apos;s own issuer
          (<code className="font-mono [overflow-wrap:anywhere]">https://login.microsoftonline.com/&lt;tenant-id&gt;/v2.0</code>),
          never <code className="font-mono">common</code> or <code className="font-mono">organizations</code>. The groups claim
          carries group object IDs, so name AIQSA groups by ID. Above 200 groups Entra sends no list and memberships stay as
          they are. Entra sends no <code className="font-mono">email_verified</code>. SCIM needs a separate enterprise app.
        </li>
        <li>
          <strong className="font-medium text-ink">Keycloak:</strong> add a Group Membership mapper to the client; it sends
          full paths such as <code className="font-mono">/team</code> unless full path is off. Realm roles are at
          <code className="font-mono"> realm_access.roles</code>, client roles at
          <code className="font-mono"> resource_access.&lt;client&gt;.roles</code>. A mapper that adds groups only to
          userinfo needs groups from userinfo.
        </li>
        <li>
          <strong className="font-medium text-ink">Authentik:</strong> the <code className="font-mono">groups</code> claim
          comes with the <code className="font-mono">profile</code> scope. Its default email scope reports
          <code className="font-mono"> email_verified</code> as false, so linking existing accounts needs a verified-email
          mapping or the trust switch below.
        </li>
      </ul>
    </details>
  );
}

/** Generic OpenID Connect: issuer, client, claims and the shared admission and group policy. */
export function OidcSignInCard({ appBaseUrl, controller, state }: AdminSignInMethodCardProps<"oidc">) {
  const saved = useMemo(() => formFrom(state.draft.config), [state.draft.config]);
  const [edits, setEdits] = useState<Partial<OidcForm>>({});
  const [clientSecret, setClientSecret] = useState("");
  const [errors, setErrors] = useState<OidcFormErrors>({});
  const form: OidcForm = { ...saved, ...edits };
  const secretConfigured = state.draft.secrets.clientSecret === true;
  const busy = controller.state.busy !== null;
  const dirty = (Object.keys(edits) as (keyof OidcForm)[]).some((key) => edits[key] !== saved[key]) || clientSecret.length > 0;

  const update = <K extends keyof OidcForm>(key: K, value: OidcForm[K]) => {
    setEdits((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const draft = useMemo(() => ({
    build() {
      const form: OidcForm = { ...saved, ...edits };
      const nextErrors = validate(form, !secretConfigured && !clientSecret);
      setErrors(nextErrors);
      if (Object.keys(nextErrors).length) return null;
      return {
        config: {
          adminGroups: groupLines(form.adminGroups),
          allowedGroups: groupLines(form.allowedGroups),
          autoCreateUsers: form.autoCreateUsers,
          autoRedirect: form.autoRedirect,
          buttonLabel: form.buttonLabel.trim(),
          clientId: form.clientId.trim(),
          groupsClaimPath: form.groupsClaimPath.trim(),
          groupsFrom: form.groupsFrom,
          idpLogout: form.idpLogout,
          issuer: form.issuer.trim(),
          scopes: form.scopes.trim().split(/\s+/u).join(" "),
          syncGroups: form.syncGroups,
          trustUnverifiedEmail: form.trustUnverifiedEmail
        } satisfies OidcConfig,
        secretActions: { clientSecret: signInSecretAction(clientSecret) }
      };
    },
    dirty,
    reset() {
      setEdits({});
      setClientSecret("");
      setErrors({});
    }
  }), [clientSecret, dirty, edits, saved, secretConfigured]);

  return (
    <SignInMethodCardFrame
      controller={controller}
      copyValues={[
        { label: "Redirect URI", value: appUrl(appBaseUrl, "/api/auth/oauth/oidc/callback") },
        { label: "Post-logout redirect URI", value: appUrl(appBaseUrl, "/login") }
      ]}
      description="Any OpenID Connect provider (Entra ID, Keycloak, Authentik, Okta, Google Workspace). People sign in with the provider's account; its groups can admit them, make them administrators and keep AIQSA group memberships in sync."
      draft={draft}
      state={state}
      title="OpenID Connect"
    >
      <ProviderHints />
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SignInTextField
          disabled={busy}
          error={errors.issuer}
          help="Exactly as the provider's discovery document names it."
          label="Issuer"
          onChange={(value) => update("issuer", value)}
          placeholder="https://idp.example.com/realms/main"
          value={form.issuer}
        />
        <SignInTextField
          disabled={busy}
          error={errors.buttonLabel}
          help="Shown on the sign-in page as Continue with …"
          label="Button label"
          onChange={(value) => update("buttonLabel", value)}
          value={form.buttonLabel}
        />
        <SignInTextField
          disabled={busy}
          error={errors.clientId}
          label="Client ID"
          onChange={(value) => update("clientId", value)}
          value={form.clientId}
        />
        <SignInSecretField
          configured={secretConfigured}
          disabled={busy}
          error={errors.clientSecret}
          label="Client secret"
          onChange={(value) => {
            setClientSecret(value);
            setErrors((current) => ({ ...current, clientSecret: undefined }));
          }}
          value={clientSecret}
        />
        <SignInTextField
          disabled={busy}
          error={errors.scopes}
          label="Scopes"
          onChange={(value) => update("scopes", value)}
          value={form.scopes}
        />
        <SignInTextField
          disabled={busy}
          error={errors.groupsClaimPath}
          help="A claim name or dot path: groups, realm_access.roles, resource_access.aiqsa.roles; a namespaced claim such as https://example.com/groups is read whole."
          label="Groups claim"
          onChange={(value) => update("groupsClaimPath", value)}
          value={form.groupsClaimPath}
        />
        <SignInField
          help="Where the groups claim is read. Userinfo is asked only when the ID token has none."
          label="Groups from"
          render={(props) => (
            <select
              {...props}
              className={inputClass}
              disabled={busy}
              onChange={(event) => update("groupsFrom", event.currentTarget.value as GroupsFrom)}
              value={form.groupsFrom}
            >
              {OIDC_GROUPS_FROM.map((value) => <option key={value} value={value}>{groupsFromLabels[value]}</option>)}
            </select>
          )}
        />
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <GroupListField
          disabled={busy}
          error={errors.allowedGroups}
          help="One value per line. Empty admits everyone the provider signs in; otherwise only members, and a sign-in without the claim is refused."
          label="Allowed groups"
          onChange={(value) => update("allowedGroups", value)}
          value={form.allowedGroups}
        />
        <GroupListField
          disabled={busy}
          error={errors.adminGroups}
          help="Members become administrators; the provider removes the role only from administrators it granted."
          label="Administrator groups"
          onChange={(value) => update("adminGroups", value)}
          value={form.adminGroups}
        />
      </div>
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <CheckboxRow
          checked={form.syncGroups}
          disabled={busy}
          help="Keeps memberships of AIQSA groups that have an OIDC external name; other groups are never touched."
          label="Sync groups"
          onChange={(value) => update("syncGroups", value)}
        />
        <CheckboxRow
          checked={form.autoCreateUsers}
          disabled={busy}
          help="Off: only existing accounts can sign in."
          label="Create accounts"
          onChange={(value) => update("autoCreateUsers", value)}
        />
        <CheckboxRow
          checked={form.trustUnverifiedEmail}
          disabled={busy}
          help="Links existing accounts by an email the provider did not mark verified. Only for a provider you control."
          label="Trust unverified email"
          onChange={(value) => update("trustUnverifiedEmail", value)}
        />
        <CheckboxRow
          checked={form.autoRedirect}
          disabled={busy}
          help="The sign-in page goes straight to the provider; /login?local=1 still shows every method."
          label="Redirect to the provider"
          onChange={(value) => update("autoRedirect", value)}
        />
        <CheckboxRow
          checked={form.idpLogout}
          disabled={busy}
          help="Signing out of AIQSA also opens the provider's logout page."
          label="Sign out at the provider"
          onChange={(value) => update("idpLogout", value)}
        />
      </div>
    </SignInMethodCardFrame>
  );
}
