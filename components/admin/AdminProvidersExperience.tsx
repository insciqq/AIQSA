"use client";

import { AdminProviderQuickSetup } from "@/components/admin/AdminProviderQuickSetup";
import { AdminProvidersSection } from "@/components/admin/AdminProvidersSection";
import { useAdminProviderQuickSetupController } from "@/components/admin/useAdminProviderQuickSetupController";
import type { AdminProviderQuickSetupId } from "@/components/admin/adminProviderQuickSetupApi";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
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
        <AdminProviderQuickSetup controller={quick} onOpenAdvanced={openAdvanced} />
      ) : null}

      {view === "advanced" ? (
        <AdminProvidersSection
          active={active && view === "advanced"}
          advancedEntryProvider={advancedEntryProvider}
          groups={groups}
          onBackToPersonal={() => setView("quick")}
          onMutationCommitted={onMutationCommitted}
          requestConfirmation={requestConfirmation}
        />
      ) : null}
    </div>
  );
}
