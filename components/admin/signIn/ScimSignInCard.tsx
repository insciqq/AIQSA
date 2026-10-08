"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import {
  SignInCopyValue,
  SignInField,
  SignInMethodCardFrame,
  type AdminSignInMethodCardProps,
  type SignInHealthWording
} from "@/components/admin/signIn/SignInMethodCardFrame";
import { changeScimTokens, requestScimTokens, scimTokenErrorMessage } from "@/components/admin/signIn/scimTokensApi";
import { appUrl, formatSignInTime } from "@/components/admin/signIn/signInView";
import { UiV2Button } from "@/components/ui-v2";
import { ADMIN_SCIM_ACTIVE_TOKEN_MAX, type AdminScimToken, type AdminScimTokenRequest } from "@/lib/contracts/adminScim";
import { SCIM_LINK_METHODS, type ScimLinkMethod } from "@/lib/contracts/authSignInMethods";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const helpClass = "text-xs leading-5 text-ink-muted";

const linkMethodLabels: Record<ScimLinkMethod, string> = {
  ldap: "LDAP",
  none: "Do not link",
  oidc: "OIDC",
  saml: "SAML"
};

const scimFailureMessages: Record<string, string> = {
  admin_disabled: "an administrator disabled the account, so SCIM could not re-enable it",
  invalid_request: "the identity provider sent a request AIQSA could not accept",
  last_admin: "the deactivation would have left no active administrator",
  owner_transfer_required: "a deactivated user still owns Projects alone; transfer their ownership",
  request_failed: "AIQSA could not complete the request",
  token_invalid: "the bearer token is unknown or revoked",
  uniqueness: "a user or group with that name or external ID already exists"
};

const scimHealthWording: SignInHealthWording = {
  describeFailure: (code) => scimFailureMessages[code] ?? code,
  subject: "SCIM request"
};

/** The SCIM bearer tokens, owned by the card; a new token stays in memory until dismissed. */
function useScimTokens() {
  const [tokens, setTokens] = useState<AdminScimToken[] | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  const generationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const apply = useCallback((result: Awaited<ReturnType<typeof requestScimTokens>>) => {
    if (result.ok) {
      setTokens(result.tokens);
      setError(null);
    } else {
      setError(scimTokenErrorMessage(result.error));
    }
  }, []);

  useEffect(() => {
    const generation = ++generationRef.current;
    void requestScimTokens().then((result) => {
      if (mountedRef.current && generation === generationRef.current) apply(result);
    });
  }, [apply]);

  const change = useCallback(async (body: AdminScimTokenRequest): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const generation = ++generationRef.current;
    try {
      const result = await changeScimTokens(body);
      if (!mountedRef.current) return false;
      if (!result.ok) {
        setError(scimTokenErrorMessage(result.error));
        if (result.error === "scim_token_not_found") {
          void requestScimTokens().then((latest) => {
            if (mountedRef.current && generation === generationRef.current && latest.ok) setTokens(latest.tokens);
          });
        }
        return false;
      }
      setTokens(result.tokens);
      // A revoke returns no token: a new one not yet dismissed stays on screen.
      if (result.token !== null) setIssued(result.token);
      return true;
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, []);

  return { busy, change, dismissIssued: () => setIssued(null), error, issued, tokens };
}

function TokenRow({
  busy,
  onChange,
  token
}: Readonly<{ busy: boolean; onChange(body: AdminScimTokenRequest): Promise<boolean>; token: AdminScimToken }>) {
  const [confirm, setConfirm] = useState<"revoke" | "rotate" | null>(null);
  const revoked = token.revokedAt !== null;
  const usage = revoked
    ? `Revoked ${formatSignInTime(token.revokedAt) ?? ""}`
    : token.lastUsedAt
      ? `Last used ${formatSignInTime(token.lastUsedAt) ?? ""}`
      : "Not used yet";

  return (
    <li className="flex min-w-0 flex-col gap-2 py-2.5" data-revoked={revoked ? "true" : "false"} data-testid="admin-scim-token">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <p className={`break-all font-mono text-xs ${revoked ? "text-ink-muted line-through" : "text-ink"}`}>{token.displayPrefix}…</p>
          <p className={helpClass}>Created {formatSignInTime(token.createdAt) ?? "—"} · {usage}</p>
        </div>
        {!revoked && confirm === null ? (
          <div className="flex flex-wrap gap-2">
            <UiV2Button disabled={busy} onClick={() => setConfirm("rotate")} tone="ghost" type="button">
              Rotate
            </UiV2Button>
            <UiV2Button disabled={busy} onClick={() => setConfirm("revoke")} tone="ghost" type="button">
              Revoke
            </UiV2Button>
          </div>
        ) : null}
      </div>
      {confirm ? (
        <div
          className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-caution/25 bg-caution/5 px-3 py-2.5"
          data-testid="admin-scim-token-confirm"
          role="group"
        >
          <p className="text-xs leading-5 text-ink-secondary">
            {confirm === "revoke"
              ? "The identity provider can no longer provision with this token: its requests are refused at once."
              : "A new token replaces this one at once. Paste it into the identity provider right away: requests with the old token are refused from now on."}
          </p>
          <div className="flex flex-wrap gap-2">
            <UiV2Button
              busy={busy}
              onClick={() => void onChange({ action: confirm, tokenId: token.id }).then((done) => {
                if (done) setConfirm(null);
              })}
              tone="destructive"
              type="button"
            >
              {confirm === "revoke" ? "Revoke token" : "Rotate token"}
            </UiV2Button>
            <UiV2Button disabled={busy} onClick={() => setConfirm(null)} tone="ghost" type="button">
              Cancel
            </UiV2Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

function ScimTokens() {
  const tokens = useScimTokens();
  const list = tokens.tokens;
  const activeCount = list?.filter((token) => token.revokedAt === null).length ?? 0;

  return (
    <div className="grid min-w-0 gap-2" data-testid="admin-scim-tokens">
      <h4 className={sectionHeadingClass}>Bearer tokens</h4>
      <p className={helpClass}>
        The identity provider authenticates every SCIM request with one of these tokens. Each is shown once when it is
        created; AIQSA keeps only its hash.
      </p>
      {tokens.issued ? (
        <div
          className="flex min-w-0 flex-col gap-2 rounded-[10px] border border-caution/25 bg-caution/5 px-3 py-2.5"
          data-testid="admin-scim-token-issued"
          role="status"
        >
          <SignInCopyValue label="New SCIM token" value={tokens.issued} />
          <p className={helpClass}>Copy it now into the identity provider. It is not shown again.</p>
          <div>
            <UiV2Button onClick={tokens.dismissIssued} tone="ghost" type="button">
              Done
            </UiV2Button>
          </div>
        </div>
      ) : null}
      {list === null ? (
        <p className={helpClass}>{tokens.error ?? "Loading tokens…"}</p>
      ) : list.length ? (
        <ul aria-label="SCIM tokens" className="divide-y divide-trace-subtle">
          {list.map((token) => <TokenRow busy={tokens.busy} key={token.id} onChange={tokens.change} token={token} />)}
        </ul>
      ) : (
        <p className={helpClass}>No tokens yet.</p>
      )}
      {list !== null && tokens.error ? (
        <p className="text-xs leading-5 text-critical" role="alert">{tokens.error}</p>
      ) : null}
      <div>
        <UiV2Button
          busy={tokens.busy}
          disabled={tokens.busy || list === null || activeCount >= ADMIN_SCIM_ACTIVE_TOKEN_MAX}
          icon="plus"
          onClick={() => void tokens.change({ action: "create" })}
          tone="ghost"
          type="button"
        >
          Generate token
        </UiV2Button>
      </div>
    </div>
  );
}

/** SCIM: the base URL and bearer tokens for the IdP, and the method SCIM users link to. */
export function ScimSignInCard({ appBaseUrl, controller, state }: AdminSignInMethodCardProps<"scim">) {
  const saved = state.draft.config?.linkMethod ?? null;
  const [linkMethod, setLinkMethod] = useState<ScimLinkMethod | null>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const current = linkMethod ?? saved;
  const dirty = linkMethod !== null && linkMethod !== saved;
  const busy = controller.state.busy !== null;

  const draft = useMemo(() => ({
    build() {
      if (!current) {
        setError("Choose how SCIM users link to a sign-in method.");
        return null;
      }
      return { config: { linkMethod: current }, secretActions: {} };
    },
    dirty,
    reset() {
      setLinkMethod(null);
      setError(undefined);
    }
  }), [current, dirty]);

  return (
    <SignInMethodCardFrame
      controller={controller}
      copyValues={[{ label: "SCIM base URL", value: appUrl(appBaseUrl, "/scim/v2") }]}
      description="Your identity provider (Entra ID, Okta, Authentik and others) creates, updates and deactivates users and groups over SCIM 2.0. A deactivation ends the user's sessions and connected apps at once; a user who alone owns a Project stays active until ownership moves."
      draft={draft}
      healthWording={scimHealthWording}
      state={state}
    >
      <SignInField
        error={error}
        help="A user SCIM created signs in with this method the first time by email, even when the method does not trust unverified emails."
        label="Link SCIM users to sign-in method"
        render={(props) => (
          <select
            {...props}
            className={inputClass}
            disabled={busy}
            onChange={(event) => {
              setLinkMethod(event.currentTarget.value as ScimLinkMethod);
              setError(undefined);
            }}
            value={current ?? ""}
          >
            {current === null ? <option disabled value="">Choose…</option> : null}
            {SCIM_LINK_METHODS.map((method) => (
              <option key={method} value={method}>{linkMethodLabels[method]}</option>
            ))}
          </select>
        )}
      />
      <ScimTokens />
    </SignInMethodCardFrame>
  );
}
