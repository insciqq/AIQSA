"use client";

import { AdminAccessRulesSection } from "@/components/admin/AdminAccessRulesSection";
import { AdminAccessGroupsSection } from "@/components/admin/AdminAccessGroupsSection";
import { AdminConfirmationHost } from "@/components/admin/AdminConfirmationHost";
import { AdminConsoleHeader } from "@/components/admin/AdminConsoleHeader";
import { AdminDashboardUnavailable } from "@/components/admin/AdminDashboardUnavailable";
import {
  AdminDraftProtectionProvider,
  AdminDraftRegistration,
  useAdminDiscardAction,
  useAdminDraftRegistry,
  type AdminDraftOwner
} from "@/components/admin/AdminDraftProtection";
import { AdminFeedbackMessages } from "@/components/admin/AdminFeedbackMessages";
import { AdminEmailSection } from "@/components/admin/AdminEmailSection";
import { AdminInvitesSection } from "@/components/admin/AdminInvitesSection";
import { AdminKnowledgeSection } from "@/components/admin/AdminKnowledgeSection";
import { AdminMemorySection } from "@/components/admin/AdminMemorySection";
import { AdminMcpGroupAccessPanel, AdminMcpUserAccessPanel } from "@/components/admin/AdminMcpGrantPanels";
import { AdminMcpServersSection } from "@/components/admin/AdminMcpServersSection";
import { AdminProvidersExperience } from "@/components/admin/AdminProvidersExperience";
import { AdminSafetySection } from "@/components/admin/AdminSafetySection";
import { AdminSearchSection } from "@/components/admin/AdminSearchSection";
import { AdminSectionFrame } from "@/components/admin/AdminSectionFrame";
import { AdminSectionTabs } from "@/components/admin/AdminSectionTabs";
import { AdminUsageSection } from "@/components/admin/AdminUsageSection";
import { AdminUsersSection } from "@/components/admin/AdminUsersSection";
import {
  AdminResourceDetailPane,
  AdminResourceIndexPane,
  primaryButton
} from "@/components/admin/adminPrimitives";
import type { AdminSectionId } from "@/components/admin/adminSections";
import { formatTime } from "@/components/admin/adminViewUtils";
import { useAdminAccessRulesController, type AdminAccessRulesController } from "@/components/admin/useAdminAccessRulesController";
import { useAdminActionRunner } from "@/components/admin/useAdminActionRunner";
import {
  useAdminConfirmationController,
  type AdminConfirmationController
} from "@/components/admin/useAdminConfirmationController";
import { useAdminDashboardResource } from "@/components/admin/useAdminDashboardResource";
import { useAdminReleaseStatus } from "@/components/admin/useAdminReleaseStatus";
import { useAdminFeedback } from "@/components/admin/useAdminFeedback";
import { useAdminFieldErrors } from "@/components/admin/useAdminFieldErrors";
import { useAdminGroupsController, type AdminGroupsController } from "@/components/admin/useAdminGroupsController";
import { useAdminInvitesController, type AdminInvitesController } from "@/components/admin/useAdminInvitesController";
import { useAdminMcpController, type AdminMcpController } from "@/components/admin/useAdminMcpController";
import { useAdminMcpSectionState, type AdminMcpSectionState } from "@/components/admin/useAdminMcpSectionState";
import { useAdminOperationalFocus } from "@/components/admin/useAdminOperationalFocus";
import {
  useAdminSectionNavigation,
  type AdminBlockedNavigation
} from "@/components/admin/useAdminSectionNavigation";
import { useAdminUsersController, type AdminUsersController } from "@/components/admin/useAdminUsersController";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import type { AdminDashboard } from "@/lib/contracts/admin";
import { Link2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

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
  const requestDiscardAction = useAdminDiscardAction();
  const form =
    activeSection === "access" && !groups.access.sectionProps?.draft.detailOpen
      ? {
          Icon: Plus,
          label: "group",
          open: groups.access.sectionProps?.draft.createFormOpen ?? false,
          owners: ["access-groups-form", "access-group-member-form"],
          toggle: groups.access.toggleCreateForm
        }
      : activeSection === "invites"
        ? {
            Icon: Link2,
            label: "invite",
            open: invites.headerForm.formOpen,
            owners: ["invite-form"],
            toggle: invites.headerForm.toggleForm
          }
        : activeSection === "access-rules"
          ? {
              Icon: Plus,
              label: "rule",
              open: accessRules.headerForm.formOpen,
              owners: ["access-rule-form"],
              toggle: accessRules.headerForm.toggleForm
            }
          : null;

  if (!form) {
    return null;
  }

  const FormIcon = form.Icon;
  return (
    <button
      className={primaryButton}
      data-admin-task-opener="true"
      onClick={() => requestDiscardAction(form.toggle, form.owners)}
      type="button"
    >
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
  onMutationCommitted,
  requestConfirmation,
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
  onMutationCommitted(): void | Promise<unknown>;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  onRequestRevokeAllSessions(): void;
  submitting: boolean;
  users: AdminUsersController;
}>) {
  switch (activeSection) {
    case "access":
      return groups.access.sectionProps ? (
        <AdminAccessGroupsSection
          {...groups.access.sectionProps}
          mcpAccess={groups.access.sectionProps.data.selectedGroup ? (
            <AdminMcpGroupAccessPanel
              controller={mcp}
              group={groups.access.sectionProps.data.selectedGroup}
            />
          ) : null}
        />
      ) : null;
    case "mcp":
      return <AdminMcpServersSection controller={mcp} section={mcpSection} />;
    case "email":
      return <AdminEmailSection onMutationCommitted={onMutationCommitted} />;
    case "providers":
      return (
        <AdminProvidersExperience
          active
          groups={dashboard.groups}
          onMutationCommitted={onMutationCommitted}
          requestConfirmation={requestConfirmation}
        />
      );
    case "search":
      return (
        <AdminSearchSection
          active
          onMutationCommitted={onMutationCommitted}
        />
      );
    case "knowledge":
      return (
        <AdminKnowledgeSection
          active
          onMutationCommitted={onMutationCommitted}
        />
      );
    case "memory":
      return <AdminMemorySection active />;
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
            <AdminMcpUserAccessPanel
              controller={mcp}
              groups={dashboard.groups}
              user={users.sectionProps.data.selectedUser}
            />
          ) : null}
        />
      ) : null;
  }

  return assertNeverSection(activeSection);
}

export function AdminPanel({ adminEmail, adminUserId }: AdminPanelProps) {
  const drafts = useAdminDraftRegistry();
  const navigationBlockedRef = useRef(false);
  const requestNavigationConfirmationRef = useRef<(
    (navigation: AdminBlockedNavigation) => void
  ) | null>(null);
  const canSelectSection = useCallback(() => !navigationBlockedRef.current, []);
  const canExitAdmin = useCallback(() => !navigationBlockedRef.current, []);
  const canToggleSectionIndex = useCallback(() => !navigationBlockedRef.current, []);
  const onNavigationBlocked = useCallback((navigation: AdminBlockedNavigation) => {
    requestNavigationConfirmationRef.current?.(navigation);
  }, []);
  const feedback = useAdminFeedback();
  const navigation = useAdminSectionNavigation({
    canExitAdmin,
    canSelectSection,
    canToggleSectionIndex,
    onNavigationBlocked
  });
  const resource = useAdminDashboardResource({ feedback });
  const releaseStatus = useAdminReleaseStatus(resource.lastLoadedAt?.getTime() ?? null);
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
  const navigationLocked = actionsDisabled || drafts.pending;
  const allowReturnToChatRef = useRef(false);
  const returnToChatLinkRef = useRef<HTMLAnchorElement | null>(null);

  useEffect(() => {
    navigationBlockedRef.current = navigationLocked || drafts.dirty;
  }, [drafts.dirty, navigationLocked]);
  useBeforeUnloadGuard(drafts.dirty, drafts.hasDirty);

  const documentTitle = resource.dashboard
    ? `${navigation.activeSectionConfig.label} · Control Center · AIQSA`
    : "Control Center · AIQSA";
  useEffect(() => {
    document.title = documentTitle;
  }, [documentTitle]);

  const requestDiscardAction = useCallback((
    action: () => void,
    owners?: readonly AdminDraftOwner[]
  ) => {
    if (actionsDisabled || drafts.hasPending(owners)) return false;
    if (!drafts.hasDirty(owners)) {
      action();
      return true;
    }

    confirmation.requestConfirmation({
      body: "Unsaved edits in this Control Center task will be lost.",
      confirmLabel: "Discard changes",
      dialogLabel: "Discard unsaved changes",
      icon: "x",
      onConfirm: () => {
        drafts.discard(owners);
        action();
      },
      testId: "admin-discard-unsaved-confirmation",
      title: "Discard unsaved changes?",
      tone: "warning"
    });
    return false;
  }, [actionsDisabled, confirmation, drafts]);

  useEffect(() => {
    requestNavigationConfirmationRef.current = (blockedNavigation) => {
      requestDiscardAction(blockedNavigation.proceed);
    };
    return () => {
      requestNavigationConfirmationRef.current = null;
    };
  }, [requestDiscardAction]);

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
    active: Boolean(resource.dashboard) && ["mcp", "access", "users"].includes(navigation.activeSection),
    onMutationCommitted: resource.refresh
  });
  const mcpSection = useAdminMcpSectionState();
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

  const isBusy = resource.loading || navigationLocked;
  return (
    <AdminDraftProtectionProvider registry={drafts} requestDiscardAction={requestDiscardAction}>
    <main
      aria-busy={isBusy}
      className="min-h-[100dvh] overflow-x-hidden bg-app-canvas pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink"
      data-ui-presentation="v2-tokens"
    >
      <AdminDraftRegistration
        dirty={navigation.activeSection === "access" && groups.access.draftProtection.dirty}
        onDiscard={groups.access.draftProtection.discard}
        owner="access-groups-form"
      />
      <AdminDraftRegistration
        dirty={navigation.activeSection === "invites" && invites.draftProtection.dirty}
        onDiscard={invites.draftProtection.discard}
        owner="invite-form"
      />
      <AdminDraftRegistration
        dirty={navigation.activeSection === "access-rules" && accessRules.draftProtection.dirty}
        onDiscard={accessRules.draftProtection.discard}
        owner="access-rule-form"
      />
      <AdminDraftRegistration
        dirty={navigation.activeSection === "users" && users.draftProtection.dirty}
        onDiscard={users.draftProtection.discard}
        owner="user-membership-form"
      />
      <div
        aria-hidden={confirmation.confirmation ? true : undefined}
        className="mx-auto grid min-h-[100dvh] min-w-0 max-w-[1680px] grid-rows-[auto_minmax(0,1fr)] bg-answer-paper lg:grid-cols-[15rem_minmax(0,1fr)]"
        data-testid="admin-console-workspace"
        inert={confirmation.confirmation ? true : undefined}
      >
        <div className="min-w-0 lg:col-start-2 lg:row-start-1">
          <AdminConsoleHeader
            adminEmail={adminEmail}
            lastLoadedAt={resource.lastLoadedAt}
            loading={resource.loading}
            navigationDisabled={drafts.pending}
            onReturnToChatClick={requestReturnToChat}
            onRefresh={() => requestDiscardAction(() => void resource.refresh())}
            releaseStatus={releaseStatus}
            submitting={actionsDisabled}
          />
        </div>
        <AdminResourceIndexPane
          className="border-b border-trace-subtle bg-workspace-rail lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:border-b-0 lg:border-r"
          compactVisible={navigation.sectionIndexOpen}
          testId="admin-section-index-pane"
        >
          <AdminSectionTabs
            navigation={navigation}
            navigationBlocked={navigationLocked}
            summary={resource.dashboard?.navigation ?? null}
          />
        </AdminResourceIndexPane>
        <AdminResourceDetailPane
          className="bg-answer-paper lg:col-start-2 lg:row-start-2"
          compactVisible={!navigation.sectionIndexOpen}
          testId="admin-active-task-pane"
        >
          <div className="px-4 sm:px-6 lg:px-8">
            <AdminFeedbackMessages error={feedback.error} notice={feedback.notice} />
          </div>

          {resource.dashboard ? (
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
              navigationBlocked={navigationLocked}
            >
              <div>
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
                  onMutationCommitted={resource.refresh}
                  requestConfirmation={confirmation.requestConfirmation}
                  onRequestRevokeAllSessions={requestRevokeAllSessions}
                  submitting={actionsDisabled}
                  users={users}
                />
              </div>
            </AdminSectionFrame>
          ) : (
            <section aria-label="Admin data state" className="min-h-full bg-answer-paper">
              <AdminDashboardUnavailable loading={resource.loading} />
            </section>
          )}
        </AdminResourceDetailPane>
      </div>
      <AdminConfirmationHost controller={confirmation} onClosed={navigation.restoreFocusAfterMutation} />
    </main>
    </AdminDraftProtectionProvider>
  );
}
