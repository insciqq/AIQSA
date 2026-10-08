"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { loadSamlMetadata } from "@/components/admin/signIn/samlSignInApi";
import {
  SAML_NAME_ID_FORMAT_OPTIONS,
  samlCardForm,
  samlConfigFromForm,
  samlMetadataImportMessage,
  type SamlCardField,
  type SamlCardForm
} from "@/components/admin/signIn/samlSignInView";
import {
  SignInField,
  SignInMethodCardFrame,
  SignInTextField,
  type AdminSignInMethodCardProps
} from "@/components/admin/signIn/SignInMethodCardFrame";
import { formatSignInTime } from "@/components/admin/signIn/signInView";
import { UiV2Button } from "@/components/ui-v2";
import { samlServiceProvider, type AdminSamlMetadata, type AdminSamlMetadataRequest } from "@/lib/contracts/samlSignIn";
import { useId, useMemo, useState, type ReactNode } from "react";

const textAreaClass = `${inputClass} min-h-[88px] py-2 font-mono text-xs leading-5`;
const codeClass = "font-mono text-metadata [overflow-wrap:anywhere]";

function TextAreaField({
  error,
  help,
  label,
  onChange,
  placeholder,
  value
}: Readonly<{
  error?: string;
  help?: ReactNode;
  label: string;
  onChange(value: string): void;
  placeholder?: string;
  value: string;
}>) {
  return (
    <SignInField
      error={error}
      help={help}
      label={label}
      render={(props) => (
        <textarea
          {...props}
          className={textAreaClass}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder={placeholder}
          spellCheck={false}
          value={value}
        />
      )}
    />
  );
}

function CheckboxField({
  checked,
  error,
  help,
  label,
  onChange
}: Readonly<{ checked: boolean; error?: string; help: string; label: string; onChange(checked: boolean): void }>) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <input
        aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
        aria-invalid={error ? true : undefined}
        checked={checked}
        className="mt-0.5 size-4 shrink-0 accent-proof"
        id={id}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      <div className="min-w-0">
        <label className="block text-sm text-ink" htmlFor={id}>{label}</label>
        <span className="block text-xs leading-5 text-ink-muted" id={`${id}-help`}>{help}</span>
        {error ? <span className="block text-xs leading-5 text-critical" id={`${id}-error`}>{error}</span> : null}
      </div>
    </div>
  );
}

function Section({ children, title }: Readonly<{ children: ReactNode; title: string }>) {
  return (
    <div className="grid min-w-0 gap-3">
      <h4 className={sectionHeadingClass}>{title}</h4>
      {children}
    </div>
  );
}

/** Reads IdP metadata on the server and hands the values to the card for review; nothing is saved. */
function MetadataImport({ onLoaded }: Readonly<{ onLoaded(metadata: AdminSamlMetadata, metadataUrl: string | null): void }>) {
  const [url, setUrl] = useState("");
  const [xml, setXml] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: "error" | "ok" } | null>(null);

  const load = async (request: AdminSamlMetadataRequest) => {
    setLoading(true);
    setMessage(null);
    const result = await loadSamlMetadata(request);
    setLoading(false);
    if (!result.ok) {
      setMessage({ text: samlMetadataImportMessage(result.error), tone: "error" });
      return;
    }
    onLoaded(result.metadata, "metadataUrl" in request ? request.metadataUrl : null);
    const expiries = result.metadata.certificates.map((certificate) => formatSignInTime(certificate.validTo) ?? certificate.validTo);
    setMessage({
      text: `Loaded the entity ID, the sign-in URL and ${expiries.length === 1 ? "1 certificate" : `${expiries.length} certificates`} ` +
        `(valid until ${expiries.join(", ")}). Review them below, then save.`,
      tone: "ok"
    });
  };

  return (
    <div className="grid min-w-0 gap-3 rounded-[10px] border border-trace-subtle bg-control-surface px-3 py-3" data-testid="admin-saml-metadata-import">
      <SignInField
        help="AIQSA reads it once and fills the fields below; private network addresses work, AIQSA's own services do not."
        label="Load from IdP metadata URL"
        render={(props) => (
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input
              {...props}
              autoComplete="off"
              className={`${inputClass} min-w-0 flex-1`}
              onChange={(event) => setUrl(event.currentTarget.value)}
              onKeyDown={(event) => {
                // Enter loads the metadata instead of saving the card.
                if (event.key !== "Enter") return;
                event.preventDefault();
                if (url.trim() && !loading) void load({ metadataUrl: url.trim() });
              }}
              placeholder="https://idp.example.com/realms/acme/protocol/saml/descriptor"
              spellCheck={false}
              type="url"
              value={url}
            />
            <UiV2Button busy={loading} disabled={!url.trim()} onClick={() => void load({ metadataUrl: url.trim() })} tone="ghost" type="button">
              Load
            </UiV2Button>
          </div>
        )}
      />
      <details className="min-w-0">
        <summary className="cursor-pointer text-xs font-medium text-ink-secondary">Paste metadata XML instead</summary>
        <div className="mt-2 grid min-w-0 gap-2">
          <TextAreaField label="IdP metadata XML" onChange={setXml} placeholder="<md:EntityDescriptor …>" value={xml} />
          <div>
            <UiV2Button busy={loading} disabled={!xml.trim()} onClick={() => void load({ metadataXml: xml })} tone="ghost" type="button">
              Load pasted metadata
            </UiV2Button>
          </div>
        </div>
      </details>
      {message ? (
        <p
          className={`text-xs leading-5 ${message.tone === "error" ? "text-critical" : "text-ink-secondary"}`}
          data-testid="admin-saml-metadata-message"
          role={message.tone === "error" ? "alert" : "status"}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

/** Where the common identity providers keep the values this card needs. */
function IdentityProviderHints() {
  return (
    <details className="min-w-0 rounded-[10px] border border-trace-subtle px-3 py-2.5 text-xs leading-5 text-ink-secondary" data-testid="admin-saml-hints">
      <summary className="cursor-pointer font-medium">Identity provider hints</summary>
      <ul className="mt-2 grid list-disc gap-2 pl-4">
        <li>
          <strong className="font-medium text-ink">Microsoft Entra ID, ADFS:</strong> Identifier = SP entity ID, Reply URL = ACS URL.
          Email attribute <code className={codeClass}>http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress</code>;
          groups attribute <code className={codeClass}>http://schemas.microsoft.com/ws/2008/06/identity/claims/groups</code> (Entra
          sends group object IDs, so external names are IDs).
        </li>
        <li>
          <strong className="font-medium text-ink">Keycloak:</strong> client ID = SP entity ID, valid redirect URI = ACS URL. Turn on
          Sign assertions and turn off Client signature required (AIQSA does not sign requests); Name ID format persistent with
          Force name ID format. Group list mapper <code className={codeClass}>groups</code> with Full group path off, or the role list
          mapper <code className={codeClass}>Role</code>; a User Property mapper for <code className={codeClass}>email</code>.
        </li>
        <li>
          <strong className="font-medium text-ink">Authentik:</strong> SAML provider with ACS URL and Audience = SP entity ID and a
          signing certificate; groups arrive in <code className={codeClass}>http://schemas.xmlsoap.org/claims/Group</code>.
        </li>
      </ul>
    </details>
  );
}

/**
 * SAML 2.0: the IdP pinned by its entity ID and signing certificates, the attributes AIQSA
 * reads, the signature requirements and the shared access policy. Metadata loads only fill
 * the fields; the administrator saves, tests and activates as for every method.
 */
export function SamlSignInCard({ appBaseUrl, controller, state }: AdminSignInMethodCardProps<"saml">) {
  const saved = useMemo(() => samlCardForm(state.draft.config), [state.draft.config]);
  const [form, setForm] = useState<SamlCardForm | null>(null);
  const [errors, setErrors] = useState<Partial<Record<SamlCardField, string>>>({});
  const current = form ?? saved;
  const dirty = form !== null && (Object.keys(form) as SamlCardField[]).some((field) => form[field] !== saved[field]);
  const serviceProvider = samlServiceProvider(appBaseUrl, current.spEntityId.trim() || null);
  const nameIdFormats = SAML_NAME_ID_FORMAT_OPTIONS.some((option) => option.value === current.nameIdFormat)
    ? SAML_NAME_ID_FORMAT_OPTIONS
    : [...SAML_NAME_ID_FORMAT_OPTIONS, { label: current.nameIdFormat, value: current.nameIdFormat }];

  const update = <Field extends SamlCardField>(field: Field, value: SamlCardForm[Field]) => {
    setForm({ ...current, [field]: value });
    setErrors((existing) => ({ ...existing, [field]: undefined }));
  };
  const text = (field: SamlCardField, label: string, input: { help?: ReactNode; placeholder?: string } = {}) => (
    <SignInTextField
      disabled={controller.state.busy !== null}
      error={errors[field]}
      help={input.help}
      label={label}
      onChange={(value) => update(field, value)}
      placeholder={input.placeholder}
      value={current[field] as string}
    />
  );
  const checkbox = (field: SamlCardField, label: string, help: string) => (
    <CheckboxField
      checked={current[field] as boolean}
      error={errors[field]}
      help={help}
      label={label}
      onChange={(checked) => update(field, checked)}
    />
  );

  const draft = useMemo(() => ({
    build() {
      const result = samlConfigFromForm(current);
      if (!result.ok) {
        setErrors(result.errors);
        return null;
      }
      setErrors({});
      return { config: result.config, secretActions: {} };
    },
    dirty,
    reset() {
      setForm(null);
      setErrors({});
    }
  }), [current, dirty]);

  return (
    <SignInMethodCardFrame
      controller={controller}
      copyValues={[
        { label: "SP entity ID (Audience)", value: serviceProvider.entityId },
        { label: "ACS URL (Reply URL)", value: serviceProvider.acsUrl },
        { label: "SP metadata URL", value: serviceProvider.metadataUrl }
      ]}
      description="SAML 2.0 sign-in started from AIQSA (Entra ID, ADFS, Keycloak, Authentik, Okta and others). Responses must be signed with a pinned IdP certificate; a groups attribute can admit people, sync mapped groups and grant the admin role."
      draft={draft}
      state={state}
    >
      <Section title="Identity provider">
        <MetadataImport
          onLoaded={(metadata, metadataUrl) => {
            setForm({
              ...current,
              idpCertificates: metadata.certificates.map((certificate) => certificate.pem).join("\n\n"),
              idpEntityId: metadata.entityId,
              idpMetadataUrl: metadataUrl ?? current.idpMetadataUrl,
              idpSsoUrl: metadata.ssoUrl
            });
            setErrors({});
          }}
        />
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          {text("idpEntityId", "IdP entity ID", { placeholder: "https://idp.example.com/realms/acme" })}
          {text("idpSsoUrl", "IdP sign-in URL (HTTP-Redirect)", { placeholder: "https://idp.example.com/realms/acme/protocol/saml" })}
        </div>
        <TextAreaField
          error={errors.idpCertificates}
          help="One or more PEM certificates. Add the IdP's next certificate here before it rotates its key."
          label="IdP signing certificates"
          onChange={(value) => update("idpCertificates", value)}
          placeholder={"-----BEGIN CERTIFICATE-----\nMIIC…\n-----END CERTIFICATE-----"}
          value={current.idpCertificates}
        />
        {text("idpMetadataUrl", "IdP metadata URL (optional)", {
          help: "Test checks that the IdP still publishes this entity ID, sign-in URL and a pinned certificate."
        })}
      </Section>

      <Section title="Service provider">
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          {text("spEntityId", "SP entity ID (optional)", { help: "Blank uses the SP metadata URL.", placeholder: serviceProvider.metadataUrl })}
          <SignInField
            label="NameID format"
            render={(props) => (
              <select
                {...props}
                className={inputClass}
                onChange={(event) => update("nameIdFormat", event.currentTarget.value)}
                value={current.nameIdFormat}
              >
                {nameIdFormats.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            )}
          />
        </div>
        {text("subjectAttribute", "Subject attribute (optional)", {
          help: "Blank uses the NameID. A stable, never-reused user ID; a transient NameID needs one."
        })}
      </Section>

      <Section title="Attributes">
        <div className="grid min-w-0 gap-4 md:grid-cols-3">
          {text("emailAttribute", "Email attribute", { placeholder: "email" })}
          {text("displayNameAttribute", "Display name attribute (optional)", { placeholder: "displayName" })}
          {text("groupsAttribute", "Groups attribute (optional)", { placeholder: "groups" })}
        </div>
      </Section>

      <Section title="Signatures">
        {checkbox("requireSignedAssertion", "Require signed assertions", "Recommended; Keycloak calls it Sign assertions.")}
        {checkbox("requireSignedResponse", "Require signed responses", "The whole response must carry the IdP's signature too.")}
        {checkbox("allowSha1", "Allow SHA-1 signatures", "Only for an IdP that cannot sign with SHA-256. SHA-1 is weak.")}
      </Section>

      <Section title="Access">
        <div className="grid min-w-0 gap-4 md:grid-cols-2">
          <TextAreaField
            error={errors.allowedGroups}
            help="One exact value per line. Empty admits everyone the IdP signs in."
            label="Allowed groups"
            onChange={(value) => update("allowedGroups", value)}
            value={current.allowedGroups}
          />
          <TextAreaField
            error={errors.adminGroups}
            help="Members become administrators; the IdP removes only the admin role it granted."
            label="Admin groups"
            onChange={(value) => update("adminGroups", value)}
            value={current.adminGroups}
          />
        </div>
        {checkbox("syncGroups", "Sync group memberships", "Keeps memberships of groups that have a SAML external name; no group is created.")}
        {checkbox("autoCreateUsers", "Create accounts on first sign-in", "Off: only people who already have an account can sign in.")}
        {checkbox(
          "trustUnverifiedEmail",
          "Trust the IdP's email addresses",
          "SAML does not mark addresses as verified. Turn on only if this IdP owns its users' emails: then it links to existing accounts by email."
        )}
        {text("buttonLabel", "Button label", { help: "Shown on the sign-in page as \"Continue with …\".", placeholder: "SAML" })}
      </Section>

      <IdentityProviderHints />
    </SignInMethodCardFrame>
  );
}
