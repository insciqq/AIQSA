"use client";

import { AdminProviderQuickSetup } from "@/components/admin/AdminProviderQuickSetup";
import { AdminProvidersSection } from "@/components/admin/AdminProvidersSection";
import { quietButton } from "@/components/admin/adminPrimitives";
import { useAdminProviderQuickSetupController } from "@/components/admin/useAdminProviderQuickSetupController";
import type { AdminGroup } from "@/lib/contracts/admin";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

export type AdminProvidersExperienceProps = Readonly<{
  active: boolean;
  groups: AdminGroup[];
  onMutationCommitted?(): void | Promise<unknown>;
}>;

export function AdminProvidersExperience({
  active,
  groups,
  onMutationCommitted
}: AdminProvidersExperienceProps) {
  const [view, setView] = useState<"advanced" | "quick">("quick");
  const [advancedMounted, setAdvancedMounted] = useState(false);
  const [advancedRefreshRevision, setAdvancedRefreshRevision] = useState(0);
  const quick = useAdminProviderQuickSetupController(active && view === "quick", {
    onMutationCommitted,
    onQuickSetupCommitted: () => {
      if (advancedMounted) setAdvancedRefreshRevision((revision) => revision + 1);
    }
  });

  const openAdvanced = () => {
    quick.actions.leaveQuickSetup();
    setAdvancedMounted(true);
    setView("advanced");
  };

  return (
    <div className="min-w-0">
      <div hidden={view !== "quick"}>
        <AdminProviderQuickSetup controller={quick} onOpenAdvanced={openAdvanced} />
      </div>

      {advancedMounted ? (
        <div
          data-admin-legacy-scope="provider-advanced"
          data-admin-renderer="legacy-embedded"
          hidden={view !== "advanced"}
        >
          <div className="flex min-w-0 flex-col gap-2 border-b border-trace-subtle px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
            <div className="min-w-0">
              <p className="text-xs font-medium text-ink-secondary">Advanced configuration</p>
              <p className="mt-0.5 text-[11px] leading-4 text-ink-muted">
                Connections, credentials, model deployments, assignments, checks, and run profiles.
              </p>
            </div>
            <button
              className={quietButton}
              onClick={() => setView("quick")}
              type="button"
            >
              <ArrowLeft aria-hidden="true" className="size-3.5" />
              Back to Personal setup
            </button>
          </div>
          <AdminProvidersSection
            active={active && view === "advanced"}
            groups={groups}
            onMutationCommitted={onMutationCommitted}
            refreshRevision={advancedRefreshRevision}
          />
        </div>
      ) : null}
    </div>
  );
}
