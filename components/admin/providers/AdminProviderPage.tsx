"use client";

import { AdminProviderConnectionSettingsSheet } from "@/components/admin/providers/AdminProviderConnectionSettingsSheet";
import { AdminProviderKeys } from "@/components/admin/providers/AdminProviderKeys";
import { AdminProviderCheckBanner } from "@/components/admin/providers/models/AdminProviderCheckBanner";
import { AdminProviderModels } from "@/components/admin/providers/models/AdminProviderModels";
import { useAdminModelChecks } from "@/components/admin/providers/models/useAdminModelChecks";
import { providerHeaderStatus, type ProviderUsageSources } from "@/components/admin/providers/providerListView";
import { ProviderAvatar } from "@/components/admin/providers/providerPrimitives";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
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
  onNotice(message: string): void;
  onOpenSettings(): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  settingsOpen: boolean;
  usageSources: ProviderUsageSources;
}>;

/**
 * One provider page (PRD 5.4): header, the capability-check banner while a
 * background check runs, Keys, Models.
 */
export function AdminProviderPage({
  connection,
  controller,
  groups,
  onCloseSettings,
  onError,
  onNotice,
  onOpenSettings,
  requestConfirmation,
  settingsOpen,
  usageSources
}: AdminProviderPageProps) {
  const checks = useAdminModelChecks({ connection, controller, onNotice });

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

      <AdminProviderCheckBanner checks={checks} connection={connection} disabled={controller.state.busy} />

      <AdminProviderKeys
        connection={connection}
        controller={controller}
        groups={groups}
        onError={onError}
        requestConfirmation={requestConfirmation}
      />

      <AdminProviderModels
        connection={connection}
        controller={controller}
        onError={onError}
        requestConfirmation={requestConfirmation}
        usageSources={usageSources}
      />

      <AdminProviderConnectionSettingsSheet
        connection={connection}
        controller={controller}
        key={connection.id}
        onClose={onCloseSettings}
        open={settingsOpen}
      />
    </div>
  );
}
