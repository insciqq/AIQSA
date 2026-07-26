"use client";

import { AdminProviderQuickSetup } from "@/components/admin/AdminProviderQuickSetup";
import { AdminProvidersSection } from "@/components/admin/AdminProvidersSection";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
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
  const [view, setView] = useState<"advanced" | "quick">("quick");
  const [advancedEntryProvider, setAdvancedEntryProvider] = useState<
    AdminProviderQuickSetupId | null
  >(null);
  const [localConfirmation, setLocalConfirmation] = useState<AdminConfirmationRequest | null>(null);
  const requestProviderConfirmation = requestConfirmation ?? setLocalConfirmation;
  const quick = useAdminProviderQuickSetupController(active && view === "quick", {
    onMutationCommitted
  });

  const openAdvanced = () => {
    setAdvancedEntryProvider(quick.state.selectedProviderId);
    quick.actions.leaveQuickSetup();
    setView("advanced");
  };

  return (
    <div className="min-w-0">
      {view === "quick" ? (
        <AdminProviderQuickSetup
          controller={quick}
          onOpenAdvanced={openAdvanced}
          requestConfirmation={requestProviderConfirmation}
        />
      ) : null}

      {view === "advanced" ? (
        <AdminProvidersSection
          active={active && view === "advanced"}
          advancedEntryProvider={advancedEntryProvider}
          groups={groups}
          onBackToQuickSetup={() => setView("quick")}
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
