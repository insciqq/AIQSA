"use client";

import { AdminAccessGroupsSection } from "@/components/admin/AdminAccessGroupsSection";
import { AdminAccessRulesSection } from "@/components/admin/AdminAccessRulesSection";
import { AdminConfirmationHost } from "@/components/admin/AdminConfirmationHost";
import { AdminDashboardUnavailable } from "@/components/admin/AdminDashboardUnavailable";
import {
  AdminDraftProtectionProvider,
  AdminDraftRegistration,
  useAdminDiscardAction,
  useAdminDraftRegistry,
  type AdminDraftOwner
} from "@/components/admin/AdminDraftProtection";
import { AdminEmailSection } from "@/components/admin/AdminEmailSection";
import { AdminFeedbackHost } from "@/components/admin/AdminFeedbackHost";
import { AdminInvitesSection } from "@/components/admin/AdminInvitesSection";
import { AdminMcpGroupAccessPanel, AdminMcpUserAccessPanel } from "@/components/admin/AdminMcpGrantPanels";
import { AdminMcpServersSection } from "@/components/admin/AdminMcpServersSection";
import { AdminOverviewSection } from "@/components/admin/AdminOverviewSection";
import { AdminProvidersSection } from "@/components/admin/providers/AdminProvidersSection";
import { AdminRetrievalSection } from "@/components/admin/retrieval/AdminRetrievalSection";
import { AdminRolesSection } from "@/components/admin/roles/AdminRolesSection";
import { AdminSearchSection } from "@/components/admin/search/AdminSearchSection";
import {
  AdminReleaseUpdatePill,
  AdminSectionTopbarProvider,
  AdminShell,
  AdminTopbarMenu,
  type AdminShellTopbar
} from "@/components/admin/AdminShell";
import { AdminUsageSection } from "@/components/admin/AdminUsageSection";
import { AdminUsersSection } from "@/components/admin/AdminUsersSection";
import { AdminWorkspaceSection } from "@/components/admin/AdminWorkspaceSection";
import { primaryButton } from "@/components/admin/adminPrimitives";
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
import { useAdminFieldErrors } from "@/components/admin/useAdminFieldErrors";
import { useAdminGroupsController, type AdminGroupsController } from "@/components/admin/useAdminGroupsController";
import { useAdminInvitesController, type AdminInvitesController } from "@/components/admin/useAdminInvitesController";
import { useAdminMcpController, type AdminMcpController } from "@/components/admin/useAdminMcpController";
import { useAdminMcpSectionState, type AdminMcpSectionState } from "@/components/admin/useAdminMcpSectionState";
import { useAdminOperationalFocus } from "@/components/admin/useAdminOperationalFocus";
import { useAdminReleaseStatus } from "@/components/admin/useAdminReleaseStatus";
import {
  useAdminSectionNavigation,
  type AdminBlockedNavigation,
  type AdminSectionNavigation
} from "@/components/admin/useAdminSectionNavigation";
import { useAdminUsersController, type AdminUsersController } from "@/components/admin/useAdminUsersController";
import { useBeforeUnloadGuard } from "@/components/app-shell/useBeforeUnloadGuard";
import type { AdminDashboard } from "@/lib/contracts/admin";
import type { AdminAttentionTarget } from "@/lib/contracts/adminAttention";
import { Link2, Plus } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

type AdminPanelProps = Readonly<{
  adminEmail: string;
  adminUserId: string;
}>;

function assertNeverSection(section: never): never {
  throw new Error(`Unhandled admin section: ${section}`);
}

function HeaderFormToggle({
  Icon,
  label,
  open,
  owners,
  toggle
}: Readonly<{
  Icon: typeof Plus;
  label: string;
  open: boolean;
  owners: readonly AdminDraftOwner[];
  toggle(): void;
}>) {
  const requestDiscardAction = useAdminDiscardAction();
  return (
    <button
      className={primaryButton}
      data-admin-task-opener="true"
      onClick={() => requestDiscardAction(toggle, owners)}
      type="button"
    >
      <Icon aria-hidden="true" className="size-3.5" />
      {open ? "Hide form" : `New ${label}`}
    </button>
  );
}

/**
 * Topbar primary actions per section. Until later slices replace each
 * section, the existing header forms keep their toggles here.
 */
function AdminTopbarActions({
  accessRules,
  activeSection,
  actionsDisabled,
  groups,
  invites,
  onRequestRevokeAllSessions,
  releaseStatus
}: Readonly<{
  accessRules: AdminAccessRulesController;
  activeSection: AdminSectionId;
  actionsDisabled: boolean;
  groups: AdminGroupsController;
  invites: AdminInvitesController;
  onRequestRevokeAllSessions(): void;
  releaseStatus: ReturnType<typeof useAdminReleaseStatus>;
}>): ReactNode {
  switch (activeSection) {
    case "overview":
      return (
        <>
          <AdminReleaseUpdatePill releaseStatus={releaseStatus} />
          <AdminTopbarMenu
            actions={[
              {
                disabled: actionsDisabled,
                icon: "logout",
                label: "Revoke all sessions",
                onSelect: onRequestRevokeAllSessions,
                tone: "destructive"
              }
            ]}
          />
        </>
      );
    case "groups":
      return groups.access.sectionProps && !groups.access.sectionProps.draft.detailOpen ? (
        <HeaderFormToggle
          Icon={Plus}
          label="group"
          open={groups.access.sectionProps.draft.createFormOpen}
          owners={["access-groups-form", "access-group-member-form"]}
          toggle={groups.access.toggleCreateForm}
        />
      ) : null;
    case "users":
      return (
        <>
          <HeaderFormToggle
            Icon={Link2}
            label="invite"
            open={invites.headerForm.formOpen}
            owners={["invite-form"]}
            toggle={invites.headerForm.toggleForm}
          />
          <HeaderFormToggle
            Icon={Plus}
            label="rule"
            open={accessRules.headerForm.formOpen}
            owners={["access-rule-form"]}
            toggle={accessRules.headerForm.toggleForm}
          />
        </>
      );
    default:
      return null;
  }
}

function StackedBlock({ children, heading, testId }: Readonly<{ children: ReactNode; heading: string; testId: string }>) {
  return (
    <section
      aria-label={heading}
      className="border-t border-trace-subtle first:border-t-0"
      data-testid={testId}
    >
      <h2 className="px-4 pt-6 text-base font-semibold text-ink sm:px-6 lg:px-8">{heading}</h2>
      {children}
    </section>
  );
}

function AdminSectionContent({
  accessRules,
  activeSection,
  attention,
  dashboard,
  feedback,
  groups,
  invites,
  mcp,
  mcpSection,
  navigation,
  onJump,
  onMutationCommitted,
  reportError,
  reportNotice,
  requestConfirmation,
  users
}: Readonly<{
  accessRules: AdminAccessRulesController;
  activeSection: AdminSectionId;
  attention: ReturnType<typeof useAdminAttention>;
  dashboard: AdminDashboard;
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  groups: AdminGroupsController;
  invites: AdminInvitesController;
  mcp: AdminMcpController;
  mcpSection: AdminMcpSectionState;
  navigation: Pick<AdminSectionNavigation, "activeResource" | "selectResource" | "selectSection">;
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
        <>
          {users.sectionProps ? (
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
          ) : null}
          {invites.sectionProps ? (
            <StackedBlock heading="Invites" testId="admin-section-invites">
              <AdminInvitesSection {...invites.sectionProps} />
            </StackedBlock>
          ) : null}
          {accessRules.sectionProps ? (
            <StackedBlock heading="Sign-up rules" testId="admin-section-access-rules">
              <AdminAccessRulesSection {...accessRules.sectionProps} />
            </StackedBlock>
          ) : null}
        </>
      );
    case "groups":
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
    case "workspace":
      return <AdminWorkspaceSection />;
    case "email":
      return <AdminEmailSection onMutationCommitted={onMutationCommitted} />;
    case "usage":
      return <AdminUsageSection catalog={dashboard.catalog} usage={dashboard.usage} />;
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
  const lastLoadedMs = resource.lastLoadedAt?.getTime() ?? null;
  const releaseStatus = useAdminReleaseStatus(lastLoadedMs);
  const actionRunner = useAdminActionRunner({
    feedback,
    onMutationReconciled: navigation.restoreFocusAfterMutation,
    refreshDashboard: resource.refresh
  });
  const confirmation = useAdminConfirmationController({ runAction: actionRunner.runAction });
  const fieldErrors = useAdminFieldErrors(feedback);
  const operationalFocus = useAdminOperationalFocus();
  const nowMs = lastLoadedMs ?? 0;
  const actionsDisabled = Boolean(actionRunner.submitting);
  const navigationLocked = actionsDisabled || drafts.pending;
  const allowReturnToChatRef = useRef(false);
  const returnToChatLinkRef = useRef<HTMLAnchorElement | null>(null);
  const attention = useAdminAttention({
    active: navigation.activeSection === "overview" && resource.dashboard !== null,
    refreshKey: lastLoadedMs
  });

  useEffect(() => {
    navigationBlockedRef.current = navigationLocked || drafts.dirty;
  }, [drafts.dirty, navigationLocked]);
  useBeforeUnloadGuard(drafts.dirty, drafts.hasDirty);

  const documentTitle = `${navigation.activeSectionConfig.label} · Control Center · AIQSA`;
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
      body: "Unsaved edits in this Control Center form will be lost.",
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
    active: Boolean(resource.dashboard) && ["mcp", "groups", "users"].includes(navigation.activeSection),
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
  const { selectSection } = navigation;
  const jumpToTarget = useCallback((target: AdminAttentionTarget) => {
    // Providers and Search have resource pages; later slices add theirs.
    const hasResourcePages = target.section === "providers" || target.section === "search";
    selectSection(target.section, hasResourcePages ? target.resource ?? null : null);
  }, [selectSection]);

  const [sectionTopbar, setSectionTopbar] = useState<AdminShellTopbar | null>(null);
  const dashboardAttention = resource.dashboard?.navigation.attention ?? null;
  const usersAttention = dashboardAttention
    ? dashboardAttention.pendingUsers + dashboardAttention.activeUsersWithoutModelAccess
    : 0;
  const activeSectionConfig = navigation.activeSectionConfig;
  const isBusy = resource.loading || navigationLocked;

  return (
    <AdminDraftProtectionProvider registry={drafts} requestDiscardAction={requestDiscardAction}>
    <main
      aria-busy={isBusy}
      className="min-h-[100dvh] overflow-x-hidden bg-app-canvas pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)] text-ink"
    >
      <AdminDraftRegistration
        dirty={navigation.activeSection === "groups" && groups.access.draftProtection.dirty}
        onDiscard={groups.access.draftProtection.discard}
        owner="access-groups-form"
      />
      <AdminDraftRegistration
        dirty={navigation.activeSection === "users" && invites.draftProtection.dirty}
        onDiscard={invites.draftProtection.discard}
        owner="invite-form"
      />
      <AdminDraftRegistration
        dirty={navigation.activeSection === "users" && accessRules.draftProtection.dirty}
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
                accessRules={accessRules}
                actionsDisabled={actionsDisabled}
                activeSection={navigation.activeSection}
                groups={groups}
                invites={invites}
                onRequestRevokeAllSessions={requestRevokeAllSessions}
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
                attention={attention}
                dashboard={resource.dashboard}
                feedback={feedback}
                groups={groups}
                invites={invites}
                mcp={mcp}
                mcpSection={mcpSection}
                navigation={navigation}
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
    </AdminDraftProtectionProvider>
  );
}
