"use client";

import { inputClass } from "@/components/admin/adminPrimitives";
import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import {
  adminSignInErrorMessage,
  changeAdminGroupSignIn,
  requestAdminGroupSignIn
} from "@/components/admin/signIn/adminSignInApi";
import { signInMethodLabels } from "@/components/admin/signIn/signInView";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import type { AdminGroupSignIn, AdminMembershipManager } from "@/lib/contracts/adminSignIn";
import {
  EXTERNAL_GROUP_NAME_MAX_LENGTH,
  EXTERNAL_GROUP_SOURCES,
  type ExternalGroupSource
} from "@/lib/contracts/authSignInMethods";
import { useCallback, useEffect, useId, useRef, useState } from "react";

export type AdminGroupSignInState = Readonly<{
  busy: boolean;
  error: string | null;
  group: AdminGroupSignIn | null;
  /** Members whose membership an IdP or SCIM manages. */
  managedMembers: ReadonlyMap<string, AdminMembershipManager>;
  add(source: ExternalGroupSource, value: string): Promise<string | null>;
  refresh(): Promise<void>;
  remove(externalNameId: string): Promise<string | null>;
}>;

const EMPTY_MANAGED: ReadonlyMap<string, AdminMembershipManager> = new Map();

/** One group's external names and IdP-managed members, owned by the group page. */
export function useAdminGroupSignIn(groupId: string, membershipKey: string): AdminGroupSignInState {
  const [group, setGroup] = useState<AdminGroupSignIn | null>(null);
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

  const apply = useCallback((result: Awaited<ReturnType<typeof requestAdminGroupSignIn>>) => {
    if (result.ok) {
      setGroup(result.data);
      setError(null);
    } else {
      setError(adminSignInErrorMessage(result.error));
    }
  }, []);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    const result = await requestAdminGroupSignIn(groupId);
    if (mountedRef.current && generation === generationRef.current) apply(result);
  }, [apply, groupId]);

  // Membership changes can make a member managed, so the page passes a key of its members.
  useEffect(() => {
    const generation = ++generationRef.current;
    void requestAdminGroupSignIn(groupId).then((result) => {
      if (mountedRef.current && generation === generationRef.current) apply(result);
    });
  }, [apply, groupId, membershipKey]);

  const change = useCallback(async (
    body: Parameters<typeof changeAdminGroupSignIn>[1]
  ): Promise<string | null> => {
    setBusy(true);
    ++generationRef.current;
    try {
      const result = await changeAdminGroupSignIn(groupId, body);
      if (!mountedRef.current) return null;
      if (result.ok) {
        setGroup(result.data);
        return null;
      }
      if (result.error === "external_name_not_found") void refresh();
      return adminSignInErrorMessage(result.error);
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  }, [groupId, refresh]);

  return {
    add: (source, value) => change({ action: "add_external_name", source, value }),
    busy,
    error,
    group,
    managedMembers: group
      ? new Map(group.managedMembers.map((member) => [member.userId, member.managedBy]))
      : EMPTY_MANAGED,
    refresh,
    remove: (externalNameId) => change({ action: "remove_external_name", externalNameId })
  };
}

function SourceNames({
  disabled,
  names,
  onAdd,
  onRemove,
  source
}: Readonly<{
  disabled: boolean;
  names: AdminGroupSignIn["externalNames"];
  onAdd(value: string): Promise<string | null>;
  onRemove(id: string): Promise<string | null>;
  source: ExternalGroupSource;
}>) {
  const inputId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const label = signInMethodLabels[source];

  const add = async () => {
    if (!value) return;
    if (names.some((name) => name.value === value)) {
      setMessage(adminSignInErrorMessage("external_name_duplicate"));
      return;
    }
    const failure = await onAdd(value);
    setMessage(failure);
    if (!failure) setValue("");
  };

  return (
    <div className="flex min-w-0 flex-col gap-2 px-4 py-3.5 sm:px-5" data-source={source} data-testid="admin-group-external-source">
      <p className="text-sm font-medium text-ink">{label}</p>
      {names.length ? (
        <ul aria-label={`${label} external names`} className="flex min-w-0 flex-wrap gap-2">
          {names.map((name) => (
            <li
              className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-control bg-control-surface py-0.5 pl-2.5 pr-1 text-xs text-ink-secondary"
              data-testid="admin-group-external-name"
              key={name.id}
            >
              <span className="min-w-0 break-all font-mono">{name.value}</span>
              <UiV2IconButton
                disabled={disabled}
                icon="close"
                label={`Remove ${label} external name ${name.value}`}
                onClick={() => void onRemove(name.id).then(setMessage)}
              />
            </li>
          ))}
        </ul>
      ) : null}
      <form
        className="flex min-w-0 flex-col gap-2 sm:flex-row"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <label className="sr-only" htmlFor={inputId}>{`Add an external name for ${label}`}</label>
        <input
          aria-describedby={message ? errorId : undefined}
          aria-invalid={message ? true : undefined}
          autoComplete="off"
          className={`${inputClass} min-w-0 flex-1 font-mono text-xs`}
          disabled={disabled}
          id={inputId}
          maxLength={EXTERNAL_GROUP_NAME_MAX_LENGTH}
          onChange={(event) => {
            setValue(event.currentTarget.value);
            setMessage(null);
          }}
          placeholder={source === "ldap" ? "cn=team,ou=groups,dc=example,dc=com or team" : "Exact group value"}
          spellCheck={false}
          type="text"
          value={value}
        />
        <UiV2Button disabled={disabled || !value} icon="plus" tone="ghost" type="submit">
          Add
        </UiV2Button>
      </form>
      {message ? <p className="text-xs leading-5 text-critical" id={errorId} role="alert">{message}</p> : null}
    </div>
  );
}

/**
 * External names of one group: the exact values each source sends for its members. A group
 * with a name for a source has its memberships managed by that source's sign-ins.
 */
export function AdminGroupExternalNames({
  disabled,
  signIn
}: Readonly<{ disabled: boolean; signIn: AdminGroupSignInState }>) {
  const group = signIn.group;
  return (
    <section aria-label="External names" className="flex min-w-0 flex-col gap-3" data-testid="admin-group-external-names">
      <h3 className={sectionHeadingClass}>External names</h3>
      <p className="text-xs leading-5 text-ink-muted">
        People who sign in through a source get this group when the source sends one of these exact values, and lose it
        when it stops. Entra ID sends group object IDs (GUIDs) by default; Keycloak sends full paths such as
        <code className="mx-1 font-mono">/team</code>.
      </p>
      {group?.scimManaged ? (
        <p className="border-l-2 border-proof/35 bg-proof/5 px-3 py-2 text-xs leading-5 text-ink-secondary" data-testid="admin-group-scim-managed">
          Managed by SCIM: the identity provider pushes this group and its members.
        </p>
      ) : null}
      {group ? (
        <div className={`${cardClass} divide-y divide-trace-subtle`}>
          {EXTERNAL_GROUP_SOURCES.map((source) => (
            <SourceNames
              disabled={disabled || signIn.busy}
              key={source}
              names={group.externalNames.filter((name) => name.source === source)}
              onAdd={(value) => signIn.add(source, value)}
              onRemove={signIn.remove}
              source={source}
            />
          ))}
        </div>
      ) : (
        <p className="text-xs leading-5 text-ink-muted">
          {signIn.error ?? "Loading external names…"}
        </p>
      )}
    </section>
  );
}
