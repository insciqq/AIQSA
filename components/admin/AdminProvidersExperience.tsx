"use client";

import { AdminProviderQuickSetup } from "@/components/admin/AdminProviderQuickSetup";
import { AdminProviderCustomSetup } from "@/components/admin/AdminProviderCustomSetup";
import { AdminProvidersSection } from "@/components/admin/AdminProvidersSection";
import { AdminProviderModelDefaultTask } from "@/components/admin/AdminProviderModelDefaultTask";
import { AdminProviderSystemModelTask } from "@/components/admin/AdminProviderSystemModelTask";
import { AdminProviderRunLimitsTask } from "@/components/admin/AdminProviderRunLimitsTask";
import { focusRing, touchTarget } from "@/components/admin/adminPrimitives";
import {
  useAdminDiscardAction,
  useAdminDraftProtection
} from "@/components/admin/AdminDraftProtection";
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

type ProviderWorkspaceTask = "connections" | "defaults" | "limits" | "setup" | "system";

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
  const [workspaceTask, setWorkspaceTask] = useState<ProviderWorkspaceTask>("setup");
  const [setupTask, setSetupTask] = useState<"custom" | "quick">("quick");
  const [connectionEntryProvider, setConnectionEntryProvider] = useState<
    AdminProviderQuickSetupId | null
  >(null);
  const [connectionEntryId, setConnectionEntryId] = useState<string | null>(null);
  const [localConfirmation, setLocalConfirmation] = useState<AdminConfirmationRequest | null>(null);
  const requestProviderConfirmation = requestConfirmation ?? setLocalConfirmation;
  const quick = useAdminProviderQuickSetupController(
    active && workspaceTask === "setup" && setupTask === "quick",
    {
    onMutationCommitted
    }
  );
  const custom = useAdminProviderCustomSetupController(
    active && workspaceTask === "setup" && setupTask === "custom",
    {
    onMutationCommitted
    }
  );

  const leaveSetup = () => {
    quick.actions.leaveQuickSetup();
    custom.actions.leave();
  };
  const setupDirty = setupTask === "quick"
    ? quick.state.secret.length > 0
    : custom.state.dirty;
  const requestSetupDiscard = useAdminDraftProtection({
    dirty: setupDirty,
    onDiscard: leaveSetup,
    owner: "provider-setup-draft",
    pending: setupDirty && (
      setupTask === "quick" ? quick.state.formLocked : custom.state.formLocked
    )
  });
  const requestProviderDiscard = useAdminDiscardAction();

  const openConnection = (connectionId: string | null = null) => {
    requestSetupDiscard(() => {
      setConnectionEntryProvider(connectionId ? null : quick.state.selectedProviderId);
      setConnectionEntryId(connectionId);
      leaveSetup();
      setWorkspaceTask("connections");
    });
  };

  const openCustom = () => {
    requestSetupDiscard(() => {
      setConnectionEntryProvider(null);
      setConnectionEntryId(null);
      quick.actions.leaveQuickSetup();
      setSetupTask("custom");
    });
  };

  const backToSetup = () => {
    requestSetupDiscard(() => {
      custom.actions.leave();
      setSetupTask("quick");
    });
  };

  const commitWorkspaceTask = (nextTask: ProviderWorkspaceTask) => {
    if (nextTask === workspaceTask) return;

    if (workspaceTask === "setup") {
      leaveSetup();
    }
    if (nextTask === "setup") {
      setConnectionEntryProvider(null);
      setConnectionEntryId(null);
      setSetupTask("quick");
    } else if (nextTask === "connections" && workspaceTask === "setup") {
      setConnectionEntryProvider(null);
      setConnectionEntryId(null);
    }
    setWorkspaceTask(nextTask);
  };

  const selectWorkspaceTask = (nextTask: ProviderWorkspaceTask) => {
    if (nextTask === workspaceTask) return;

    requestProviderDiscard(() => commitWorkspaceTask(nextTask));
  };

  return (
    <div className="min-w-0">
      <div
        aria-label="Provider tasks"
        className="flex min-w-0 gap-6 overflow-x-auto overscroll-x-contain border-b border-trace-subtle px-4 [scrollbar-width:none] sm:px-6 lg:px-8 [&::-webkit-scrollbar]:hidden"
        data-testid="provider-workspace-tabs"
        role="tablist"
      >
        {([
          ["setup", "Quick setup"],
          ["connections", "Connections"],
          ["defaults", "Default model"],
          ["limits", "Tool limits"],
          ["system", "System Models"]
        ] as const).map(([task, label]) => (
          <button
            aria-selected={workspaceTask === task}
            className={`-mb-px min-h-touch shrink-0 border-b-2 px-0.5 text-sm font-medium ${focusRing} ${touchTarget} ${
              workspaceTask === task
                ? "border-proof text-ink"
                : "border-transparent text-ink-muted hover:border-trace-strong hover:text-ink-secondary"
            }`}
            key={task}
            onClick={() => selectWorkspaceTask(task)}
            role="tab"
            type="button"
          >
            {label}
          </button>
        ))}
      </div>

      {workspaceTask === "setup" && setupTask === "quick" ? (
        <AdminProviderQuickSetup
          controller={quick}
          onManageConnection={(connectionId) => openConnection(connectionId ?? null)}
          onOpenCustom={openCustom}
          requestConfirmation={requestProviderConfirmation}
        />
      ) : null}

      {workspaceTask === "setup" && setupTask === "custom" ? (
        <AdminProviderCustomSetup
          controller={custom}
          onBack={backToSetup}
          onManageConnection={(connectionId) => openConnection(connectionId)}
        />
      ) : null}

      {workspaceTask !== "setup" ? (
        <div className="min-w-0">
          <div hidden={workspaceTask !== "connections"}>
            <AdminProvidersSection
              active={active && workspaceTask === "connections"}
              entryConnectionId={connectionEntryId}
              entryProvider={connectionEntryProvider}
              groups={groups}
              onMutationCommitted={onMutationCommitted}
              requestConfirmation={requestProviderConfirmation}
            />
          </div>
          <div hidden={workspaceTask !== "defaults"}>
            <AdminProviderModelDefaultTask
              active={active && workspaceTask === "defaults"}
              onMutationCommitted={onMutationCommitted}
            />
          </div>
          <div hidden={workspaceTask !== "system"}>
            <AdminProviderSystemModelTask
              active={active && workspaceTask === "system"}
              onMutationCommitted={onMutationCommitted}
            />
          </div>
          <div hidden={workspaceTask !== "limits"}>
            <AdminProviderRunLimitsTask
              active={active && workspaceTask === "limits"}
              onMutationCommitted={onMutationCommitted}
            />
          </div>
        </div>
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
