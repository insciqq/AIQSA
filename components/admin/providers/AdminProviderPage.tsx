"use client";

import { AdminProviderModelsTask } from "@/components/admin/AdminProviderModelsTask";
import { AdminProviderConnectionSettingsSheet } from "@/components/admin/providers/AdminProviderConnectionSettingsSheet";
import { AdminProviderKeys } from "@/components/admin/providers/AdminProviderKeys";
import {
  hasUnappliedModelChanges,
  providerHeaderStatus
} from "@/components/admin/providers/providerListView";
import { ProviderAvatar } from "@/components/admin/providers/providerPrimitives";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { useAdminOpenRouterDiscovery } from "@/components/admin/useAdminOpenRouterDiscovery";
import type { AdminProvidersController } from "@/components/admin/useAdminProvidersController";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminGroup } from "@/lib/contracts/admin";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";

export type AdminProviderPageProps = Readonly<{
  connection: AdminProviderConnection;
  controller: AdminProvidersController;
  groups: readonly AdminGroup[];
  onCloseSettings(): void;
  onError(message: string): void;
  onOpenSettings(): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  settingsOpen: boolean;
}>;

/**
 * One provider page (PRD 5.4): header, Keys, Models. The Models block is the
 * existing task until S2 lands its table; the small "apply" bar keeps model
 * edits usable meanwhile, because the old activation button is gone.
 */
export function AdminProviderPage({
  connection,
  controller,
  groups,
  onCloseSettings,
  onError,
  onOpenSettings,
  requestConfirmation,
  settingsOpen
}: AdminProviderPageProps) {
  const discovery = useAdminOpenRouterDiscovery({
    loadCompatibleModels: controller.actions.discoverCompatibleModels,
    loadEndpoints: controller.actions.discoverEndpoints,
    loadModels: controller.actions.discoverModels
  });
  const unapplied = hasUnappliedModelChanges(connection);

  return (
    <div className="flex max-w-[1120px] flex-col gap-7 px-4 py-6 sm:px-6 lg:px-8" data-testid="provider-page">
      <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
        <ProviderAvatar family={connection.family} label={connection.displayName} size="header" />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-semibold leading-tight text-ink [overflow-wrap:anywhere]">
            {connection.displayName}
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-muted" data-testid="provider-page-status">
            {providerHeaderStatus(connection)}
          </p>
        </div>
        <UiV2Button icon="settings" onClick={onOpenSettings} tone="ghost" type="button">
          Connection settings
        </UiV2Button>
      </header>

      <AdminProviderKeys
        connection={connection}
        controller={controller}
        groups={groups}
        onError={onError}
        requestConfirmation={requestConfirmation}
      />

      <section aria-label="Models" className="flex min-w-0 flex-col gap-2.5" data-testid="provider-models">
        {unapplied ? (
          <div
            className="flex flex-wrap items-center justify-between gap-3 rounded-[12px] border border-caution/25 bg-caution/10 px-4 py-2.5 text-xs text-caution"
            role="status"
          >
            <span>Model changes are saved but not yet in use.</span>
            <UiV2Button
              disabled={controller.state.busy}
              onClick={() => void controller.actions.connectionAction(
                connection.id,
                { action: "activate", confirmUnavailable: true, enableConnection: connection.enabled },
                "Model changes applied."
              )}
              tone="ghost"
              type="button"
            >
              Apply model changes
            </UiV2Button>
          </div>
        ) : null}
        <div className="-mx-4 sm:-mx-6">
          <AdminProviderModelsTask
            connection={connection}
            controller={controller}
            discovery={discovery}
            requestConfirmation={requestConfirmation}
          />
        </div>
      </section>

      <AdminProviderConnectionSettingsSheet
        connection={connection}
        controller={controller}
        key={`${connection.id}:${connection.draftVersion}`}
        onClose={onCloseSettings}
        open={settingsOpen}
      />
    </div>
  );
}
