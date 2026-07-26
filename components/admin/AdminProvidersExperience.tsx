"use client";

import { AdminProviderQuickSetup } from "@/components/admin/AdminProviderQuickSetup";
import { AdminProviderCustomSetup } from "@/components/admin/AdminProviderCustomSetup";
import { AdminProvidersSection } from "@/components/admin/AdminProvidersSection";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { useAdminProviderCustomSetupController } from "@/components/admin/useAdminProviderCustomSetupController";
import { useAdminProviderQuickSetupController } from "@/components/admin/useAdminProviderQuickSetupController";
import type { AdminProviderQuickSetupId } from "@/components/admin/adminProviderQuickSetupApi";
import type {
  AdminConfirmationController,
  AdminConfirmationRequest
} from "@/components/admin/useAdminConfirmationController";
import type { AdminGroup } from "@/lib/contracts/admin";
import { useState } from "react";

export type AdminProvidersExperienceProps = Readonly<{
  active: boolean;
  groups: AdminGroup[];
  onMutationCommitted?(): void | Promise<unknown>;
  requestConfirmation?: AdminConfirmationController["requestConfirmation"];
}>;

export function AdminProvidersExperience({
  active,
  groups,
  onMutationCommitted,
  requestConfirmation
}: AdminProvidersExperienceProps) {
  const [view, setView] = useState<"advanced" | "custom" | "quick">("quick");
  const [advancedEntryProvider, setAdvancedEntryProvider] = useState<
    AdminProviderQuickSetupId | null
  >(null);
  const [advancedEntryConnectionId, setAdvancedEntryConnectionId] = useState<string | null>(null);
  const [localConfirmation, setLocalConfirmation] = useState<AdminConfirmationRequest | null>(null);
  const requestProviderConfirmation = requestConfirmation ?? setLocalConfirmation;
  const quick = useAdminProviderQuickSetupController(active && view === "quick", {
    onMutationCommitted
  });
  const custom = useAdminProviderCustomSetupController(active && view === "custom", {
    onMutationCommitted
  });

  const openAdvanced = (connectionId: string | null = null) => {
    setAdvancedEntryProvider(connectionId ? null : quick.state.selectedProviderId);
    setAdvancedEntryConnectionId(connectionId);
    quick.actions.leaveQuickSetup();
    custom.actions.leave();
    setView("advanced");
  };

  const openCustom = () => {
    setAdvancedEntryProvider(null);
    setAdvancedEntryConnectionId(null);
    quick.actions.leaveQuickSetup();
    setView("custom");
  };

  const backToQuick = () => {
    custom.actions.leave();
    setView("quick");
  };

  return (
    <div className="min-w-0">
      {view === "quick" ? (
        <AdminProviderQuickSetup
          controller={quick}
          onOpenAdvanced={() => openAdvanced()}
          onOpenCustom={openCustom}
          requestConfirmation={requestProviderConfirmation}
        />
      ) : null}

      {view === "custom" ? (
        <AdminProviderCustomSetup
          controller={custom}
          onBack={backToQuick}
          onOpenAdvanced={(connectionId) => openAdvanced(connectionId)}
        />
      ) : null}

      {view === "advanced" ? (
        <AdminProvidersSection
          active={active && view === "advanced"}
          advancedEntryConnectionId={advancedEntryConnectionId}
          advancedEntryProvider={advancedEntryProvider}
          groups={groups}
          onBackToQuickSetup={backToQuick}
          onMutationCommitted={onMutationCommitted}
          requestConfirmation={requestProviderConfirmation}
        />
      ) : null}

      {localConfirmation ? (
        <ConfirmationDialog
          confirmLabel={localConfirmation.confirmLabel}
          dialogLabel={localConfirmation.dialogLabel}
          icon={localConfirmation.icon}
          onCancel={() => setLocalConfirmation(null)}
          onConfirm={() => {
            const action = localConfirmation.onConfirm;
            setLocalConfirmation(null);
            void action();
          }}
          testId={localConfirmation.testId}
          title={localConfirmation.title}
          tone={localConfirmation.tone}
        >
          {localConfirmation.body}
        </ConfirmationDialog>
      ) : null}
    </div>
  );
}
