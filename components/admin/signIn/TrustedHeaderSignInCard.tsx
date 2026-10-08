"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import {
  SignInField,
  SignInMethodCardFrame,
  SignInTextField,
  type AdminSignInMethodCardProps
} from "@/components/admin/signIn/SignInMethodCardFrame";
import { UiV2Button } from "@/components/ui-v2";
import { trustedHeaderSignInConfigSchema } from "@/lib/contracts/authSignInMethods";
import {
  isAdminTrustedHeaderProbe,
  TRUSTED_HEADER_PRESETS,
  type AdminTrustedHeaderProbe,
  type ClientIdentityModeName
} from "@/lib/contracts/trustedHeaderSignIn";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type FormValues = {
  adminGroups: string;
  allowedGroups: string;
  autoCreateUsers: boolean;
  emailHeader: string;
  groupsHeader: string;
  groupsSeparator: string;
  nameHeader: string;
  syncGroups: boolean;
};

type FieldErrors = Partial<Record<keyof FormValues, string>>;

const fieldMessages: Partial<Record<keyof FormValues, string>> = {
  adminGroups: "Up to 100 values, one per line, without control characters.",
  allowedGroups: "Up to 100 values, one per line, without control characters.",
  emailHeader: "Enter a header name, such as X-Auth-Request-Email.",
  groupsHeader: "Enter a header name, or leave it empty.",
  groupsSeparator: "Enter one to eight characters.",
  nameHeader: "Enter a header name, or leave it empty."
};

const modeLabels: Record<ClientIdentityModeName, string> = {
  direct_loopback: "direct (loopback)",
  direct_peer: "direct (network peer)",
  invalid: "invalid",
  trusted_proxy: "trusted proxy"
};

function formValues(config: AdminSignInMethodCardProps<"trusted_header">["state"]["draft"]["config"]): FormValues {
  return {
    adminGroups: config?.adminGroups.join("\n") ?? "",
    allowedGroups: config?.allowedGroups.join("\n") ?? "",
    autoCreateUsers: config?.autoCreateUsers ?? true,
    emailHeader: config?.emailHeader ?? "",
    groupsHeader: config?.groupsHeader ?? "",
    groupsSeparator: config?.groupsSeparator ?? ",",
    nameHeader: config?.nameHeader ?? "",
    syncGroups: config?.syncGroups ?? false
  };
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Probes the administrator's own request; the header value comes back only as a domain hint. */
export async function requestTrustedHeaderProbe(
  emailHeader: string,
  fetcher: Fetcher = fetch
): Promise<AdminTrustedHeaderProbe | null> {
  const query = emailHeader ? `?${new URLSearchParams({ emailHeader })}` : "";
  try {
    const response = await fetcher(`/api/admin/sign-in/trusted-header${query}`, { cache: "no-store", method: "GET" });
    const value: unknown = await response.json().catch(() => null);
    return response.ok && isAdminTrustedHeaderProbe(value) ? value : null;
  } catch {
    return null;
  }
}

/** A valid header name to probe for, or "" to ask for the mode alone. */
function probeHeaderName(value: string): string {
  const header = trustedHeaderSignInConfigSchema.shape.emailHeader.safeParse(value);
  return header.success ? header.data : "";
}

function ProxyModePanel({ emailHeader }: Readonly<{ emailHeader: string }>) {
  const [probe, setProbe] = useState<AdminTrustedHeaderProbe | null>(null);
  const [checking, setChecking] = useState(true);
  const [failed, setFailed] = useState(false);
  const [checkedHeader, setCheckedHeader] = useState("");
  const [initialHeader] = useState(emailHeader);
  const mountedRef = useRef(false);

  const apply = useCallback((name: string, result: AdminTrustedHeaderProbe | null) => {
    if (!mountedRef.current) return;
    setChecking(false);
    setFailed(result === null);
    setProbe(result);
    setCheckedHeader(name);
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const name = probeHeaderName(initialHeader);
    void requestTrustedHeaderProbe(name).then((result) => apply(name, result));
    return () => {
      mountedRef.current = false;
    };
  }, [apply, initialHeader]);

  const check = async () => {
    const name = probeHeaderName(emailHeader);
    setChecking(true);
    apply(name, await requestTrustedHeaderProbe(name));
  };

  const trusted = probe?.clientIdentityMode === "trusted_proxy";
  const header = probe?.emailHeader ?? null;

  return (
    <div
      className="grid gap-2 rounded-[10px] border border-trace-subtle bg-control-surface px-3 py-2.5 text-xs leading-5 text-ink-secondary"
      data-mode={probe?.clientIdentityMode}
      data-testid="trusted-header-mode"
    >
      {failed ? (
        <p className="text-critical" role="alert">The proxy mode could not be checked. Try again.</p>
      ) : probe ? (
        <>
          <p className={trusted ? "text-positive" : "text-critical"}>
            Client identity mode: <strong>{modeLabels[probe.clientIdentityMode]}</strong>.{" "}
            {trusted
              ? "AIQSA trusts the proxy in front of it, so this method can sign people in."
              : "AIQSA ignores identity headers in this mode, so this method cannot be activated or sign anyone in."}
          </p>
          {trusted ? null : (
            <p>
              Trusted-proxy mode is set only in the environment: <code className="font-mono text-metadata">AIQSA_TRUST_PROXY_HEADERS=true</code>{" "}
              with the app bound to loopback (<code className="font-mono text-metadata">AIQSA_BIND_ADDRESS</code>) behind the proxy,
              and <code className="font-mono text-metadata">AIQSA_TRUSTED_PROXY_COUNT</code> for chained proxies, then a restart.
            </p>
          )}
          {header ? (
            <p data-testid="trusted-header-probe">
              {!header.present
                ? `This request does not carry ${checkedHeader}. Check the header name and that the proxy sets it on every request.`
                : header.usable
                  ? `This request carries ${checkedHeader} with an address at ${header.domainHint ?? "a valid domain"}.`
                  : `This request carries ${checkedHeader}, but its value is not a usable email address.`}
            </p>
          ) : null}
        </>
      ) : (
        <p>Checking the proxy mode…</p>
      )}
      <p>
        The proxy must set these headers on every request and overwrite any the browser sends. Anyone who reaches AIQSA
        around the proxy could otherwise sign in as anyone.
      </p>
      <div>
        <UiV2Button busy={checking} disabled={checking} onClick={() => void check()} tone="ghost" type="button">
          Check this request
        </UiV2Button>
      </div>
    </div>
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
          rows={3}
          spellCheck={false}
          value={value}
        />
      )}
    />
  );
}

function CheckboxField({
  checked,
  disabled,
  label,
  onChange
}: Readonly<{ checked: boolean; disabled: boolean; label: string; onChange(checked: boolean): void }>) {
  return (
    <label className="flex min-h-touch items-center gap-2 text-sm text-ink-secondary">
      <input
        checked={checked}
        className="size-4 shrink-0 accent-proof"
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
        type="checkbox"
      />
      {label}
    </label>
  );
}

/** Trusted header: identity headers set by an authenticating reverse proxy. */
export function TrustedHeaderSignInCard({ controller, state }: AdminSignInMethodCardProps<"trusted_header">) {
  const saved = useMemo(() => formValues(state.draft.config), [state.draft.config]);
  const [edits, setEdits] = useState<Partial<FormValues>>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const values: FormValues = { ...saved, ...edits };
  const dirty = (Object.keys(edits) as (keyof FormValues)[]).some((key) => edits[key] !== saved[key]);
  const busy = controller.state.busy !== null;

  const change = <K extends keyof FormValues>(key: K, value: FormValues[K]) => {
    setEdits((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const draft = useMemo(() => ({
    build() {
      const parsed = trustedHeaderSignInConfigSchema.safeParse({
        adminGroups: lines(values.adminGroups),
        allowedGroups: lines(values.allowedGroups),
        autoCreateUsers: values.autoCreateUsers,
        emailHeader: values.emailHeader.trim(),
        groupsHeader: values.groupsHeader.trim() || null,
        groupsSeparator: values.groupsSeparator,
        nameHeader: values.nameHeader.trim() || null,
        syncGroups: values.syncGroups
      });
      if (!parsed.success) {
        const nextErrors: FieldErrors = {};
        for (const issue of parsed.error.issues) {
          const key = issue.path[0] as keyof FormValues;
          nextErrors[key] = fieldMessages[key] ?? "Check this field.";
        }
        setErrors(nextErrors);
        return null;
      }
      return { config: parsed.data, secretActions: {} };
    },
    dirty,
    reset() {
      setEdits({});
      setErrors({});
    }
  }), [dirty, values.adminGroups, values.allowedGroups, values.autoCreateUsers, values.emailHeader,
    values.groupsHeader, values.groupsSeparator, values.nameHeader, values.syncGroups]);

  return (
    <SignInMethodCardFrame
      controller={controller}
      description={
        "People already signed in at an authenticating reverse proxy (oauth2-proxy, Authelia, Authentik, Cloudflare Access) " +
        "are signed in from the identity headers it sets. The proxy vouches for the email: it links to an existing account " +
        "with that address, and a changed address is a new identity."
      }
      draft={draft}
      state={state}
    >
      <ProxyModePanel emailHeader={values.emailHeader} />
      <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label="Header presets">
        <span className="text-xs font-medium text-ink-secondary">Presets:</span>
        {TRUSTED_HEADER_PRESETS.map((preset) => (
          <UiV2Button
            disabled={busy}
            key={preset.label}
            onClick={() => {
              change("emailHeader", preset.emailHeader);
              change("nameHeader", preset.nameHeader ?? "");
              change("groupsHeader", preset.groupsHeader ?? "");
              change("groupsSeparator", preset.groupsSeparator);
            }}
            tone="ghost"
            type="button"
          >
            {preset.label}
          </UiV2Button>
        ))}
      </div>
      <div className="grid min-w-0 gap-4 md:grid-cols-2">
        <SignInTextField
          disabled={busy}
          error={errors.emailHeader}
          label="Email header"
          onChange={(value) => change("emailHeader", value)}
          placeholder="X-Auth-Request-Email"
          value={values.emailHeader}
        />
        <SignInTextField
          disabled={busy}
          error={errors.nameHeader}
          help="Optional display name."
          label="Name header"
          onChange={(value) => change("nameHeader", value)}
          value={values.nameHeader}
        />
        <SignInTextField
          disabled={busy}
          error={errors.groupsHeader}
          help="Optional. Without it, sign-ins carry no groups."
          label="Groups header"
          onChange={(value) => change("groupsHeader", value)}
          value={values.groupsHeader}
        />
        <SignInTextField
          disabled={busy}
          error={errors.groupsSeparator}
          label="Groups separator"
          onChange={(value) => change("groupsSeparator", value)}
          value={values.groupsSeparator}
        />
        <GroupListField
          disabled={busy}
          error={errors.allowedGroups}
          help="One per line. Empty admits everyone the proxy authenticated; set, it refuses sign-ins without the groups header."
          label="Allowed groups"
          onChange={(value) => change("allowedGroups", value)}
          value={values.allowedGroups}
        />
        <GroupListField
          disabled={busy}
          error={errors.adminGroups}
          help="One per line. Members become administrators; the proxy demotes only administrators it promoted."
          label="Administrator groups"
          onChange={(value) => change("adminGroups", value)}
          value={values.adminGroups}
        />
      </div>
      <div className="grid min-w-0 gap-1 sm:grid-cols-2">
        <CheckboxField
          checked={values.autoCreateUsers}
          disabled={busy}
          label="Create accounts for new people"
          onChange={(checked) => change("autoCreateUsers", checked)}
        />
        <CheckboxField
          checked={values.syncGroups}
          disabled={busy}
          label="Sync groups with external names"
          onChange={(checked) => change("syncGroups", checked)}
        />
      </div>
    </SignInMethodCardFrame>
  );
}
