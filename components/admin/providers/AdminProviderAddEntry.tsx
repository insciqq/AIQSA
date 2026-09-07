"use client";

import { AdminProviderCustomSetup } from "@/components/admin/AdminProviderCustomSetup";
import { AdminProviderQuickSetup } from "@/components/admin/AdminProviderQuickSetup";
import { useAdminDraftProtection } from "@/components/admin/AdminDraftProtection";
import type { AdminProviderQuickSetupId } from "@/components/admin/adminProviderQuickSetupApi";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { useAdminProviderCustomSetupController } from "@/components/admin/useAdminProviderCustomSetupController";
import { useAdminProviderQuickSetupController } from "@/components/admin/useAdminProviderQuickSetupController";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { providerTemplateIds } from "@/lib/domain/providerTemplates";
import { useState } from "react";

const canonicalConnectionIds: Record<AdminProviderQuickSetupId, string> = {
  anthropic: providerTemplateIds.anthropicConnection,
  deepseek: providerTemplateIds.deepSeekConnection,
  gemini: providerTemplateIds.geminiConnection,
  openai: providerTemplateIds.openAiConnection,
  openrouter: providerTemplateIds.openRouterConnection
};

/** The provider page a Quick setup family maps to, when that is unambiguous. */
export function preferredProviderConnectionId(
  connections: readonly AdminProviderConnection[],
  family: AdminProviderQuickSetupId | null
): string | null {
  if (!family) return null;
  const canonical = connections.find(({ id }) => id === canonicalConnectionIds[family]);
  if (canonical?.family === family) return canonical.id;
  const matches = connections.filter((connection) => connection.family === family);
  return matches.length === 1 ? matches[0]!.id : null;
}

export type AdminProviderAddEntryProps = Readonly<{
  active: boolean;
  connections: readonly AdminProviderConnection[];
  onMutationCommitted?(): void | Promise<unknown>;
  /** Opens a provider page, or the list when the setup has no single page to show. */
  onOpenConnection(connectionId: string | null): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
}>;

/**
 * Temporary `Add provider` entry until S3 lands the Add provider sheet: the
 * existing Quick setup and Custom setup flows behind the topbar action, with
 * the same unsaved-key protection they had before.
 */
export function AdminProviderAddEntry({
  active,
  connections,
  onMutationCommitted,
  onOpenConnection,
  requestConfirmation
}: AdminProviderAddEntryProps) {
  const [setupTask, setSetupTask] = useState<"custom" | "quick">("quick");
  const quick = useAdminProviderQuickSetupController(active && setupTask === "quick", { onMutationCommitted });
  const custom = useAdminProviderCustomSetupController(active && setupTask === "custom", { onMutationCommitted });

  const leaveSetup = () => {
    quick.actions.leaveQuickSetup();
    custom.actions.leave();
  };
  const setupDirty = setupTask === "quick" ? quick.state.secret.length > 0 : custom.state.dirty;
  const requestSetupDiscard = useAdminDraftProtection({
    dirty: setupDirty,
    onDiscard: leaveSetup,
    owner: "provider-setup-draft",
    pending: setupDirty && (setupTask === "quick" ? quick.state.formLocked : custom.state.formLocked)
  });

  const openConnection = (connectionId?: string) => {
    const target = connectionId ?? preferredProviderConnectionId(connections, quick.state.selectedProviderId);
    requestSetupDiscard(() => {
      leaveSetup();
      onOpenConnection(target);
    });
  };

  return (
    <div className="min-w-0" data-testid="provider-add-entry">
      {setupTask === "quick" ? (
        <AdminProviderQuickSetup
          controller={quick}
          onManageConnection={openConnection}
          onOpenCustom={() => requestSetupDiscard(() => {
            quick.actions.leaveQuickSetup();
            setSetupTask("custom");
          })}
          requestConfirmation={requestConfirmation}
        />
      ) : (
        <AdminProviderCustomSetup
          controller={custom}
          onBack={() => requestSetupDiscard(() => {
            custom.actions.leave();
            setSetupTask("quick");
          })}
          onManageConnection={openConnection}
        />
      )}
    </div>
  );
}
