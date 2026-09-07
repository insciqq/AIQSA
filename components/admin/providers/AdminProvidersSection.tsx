"use client";

import { adminSectionPath, type AdminSectionId } from "@/components/admin/adminSections";
import { AdminTopbarMenu, useAdminSectionTopbar, type AdminShellTopbar } from "@/components/admin/AdminShell";
import { AdminProviderAddEntry } from "@/components/admin/providers/AdminProviderAddEntry";
import { AdminProviderPage } from "@/components/admin/providers/AdminProviderPage";
import { AdminProvidersList } from "@/components/admin/providers/AdminProvidersList";
import { describeDeleteBlockers } from "@/components/admin/providers/providerBlockers";
import { deriveProviderUsage, isCustomProvider } from "@/components/admin/providers/providerListView";
import { useAdminProviderUsage } from "@/components/admin/providers/useAdminProviderUsage";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { useAdminProvidersController } from "@/components/admin/useAdminProvidersController";
import { UiV2Button, UiV2Icon, UiV2Switch } from "@/components/ui-v2";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { useCallback, useMemo, useState, type MouseEvent } from "react";

const crumbLink =
  "rounded-[6px] font-medium text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus";

export type AdminProvidersSectionProps = Readonly<{
  active: boolean;
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  groups: readonly AdminGroup[];
  onMutationCommitted?(): void | Promise<unknown>;
  onNavigateSection(section: AdminSectionId): void;
  onSelectResource(resource: string | null): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  /** Open provider page from `?resource=`, or null for the list. */
  resource: string | null;
}>;

function Crumbs({
  current,
  onBack
}: Readonly<{ current: string; onBack(): void }>) {
  const href = adminSectionPath(typeof window === "undefined" ? "/admin" : window.location.href, "providers");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <a
        className={crumbLink}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onBack();
        }}
      >
        Providers
      </a>
      <UiV2Icon className="size-3.5 shrink-0 text-ink-muted" name="chevron-right" />
      <span className="truncate">{current}</span>
    </span>
  );
}

/**
 * Providers section (PRD 5.2, 5.4): the list, one provider page per
 * `?resource=`, and the temporary Add provider entry. The section owns the
 * topbar and the one controller; pages receive the connection they show.
 */
export function AdminProvidersSection({
  active,
  feedback,
  groups,
  onMutationCommitted,
  onNavigateSection,
  onSelectResource,
  requestConfirmation,
  resource
}: AdminProvidersSectionProps) {
  const [addingRequested, setAdding] = useState(false);
  // Keyed by the open page so a page change never carries a sheet along.
  const [settingsOpenFor, setSettingsOpenFor] = useState<string | null>(null);
  const adding = addingRequested && resource === null;
  const settingsOpen = resource !== null && settingsOpenFor === resource;
  const setSettingsOpen = useCallback(
    (open: boolean) => setSettingsOpenFor(open ? resource : null),
    [resource]
  );
  const controller = useAdminProvidersController(active, {
    onError: feedback.reportError,
    onMutationCommitted,
    onNotice: feedback.reportNotice
  });
  const { connections, loaded } = controller.state;
  const usageSources = useAdminProviderUsage(active && !adding, connections);
  const usage = useMemo(() => deriveProviderUsage(connections, usageSources), [connections, usageSources]);
  const connection = useMemo(
    () => (resource ? connections.find(({ id }) => id === resource) ?? null : null),
    [connections, resource]
  );
  const { refresh } = controller.actions;

  const backToList = useCallback(() => {
    setAdding(false);
    onSelectResource(null);
  }, [onSelectResource]);

  const requestDelete = useCallback((target: AdminProviderConnection) => {
    const name = target.displayName;
    requestConfirmation({
      body: isCustomProvider(target)
        ? "The provider is turned off and removed with its keys, models, overrides and defaults. Chats already running finish, and history keeps its records."
        : "The provider is turned off and removed with its keys and models. Chats already running finish, and history keeps its records.",
      confirmLabel: "Delete provider",
      dialogLabel: `Delete ${name}`,
      icon: "trash",
      onConfirm: async () => {
        let turnedOff = false;
        if (target.enabled) {
          turnedOff = await controller.actions.connectionAction(
            target.id,
            { action: "disable" },
            "Provider turned off.",
            { quiet: true }
          );
          if (!turnedOff) {
            feedback.reportError(`“${name}” could not be turned off, so it was not deleted.`);
            return;
          }
        }
        const result = await controller.actions.deleteConnection(target.id);
        if (result.ok) {
          onSelectResource(null);
          return;
        }
        feedback.reportError(`“${name}” was ${turnedOff ? "turned off but " : ""}not deleted. ${
          result.error.blockers.length ? describeDeleteBlockers(result.error.blockers, "provider") : result.message
        }`);
      },
      testId: "admin-confirm-delete-provider-connection",
      title: `Delete “${name}”?`,
      tone: "destructive"
    });
  }, [controller.actions, feedback, onSelectResource, requestConfirmation]);

  const busy = controller.state.busy;
  const topbar = useMemo<AdminShellTopbar>(() => {
    if (adding) {
      return { title: <Crumbs current="Add provider" onBack={backToList} /> };
    }
    if (resource && connection) {
      return {
        actions: (
          <>
            <label className="flex items-center gap-2 text-[13px] text-ink-secondary">
              Enabled
              <UiV2Switch
                checked={connection.enabled}
                data-testid="provider-enabled"
                disabled={busy}
                label={`${connection.displayName} enabled`}
                onChange={(next) => void controller.actions.connectionAction(
                  connection.id,
                  { action: next ? "enable" : "disable" },
                  next ? "Provider turned on." : "Provider turned off."
                )}
              />
            </label>
            <AdminTopbarMenu
              actions={[
                { icon: "settings", label: "Connection settings", onSelect: () => setSettingsOpen(true) },
                {
                  disabled: busy,
                  icon: "trash",
                  label: "Delete provider",
                  onSelect: () => requestDelete(connection),
                  separatorBefore: true,
                  tone: "destructive"
                }
              ]}
              label={`More actions for ${connection.displayName}`}
            />
          </>
        ),
        title: <Crumbs current={connection.displayName} onBack={backToList} />
      };
    }
    if (resource) {
      return { title: <Crumbs current="Provider" onBack={backToList} /> };
    }
    return {
      actions: (
        <UiV2Button
          data-testid="provider-add"
          disabled={!loaded}
          icon="plus"
          onClick={() => setAdding(true)}
          tone="primary"
          type="button"
        >
          Add provider
        </UiV2Button>
      ),
      title: "Providers"
    };
  }, [adding, backToList, busy, connection, controller.actions, loaded, requestDelete, resource, setSettingsOpen]);
  useAdminSectionTopbar(topbar);

  if (adding) {
    return (
      <AdminProviderAddEntry
        active={active}
        connections={connections}
        onMutationCommitted={() => {
          void refresh();
          return onMutationCommitted?.();
        }}
        onOpenConnection={(connectionId) => {
          setAdding(false);
          onSelectResource(connectionId);
        }}
        requestConfirmation={requestConfirmation}
      />
    );
  }

  if (resource) {
    if (!connection) {
      return (
        <div className="px-4 py-12 text-center sm:px-6" role={loaded ? "alert" : "status"}>
          {loaded ? (
            <>
              <p className="text-sm font-semibold text-ink-secondary">This provider no longer exists.</p>
              <UiV2Button className="mt-4" onClick={backToList} tone="ghost" type="button">Back to providers</UiV2Button>
            </>
          ) : (
            <p className="text-sm text-ink-muted">Loading provider…</p>
          )}
        </div>
      );
    }
    return (
      <AdminProviderPage
        connection={connection}
        controller={controller}
        groups={groups}
        onCloseSettings={() => setSettingsOpen(false)}
        onError={feedback.reportError}
        onNotice={feedback.reportNotice}
        onOpenSettings={() => setSettingsOpen(true)}
        requestConfirmation={requestConfirmation}
        settingsOpen={settingsOpen}
        usageSources={usageSources}
      />
    );
  }

  return (
    <div className="max-w-[1120px] px-4 py-6 sm:px-6 lg:px-8">
      <AdminProvidersList
        connections={connections}
        error={controller.state.error}
        loaded={loaded}
        loading={controller.state.loading}
        onNavigateSection={onNavigateSection}
        onOpen={(connectionId) => onSelectResource(connectionId)}
        onRetry={() => void refresh()}
        usage={usage}
      />
    </div>
  );
}
