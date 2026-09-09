"use client";

import { AdminConfirmationHost } from "@/components/admin/AdminConfirmationHost";
import { AdminDashboardUnavailable } from "@/components/admin/AdminDashboardUnavailable";
import { AdminEmailSection } from "@/components/admin/email/AdminEmailSection";
import { AdminFeedbackHost } from "@/components/admin/AdminFeedbackHost";
import { AdminGroupsSection } from "@/components/admin/groups/AdminGroupsSection";
import { AdminMcpSection } from "@/components/admin/mcp/AdminMcpSection";
import { AdminOverviewSection } from "@/components/admin/AdminOverviewSection";
import { AdminProvidersSection } from "@/components/admin/providers/AdminProvidersSection";
import { AdminRetrievalSection } from "@/components/admin/retrieval/AdminRetrievalSection";
import { AdminRolesSection } from "@/components/admin/roles/AdminRolesSection";
import { AdminSearchSection } from "@/components/admin/search/AdminSearchSection";
import {
  AdminReleaseUpdatePill,
  AdminSectionTopbarProvider,
  AdminShell,
  type AdminShellTopbar
} from "@/components/admin/AdminShell";
import { AdminUsageSection } from "@/components/admin/AdminUsageSection";
import { AdminUsersSection } from "@/components/admin/users/AdminUsersSection";
import { AdminSignupRulesSection } from "@/components/admin/users/AdminSignupRulesSection";
import { AdminWorkspaceSection } from "@/components/admin/AdminWorkspaceSection";
import type { AdminSectionId } from "@/components/admin/adminSections";
import { useAdminAccessRulesController, type AdminAccessRulesController } from "@/components/admin/useAdminAccessRulesController";
import { useAdminActionRunner } from "@/components/admin/useAdminActionRunner";
import { useAdminAttention } from "@/components/admin/useAdminAttention";
import {
  useAdminConfirmationController,
  type AdminConfirmationController
} from "@/components/admin/useAdminConfirmationController";
import { useAdminDashboardResource } from "@/components/admin/useAdminDashboardResource";
import { useAdminFeedback, type AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { useAdminGroupsController, type AdminGroupsController } from "@/components/admin/useAdminGroupsController";
import { useAdminInvitesController, type AdminInvitesController } from "@/components/admin/useAdminInvitesController";
import { useAdminMcpController, type AdminMcpController } from "@/components/admin/useAdminMcpController";
import { useAdminReleaseStatus } from "@/components/admin/useAdminReleaseStatus";
import {
  useAdminSectionNavigation,
  type AdminSectionNavigation
} from "@/components/admin/useAdminSectionNavigation";
import { useAdminUsersController, type AdminUsersController } from "@/components/admin/useAdminUsersController";
import type { AdminDashboard } from "@/lib/contracts/admin";
import type { AdminAttentionTarget } from "@/lib/contracts/adminAttention";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

type AdminPanelProps = Readonly<{
  adminEmail: string;
  adminUserId: string;
}>;

function assertNeverSection(section: never): never {
  throw new Error(`Unhandled admin section: ${section}`);
}

/**
 * Topbar actions the panel provides itself; every section with its own
 * topbar overrides this through `useAdminSectionTopbar`.
 */
function AdminTopbarActions({
  activeSection,
  releaseStatus
}: Readonly<{
  activeSection: AdminSectionId;
  releaseStatus: ReturnType<typeof useAdminReleaseStatus>;
}>): ReactNode {
  switch (activeSection) {
    case "overview":
      return <AdminReleaseUpdatePill releaseStatus={releaseStatus} />;
    default:
      return null;
  }
}

function AdminSectionContent({
  accessRules,
  activeSection,
  adminEmail,
  attention,
  dashboard,
  feedback,
  groups,
  invites,
  mcp,
  navigation,
  nowMs,
  onJump,
  onMutationCommitted,
  reportError,
  reportNotice,
  requestConfirmation,
  users
}: Readonly<{
  accessRules: AdminAccessRulesController;
  activeSection: AdminSectionId;
  adminEmail: string;
  attention: ReturnType<typeof useAdminAttention>;
  dashboard: AdminDashboard;
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  groups: AdminGroupsController;
  invites: AdminInvitesController;
  mcp: AdminMcpController;
  navigation: Pick<AdminSectionNavigation, "activeFilter" | "activeResource" | "selectFilter" | "selectResource" | "selectSection">;
  nowMs: number;
  onJump(target: AdminAttentionTarget): void;
  onMutationCommitted(): void | Promise<unknown>;
  reportError: AdminFeedbackController["reportError"];
  reportNotice: AdminFeedbackController["reportNotice"];
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  users: AdminUsersController;
}>) {
  switch (activeSection) {
    case "overview":
      return <AdminOverviewSection controller={attention} onJump={onJump} />;
    case "providers":
      return (
        <AdminProvidersSection
          active
          feedback={feedback}
          groups={dashboard.groups}
          onMutationCommitted={onMutationCommitted}
          onNavigateSection={navigation.selectSection}
          onSelectResource={navigation.selectResource}
          requestConfirmation={requestConfirmation}
          resource={navigation.activeResource}
        />
      );
    case "roles":
      return (
        <AdminRolesSection
          groups={dashboard.groups}
          resource={navigation.activeResource}
          onMutationCommitted={onMutationCommitted}
          reportError={reportError}
          reportNotice={reportNotice}
          requestConfirmation={requestConfirmation}
        />
      );
    case "search":
      return (
        <AdminSearchSection
          active
          feedback={feedback}
          onMutationCommitted={onMutationCommitted}
          onSelectResource={navigation.selectResource}
          requestConfirmation={requestConfirmation}
          resource={navigation.activeResource}
        />
      );
    case "retrieval":
      return (
        <AdminRetrievalSection
          onMutationCommitted={onMutationCommitted}
          onOpenRoles={() => onJump({ section: "roles" })}
          reportNotice={reportNotice}
          requestConfirmation={requestConfirmation}
        />
      );
    case "users":
      return (
        <AdminUsersSection
          dashboard={dashboard}
          filter={navigation.activeFilter}
          invites={invites}
          mcp={mcp}
          onSelectFilter={navigation.selectFilter}
          onSelectResource={navigation.selectResource}
          resource={navigation.activeResource}
          users={users}
        />
      );
    case "access-rules":
      return <AdminSignupRulesSection controller={accessRules} groups={dashboard.groups} />;
    case "groups":
      return (
        <AdminGroupsSection
          dashboard={dashboard}
          groups={groups}
          mcp={mcp}
          nowMs={nowMs}
          onSelectResource={navigation.selectResource}
          resource={navigation.activeResource}
        />
      );
    case "mcp":
      return (
        <AdminMcpSection
          controller={mcp}
          dashboard={dashboard}
          feedback={feedback}
          onSelectResource={navigation.selectResource}
          requestConfirmation={requestConfirmation}
          resource={navigation.activeResource}
        />
      );
    case "workspace":
      return <AdminWorkspaceSection reportNotice={reportNotice} />;
    case "email":
      return (
        <AdminEmailSection
          active
          adminEmail={adminEmail}
          feedback={feedback}
          onMutationCommitted={onMutationCommitted}
          requestConfirmation={requestConfirmation}
        />
      );
    case "usage":
      return <AdminUsageSection catalog={dashboard.catalog} usage={dashboard.usage} />;
  }

  return assertNeverSection(activeSection);
}

export function AdminPanel({ adminEmail, adminUserId }: AdminPanelProps) {
  const navigationBlockedRef = useRef(false);
  const canSelectSection = useCallback(() => !navigationBlockedRef.current, []);
  const canExitAdmin = useCallback(() => !navigationBlockedRef.current, []);
  const canToggleSectionIndex = useCallback(() => !navigationBlockedRef.current, []);
  const feedback = useAdminFeedback();
  const navigation = useAdminSectionNavigation({
    canExitAdmin,
    canSelectSection,
    canToggleSectionIndex
  });
  const resource = useAdminDashboardResource({ feedback });
  const lastLoadedMs = resource.lastLoadedAt?.getTime() ?? null;
  const releaseStatus = useAdminReleaseStatus(lastLoadedMs);
  const actionRunner = useAdminActionRunner({
    feedback,
    onMutationReconciled: navigation.restoreFocusAfterMutation,
    refreshDashboard: resource.refresh
  });
  const confirmation = useAdminConfirmationController({ runAction: actionRunner.runAction });
  const nowMs = lastLoadedMs ?? 0;
  const actionsDisabled = Boolean(actionRunner.submitting);
  const navigationLocked = actionsDisabled;
  const allowReturnToChatRef = useRef(false);
  const returnToChatLinkRef = useRef<HTMLAnchorElement | null>(null);
  const attention = useAdminAttention({
    active: navigation.activeSection === "overview" && resource.dashboard !== null,
    refreshKey: lastLoadedMs
  });

  useEffect(() => {
    navigationBlockedRef.current = navigationLocked;
  }, [navigationLocked]);

  const documentTitle = `${navigation.activeSectionConfig.label} · Control Center · AIQSA`;
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  const requestReturnToChat = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    if (allowReturnToChatRef.current) {
      allowReturnToChatRef.current = false;
      return;
    }
    if (navigationLocked) {
      event.preventDefault();
      return;
    }
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }
    returnToChatLinkRef.current = event.currentTarget;
    if (!navigation.requestExit(event.currentTarget.href, () => {
      allowReturnToChatRef.current = true;
      returnToChatLinkRef.current?.click();
    })) {
      event.preventDefault();
    }
  }, [navigation, navigationLocked]);

  const users = useAdminUsersController({
    actionsDisabled,
    adminUserId,
    dashboard: resource.dashboard,
    requestConfirmedAction: confirmation.requestConfirmedAction,
    runAction: actionRunner.runAction
  });
  const groups = useAdminGroupsController({
    actionsDisabled: actionsDisabled || resource.loading,
    dashboard: resource.dashboard,
    onError: feedback.reportError,
    onNotice: feedback.reportNotice,
    refreshDashboard: () => resource.refresh({ afterReconcile: navigation.restoreFocusAfterMutation }),
    requestConfirmedAction: confirmation.requestConfirmedAction,
    runAction: actionRunner.runAction
  });
  const invites = useAdminInvitesController({
    actionsDisabled,
    confirmation,
    dashboard: resource.dashboard,
    feedback,
    nowMs,
    runAction: actionRunner.runAction
  });
  const accessRules = useAdminAccessRulesController({
    actionsDisabled,
    dashboard: resource.dashboard,
    runAction: actionRunner.runAction
  });
  const mcp = useAdminMcpController({
    active: Boolean(resource.dashboard) && ["mcp", "groups", "users"].includes(navigation.activeSection),
    onError: feedback.reportError,
    onMutationCommitted: resource.refresh,
    onNotice: feedback.reportNotice
  });
  const { selectSection } = navigation;
  const jumpToTarget = useCallback((target: AdminAttentionTarget) => {
    // Resource pages and role rows preserve the attention item's exact target.
    const hasResourcePages = target.section === "providers" || target.section === "search" ||
      target.section === "users" || target.section === "groups" || target.section === "mcp" || target.section === "roles";
    selectSection(
      target.section,
      hasResourcePages ? target.resource ?? null : null,
      target.section === "users" ? target.filter ?? null : null
    );
  }, [selectSection]);

  const [sectionTopbar, setSectionTopbar] = useState<AdminShellTopbar | null>(null);
  const dashboardAttention = resource.dashboard?.navigation.attention ?? null;
  const usersAttention = dashboardAttention
    ? dashboardAttention.pendingUsers + dashboardAttention.activeUsersWithoutModelAccess
    : 0;
  const activeSectionConfig = navigation.activeSectionConfig;
  const isBusy = resource.loading || navigationLocked;

  return (
    <main
      aria-busy={isBusy}
      className="min-h-[100dvh] overflow-x-hidden bg-app-canvas pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink"
    >
      <div
        aria-hidden={confirmation.confirmation ? true : undefined}
        data-testid="admin-console-workspace"
        inert={confirmation.confirmation ? true : undefined}
      >
        <AdminShell
          accountLabel={adminEmail}
          attentionCounts={{ users: usersAttention }}
          navigation={navigation}
          navigationBlocked={navigationLocked}
          onReturnToChat={requestReturnToChat}
          releaseStatus={releaseStatus}
          topbar={sectionTopbar ?? {
            actions: resource.dashboard ? (
              <AdminTopbarActions
                activeSection={navigation.activeSection}
                releaseStatus={releaseStatus}
              />
            ) : null,
            title: activeSectionConfig.label
          }}
        >
          {resource.dashboard ? (
            <section
              aria-label={activeSectionConfig.label}
              className="min-h-full min-w-0"
              data-testid={`admin-section-${navigation.activeSection}`}
            >
              <AdminSectionTopbarProvider value={setSectionTopbar}>
              <AdminSectionContent
                accessRules={accessRules}
                activeSection={navigation.activeSection}
                adminEmail={adminEmail}
                attention={attention}
                dashboard={resource.dashboard}
                feedback={feedback}
                groups={groups}
                invites={invites}
                mcp={mcp}
                navigation={navigation}
                nowMs={nowMs}
                onJump={jumpToTarget}
                onMutationCommitted={resource.refresh}
                reportError={feedback.reportError}
                reportNotice={feedback.reportNotice}
                requestConfirmation={confirmation.requestConfirmation}
                users={users}
              />
              </AdminSectionTopbarProvider>
            </section>
          ) : (
            <section aria-label="Admin data state" className="min-h-full">
              <AdminDashboardUnavailable loading={resource.loading} onRetry={() => void resource.refresh()} />
            </section>
          )}
        </AdminShell>
      </div>
      <AdminFeedbackHost feedback={feedback} />
      <AdminConfirmationHost controller={confirmation} onClosed={navigation.restoreFocusAfterMutation} />
    </main>
  );
}
