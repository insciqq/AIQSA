"use client";

import {
  EmptyState,
  dangerButton,
  inputClass,
  primaryButton
} from "@/components/admin/adminPrimitives";
import { providerCredentialUsable } from "@/components/admin/providerAdvancedView";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { useState } from "react";

const fieldLabel = "mb-1 block text-xs font-medium text-ink-secondary";

export function AdminProviderAuthenticationTask({
  connection,
  controller,
  groups
}: Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  groups: AdminGroup[];
}>) {
  const activeGroups = groups.filter(({ archivedAt }) => !archivedAt);
  const usableCredentials = connection.credentials.filter(providerCredentialUsable);
  const [groupId, setGroupId] = useState(activeGroups[0]?.id ?? "");
  const [credentialId, setCredentialId] = useState(
    usableCredentials[0]?.id ?? connection.credentials[0]?.id ?? ""
  );
  const effectiveGroupId = activeGroups.some(({ id }) => id === groupId)
    ? groupId
    : activeGroups[0]?.id ?? "";
  const effectiveCredentialId = usableCredentials.some(({ id }) => id === credentialId)
    ? credentialId
    : usableCredentials[0]?.id ?? "";

  return (
    <section className="min-w-0" data-testid="provider-task-authentication">
      <div className="border-b border-trace-subtle px-4 py-5 sm:px-6">
        <h3 className="text-base font-semibold text-ink">Authentication policy</h3>
        <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-muted">
          This chooses which administrator-owned account authenticates a run. It never grants model access; group entitlements remain in Access & groups.
        </p>
      </div>

      <div className="grid gap-5 border-b border-trace-subtle px-4 py-5 sm:px-6">
        <div className="grid max-w-3xl gap-4 md:grid-cols-2">
          <label>
            <span className={fieldLabel}>Users without a group key</span>
            <select
              className={inputClass}
              disabled={controller.state.busy}
              id="provider-unassigned-policy"
              onChange={(event) => void controller.actions.updateConnection(connection.id, {
                configuration: connection.draftConfig,
                displayName: connection.displayName,
                expectedDraftVersion: connection.draftVersion,
                family: connection.family,
                unassignedPolicy: event.currentTarget.value
              })}
              value={connection.unassignedPolicy}
            >
              <option value="use_default">Use default credential</option>
              <option value="require_assignment">Require group assignment</option>
            </select>
          </label>
          <label>
            <span className={fieldLabel}>Default credential</span>
            <select
              className={inputClass}
              disabled={controller.state.busy || connection.unassignedPolicy === "require_assignment"}
              id="provider-default-credential"
              onChange={(event) => void controller.actions.connectionAction(
                connection.id,
                {
                  action: "set_default_credential",
                  credentialId: event.currentTarget.value || null
                },
                "Default credential updated; activate to validate the new effective set."
              )}
              value={connection.defaultCredentialId ?? ""}
            >
              <option value="">No default credential</option>
              {connection.credentials.map((credential) => (
                <option
                  disabled={!providerCredentialUsable(credential)}
                  key={credential.id}
                  value={credential.id}
                >
                  {credential.label}{providerCredentialUsable(credential) ? "" : " (unusable)"}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="max-w-3xl text-xs leading-5 text-ink-muted">
          Under Use default, users without an active group override use the selected key. Under Require group assignment, an unassigned user cannot use this connection.
        </p>
      </div>

      <div className="grid gap-4 px-4 py-5 sm:px-6">
        <div>
          <h4 className="text-sm font-semibold text-ink">Group key overrides</h4>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Different groups may authenticate through different provider accounts. Overlapping different assignments fail closed rather than choosing one silently.
          </p>
        </div>

        {activeGroups.length && usableCredentials.length ? (
          <form
            className="grid max-w-3xl gap-3 bg-control-surface/55 py-3 md:grid-cols-[1fr_1fr_auto] md:items-end"
            onSubmit={(event) => {
              event.preventDefault();
              void controller.actions.connectionAction(
                connection.id,
                {
                  action: "assign_group_credential",
                  credentialId: effectiveCredentialId,
                  groupId: effectiveGroupId
                },
                "Group credential assignment saved; it does not grant model access."
              );
            }}
          >
            <label>
              <span className={fieldLabel}>Group override</span>
              <select
                className={inputClass}
                disabled={controller.state.busy}
                id="provider-group-assignment"
                onChange={(event) => setGroupId(event.currentTarget.value)}
                value={effectiveGroupId}
              >
                <option value="">Choose a group</option>
                {activeGroups.map((group) => (
                  <option key={group.id} value={group.id}>{group.name}</option>
                ))}
              </select>
            </label>
            <label>
              <span className={fieldLabel}>Credential</span>
              <select
                className={inputClass}
                disabled={controller.state.busy}
                onChange={(event) => setCredentialId(event.currentTarget.value)}
                value={effectiveCredentialId}
              >
                <option value="">Choose a usable credential</option>
                {usableCredentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>{credential.label}</option>
                ))}
              </select>
            </label>
            <button
              className={primaryButton}
              disabled={controller.state.busy || !effectiveGroupId || !effectiveCredentialId}
              type="submit"
            >
              Assign
            </button>
          </form>
        ) : (
          <EmptyState
            detail={
              !activeGroups.length
                ? "Create an active Team group before adding a group-specific key override."
                : "Enable a credential with a saved draft or active key before assigning it."
            }
            title="No assignment can be added yet"
          />
        )}

        {connection.assignments.length ? (
          <div aria-label="Group credential assignments" className="divide-y divide-trace-subtle" role="list">
            {connection.assignments.map((assignment) => (
              <div
                className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between"
                key={assignment.group.id}
                role="listitem"
              >
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-ink">
                    {assignment.group.name}
                    {assignment.group.archivedAt ? " · Archived and ignored" : ""}
                  </p>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Authenticates with {connection.credentials.find(({ id }) =>
                      id === assignment.credentialId)?.label ?? "removed credential"}.
                  </p>
                </div>
                <button
                  aria-label={`Remove credential override for ${assignment.group.name}`}
                  className={dangerButton}
                  disabled={controller.state.busy}
                  onClick={() => void controller.actions.connectionAction(
                    connection.id,
                    { action: "revoke_group_credential", groupId: assignment.group.id },
                    "Group credential assignment removed."
                  )}
                  type="button"
                >
                  Remove override
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">No group-specific keys. The unassigned-user policy applies.</p>
        )}
      </div>
    </section>
  );
}
