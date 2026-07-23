"use client";

import { AdminAccessRulesSection } from "@/components/admin/AdminAccessRulesSection";
import { AdminConfirmationHost } from "@/components/admin/AdminConfirmationHost";
import { AdminConsoleHeader } from "@/components/admin/AdminConsoleHeader";
import { AdminDashboardOverview } from "@/components/admin/AdminDashboardOverview";
import { AdminDashboardUnavailable } from "@/components/admin/AdminDashboardUnavailable";
import { AdminFeedbackMessages } from "@/components/admin/AdminFeedbackMessages";
import { AdminGroupsSection } from "@/components/admin/AdminGroupsSection";
import { AdminInvitesSection } from "@/components/admin/AdminInvitesSection";
import { AdminModelAccessSection } from "@/components/admin/AdminModelAccessSection";
import { AdminMcpGroupAccessPanel, AdminMcpUserAccessPanel } from "@/components/admin/AdminMcpGrantPanels";
import { AdminMcpServersSection } from "@/components/admin/AdminMcpServersSection";
import { AdminSafetySection } from "@/components/admin/AdminSafetySection";
import { AdminSectionFrame } from "@/components/admin/AdminSectionFrame";
import { AdminUsageSection } from "@/components/admin/AdminUsageSection";
import { AdminUsersSection } from "@/components/admin/AdminUsersSection";
import { deriveAdminDashboardOverview } from "@/components/admin/adminDashboardView";
import { primaryButton } from "@/components/admin/adminPrimitives";
import type { AdminSectionId } from "@/components/admin/adminSections";
import { formatTime } from "@/components/admin/adminViewUtils";
import { useAdminAccessRulesController, type AdminAccessRulesController } from "@/components/admin/useAdminAccessRulesController";
import { useAdminActionRunner } from "@/components/admin/useAdminActionRunner";
import { useAdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import { useAdminDashboardResource } from "@/components/admin/useAdminDashboardResource";
import { useAdminFeedback } from "@/components/admin/useAdminFeedback";
import { useAdminFieldErrors } from "@/components/admin/useAdminFieldErrors";
import { useAdminGroupsController, type AdminGroupsController } from "@/components/admin/useAdminGroupsController";
import { useAdminInvitesController, type AdminInvitesController } from "@/components/admin/useAdminInvitesController";
import { useAdminMcpController, type AdminMcpController } from "@/components/admin/useAdminMcpController";
import { useAdminMcpSectionState, type AdminMcpSectionState } from "@/components/admin/useAdminMcpSectionState";
import { useAdminOperationalFocus } from "@/components/admin/useAdminOperationalFocus";
import { useAdminSectionNavigation } from "@/components/admin/useAdminSectionNavigation";
import { useAdminUsersController, type AdminUsersController } from "@/components/admin/useAdminUsersController";
import type { AdminDashboard } from "@/lib/contracts/admin";
import { Link2, Plus } from "lucide-react";
import { useCallback, useMemo } from "react";

type AdminPanelProps = Readonly<{
  adminEmail: string;
  adminUserId: string;
}>;

function assertNeverSection(section: never): never {
  throw new Error(`Unhandled admin section: ${section}`);
}

function AdminHeaderAction({
  activeSection,
  accessRules,
  groups,
  invites
}: Readonly<{
  activeSection: AdminSectionId;
  accessRules: AdminAccessRulesController;
  groups: AdminGroupsController;
  invites: AdminInvitesController;
}>) {
  const form =
    activeSection === "groups"
      ? {
          Icon: Plus,
          label: "group",
          open: groups.groups.sectionProps?.draft.createFormOpen ?? false,
          toggle: groups.groups.toggleCreateForm
        }
      : activeSection === "invites"
        ? {
            Icon: Link2,
            label: "invite",
            open: invites.headerForm.formOpen,
            toggle: invites.headerForm.toggleForm
          }
        : activeSection === "access-rules"
          ? {
              Icon: Plus,
              label: "rule",
              open: accessRules.headerForm.formOpen,
              toggle: accessRules.headerForm.toggleForm
            }
          : null;

  if (!form) {
    return null;
  }

  const FormIcon = form.Icon;
  return (
    <button className={primaryButton} onClick={form.toggle} type="button">
      <FormIcon aria-hidden="true" className="size-3.5" />
      {form.open ? "Hide form" : `New ${form.label}`}
    </button>
  );
}

function AdminSectionContent({
  accessRules,
  activeSection,
  adminEmail,
  dashboard,
  groups,
  invites,
  lastLoadedAt,
  mcp,
  mcpSection,
  onRequestRevokeAllSessions,
  submitting,
  users
}: Readonly<{
  accessRules: AdminAccessRulesController;
  activeSection: AdminSectionId;
  adminEmail: string;
  dashboard: AdminDashboard;
  groups: AdminGroupsController;
  invites: AdminInvitesController;
  lastLoadedAt: Date | null;
  mcp: AdminMcpController;
  mcpSection: AdminMcpSectionState;
  onRequestRevokeAllSessions(): void;
  submitting: boolean;
  users: AdminUsersController;
}>) {
  switch (activeSection) {
    case "groups":
      return groups.groups.sectionProps ? <AdminGroupsSection {...groups.groups.sectionProps} /> : null;
    case "model-access":
      return groups.modelAccess.sectionProps ? (
        <AdminModelAccessSection
          {...groups.modelAccess.sectionProps}
          mcpAccess={groups.modelAccess.sectionProps.data.selectedGroup ? (
            <AdminMcpGroupAccessPanel
              controller={mcp}
              group={groups.modelAccess.sectionProps.data.selectedGroup}
            />
          ) : null}
        />
      ) : null;
    case "mcp":
      return <AdminMcpServersSection controller={mcp} section={mcpSection} />;
    case "invites":
      return invites.sectionProps ? <AdminInvitesSection {...invites.sectionProps} /> : null;
    case "access-rules":
      return accessRules.sectionProps ? <AdminAccessRulesSection {...accessRules.sectionProps} /> : null;
    case "usage":
      return <AdminUsageSection catalog={dashboard.catalog} usage={dashboard.usage} />;
    case "safety":
      return (
        <AdminSafetySection
          actionsDisabled={submitting}
          currentAdminEmail={adminEmail}
          lastRefreshedText={formatTime(lastLoadedAt)}
          onRequestRevokeAllSessions={onRequestRevokeAllSessions}
        />
      );
    case "users":
      return users.sectionProps ? (
        <AdminUsersSection
          {...users.sectionProps}
          mcpAccess={users.sectionProps.data.selectedUser ? (
            <AdminMcpUserAccessPanel controller={mcp} user={users.sectionProps.data.selectedUser} />
          ) : null}
        />
      ) : null;
  }

  return assertNeverSection(activeSection);
}

export function AdminPanel({ adminEmail, adminUserId }: AdminPanelProps) {
  const feedback = useAdminFeedback();
  const navigation = useAdminSectionNavigation();
  const resource = useAdminDashboardResource({ feedback });
  const actionRunner = useAdminActionRunner({
    feedback,
    onMutationReconciled: navigation.restoreFocusAfterMutation,
    refreshDashboard: resource.refresh
  });
  const confirmation = useAdminConfirmationController({ runAction: actionRunner.runAction });
  const fieldErrors = useAdminFieldErrors(feedback);
  const operationalFocus = useAdminOperationalFocus();
  const nowMs = resource.lastLoadedAt?.getTime() ?? 0;
  const actionsDisabled = Boolean(actionRunner.submitting);

  const users = useAdminUsersController({
    actionsDisabled,
    adminUserId,
    dashboard: resource.dashboard,
    focus: operationalFocus.focus.users,
    requestConfirmedAction: confirmation.requestConfirmedAction,
    requestFocus: operationalFocus.requestFocus,
    runAction: actionRunner.runAction
  });
  const groups = useAdminGroupsController({
    actionsDisabled,
    dashboard: resource.dashboard,
    fieldErrors,
    focus: operationalFocus.focus,
    onMutationReconciled: navigation.restoreFocusAfterMutation,
    refreshDashboard: resource.refresh,
    reportNotice: feedback.reportNotice,
    requestConfirmation: confirmation.requestConfirmation,
    requestConfirmedAction: confirmation.requestConfirmedAction,
    requestFocus: operationalFocus.requestFocus,
    runAction: actionRunner.runAction
  });
  const invites = useAdminInvitesController({
    actionsDisabled,
    confirmation,
    dashboard: resource.dashboard,
    feedback,
    fieldErrors,
    nowMs,
    runAction: actionRunner.runAction
  });
  const accessRules = useAdminAccessRulesController({
    actionsDisabled,
    confirmation,
    dashboard: resource.dashboard,
    fieldErrors,
    runAction: actionRunner.runAction
  });
  const mcp = useAdminMcpController({
    active: Boolean(resource.dashboard) && ["mcp", "model-access", "users"].includes(navigation.activeSection)
  });
  const mcpSection = useAdminMcpSectionState();
  const overview = useMemo(
    () => deriveAdminDashboardOverview(resource.dashboard, nowMs),
    [nowMs, resource.dashboard]
  );
  const { requestConfirmedAction } = confirmation;
  const requestRevokeAllSessions = useCallback(() => {
    requestConfirmedAction({
      body: {
        action: "revoke_all_sessions"
      },
      confirmLabel: "Revoke all sessions",
      dialogLabel: "Revoke all sessions",
      icon: "x",
      message: "All sessions revoked.",
      prompt: "Revoke every active session, including yours? Everyone will need to sign in again.",
      testId: "admin-confirm-revoke-all-sessions",
      title: "Revoke all sessions?",
      tone: "warning"
    });
  }, [requestConfirmedAction]);

  const isBusy = resource.loading || actionsDisabled;
  return (
    <main
      aria-busy={isBusy}
      className="min-h-[100dvh] overflow-x-hidden pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[max(1rem,env(safe-area-inset-top))] text-content-primary"
    >
      <div
        aria-hidden={confirmation.confirmation ? true : undefined}
        className="mx-auto min-w-0 max-w-[1600px]"
        data-testid="admin-console-workspace"
        inert={confirmation.confirmation ? true : undefined}
      >
        <AdminConsoleHeader
          adminEmail={adminEmail}
          lastLoadedAt={resource.lastLoadedAt}
          loading={resource.loading}
          onRefresh={() => void resource.refresh()}
          submitting={actionsDisabled}
        />
        <AdminFeedbackMessages error={feedback.error} notice={feedback.notice} />

        {resource.dashboard ? (
          <>
            <AdminDashboardOverview onSelectSection={navigation.selectSection} overview={overview} />
            <AdminSectionFrame
              headerActions={
                <AdminHeaderAction
                  accessRules={accessRules}
                  activeSection={navigation.activeSection}
                  groups={groups}
                  invites={invites}
                />
              }
              navigation={navigation}
            >
              <AdminSectionContent
                accessRules={accessRules}
                activeSection={navigation.activeSection}
                adminEmail={adminEmail}
                dashboard={resource.dashboard}
                groups={groups}
                invites={invites}
                lastLoadedAt={resource.lastLoadedAt}
                mcp={mcp}
                mcpSection={mcpSection}
                onRequestRevokeAllSessions={requestRevokeAllSessions}
                submitting={actionsDisabled}
                users={users}
              />
            </AdminSectionFrame>
          </>
        ) : (
          <section aria-label="Admin data state" className="mt-3 rounded-panel bg-surface-navigation/90">
            <AdminDashboardUnavailable loading={resource.loading} />
          </section>
        )}
      </div>
      <AdminConfirmationHost controller={confirmation} onClosed={navigation.restoreFocusAfterMutation} />
    </main>
  );
}
