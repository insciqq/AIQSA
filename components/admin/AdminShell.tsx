/* eslint-disable @next/next/no-html-link-for-pages -- Control Center exits are full-document navigations so the native beforeunload guard owns document-level draft safety. */
"use client";

import {
  adminSectionGroups,
  adminSectionPath,
  adminSections,
  type AdminSectionId
} from "@/components/admin/adminSections";
import type { AdminSectionNavigation } from "@/components/admin/useAdminSectionNavigation";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import {
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuActions,
  UiV2MenuSurface,
  type UiV2MenuAction
} from "@/components/ui-v2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { AccountMenuV2 } from "@/features/navigation-v2/AccountMenuV2";
import type { AdminReleaseStatus } from "@/lib/contracts/adminRelease";
import { ArrowUpCircle } from "lucide-react";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type MouseEvent,
  type ReactNode
} from "react";

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-app-canvas";
const touchTarget =
  "[@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";

const DRAWER_QUERY = "(max-width: 1023px)";

function subscribeDrawerComposition(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => undefined;
  const query = window.matchMedia(DRAWER_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function readDrawerComposition(): boolean {
  if (typeof window === "undefined") return false;
  if (window.matchMedia) return window.matchMedia(DRAWER_QUERY).matches;
  return window.innerWidth < 1024;
}

/** True below the desktop breakpoint, where the section column is a scrim-backed drawer. */
export function useAdminDrawerComposition(): boolean {
  return useSyncExternalStore(subscribeDrawerComposition, readDrawerComposition, () => false);
}

export type AdminShellTopbar = Readonly<{
  actions?: ReactNode;
  title: ReactNode;
}>;

const AdminSectionTopbarContext = createContext<((topbar: AdminShellTopbar | null) => void) | null>(null);

export const AdminSectionTopbarProvider = AdminSectionTopbarContext.Provider;

/**
 * Lets the mounted section own the topbar (breadcrumbs, primary action,
 * `⋯` menu) instead of the panel's default title. The override clears when
 * the section unmounts or passes `null`.
 */
export function useAdminSectionTopbar(topbar: AdminShellTopbar | null): void {
  const setTopbar = useContext(AdminSectionTopbarContext);
  useEffect(() => {
    if (!setTopbar) return;
    setTopbar(topbar);
    return () => setTopbar(null);
  }, [setTopbar, topbar]);
}

export type AdminShellProps = Readonly<{
  accountLabel: string;
  attentionCounts?: Partial<Record<AdminSectionId, number>>;
  children: ReactNode;
  navigation: AdminSectionNavigation;
  navigationBlocked?: boolean;
  onReturnToChat?(event: MouseEvent<HTMLAnchorElement>): void;
  releaseStatus: AdminReleaseStatus | null;
  topbar: AdminShellTopbar;
}>;

/** The `⋯` topbar menu: a few section-level actions behind one control. */
export function AdminTopbarMenu({
  actions,
  label = "More actions"
}: Readonly<{
  actions: readonly UiV2MenuAction[];
  label?: string;
}>) {
  const [open, setOpen] = useState(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: () => setOpen(false), open });

  return (
    <div className="relative">
      <UiV2IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        icon="more"
        label={label}
        onClick={() => setOpen((value) => !value)}
        ref={triggerRef}
        tooltip={label}
      />
      {open ? (
        <UiV2MenuSurface className="absolute right-0 top-[calc(100%+0.375rem)] z-40" label={label} ref={menuRef}>
          <UiV2MenuActions actions={actions} onClose={() => setOpen(false)} />
        </UiV2MenuSurface>
      ) : null}
    </div>
  );
}

/** Update pill for the Overview topbar; the pill itself opens the release notes. */
export function AdminReleaseUpdatePill({ releaseStatus }: Readonly<{ releaseStatus: AdminReleaseStatus | null }>) {
  if (releaseStatus?.state !== "update_available" || !releaseStatus.latestVersion || !releaseStatus.releaseUrl) {
    return null;
  }
  return (
    <a
      className={`inline-flex h-[22px] items-center gap-1.5 rounded-pill border border-caution/25 bg-caution/10 px-2 text-metadata font-semibold text-caution hover:bg-caution/15 ${focusRing}`}
      data-testid="admin-release-update"
      href={releaseStatus.releaseUrl}
      rel="noreferrer"
      target="_blank"
      title={`Installed v${releaseStatus.currentVersion} · release notes open in a new tab`}
    >
      <ArrowUpCircle aria-hidden="true" className="size-3" />
      Update available · v{releaseStatus.latestVersion}
    </a>
  );
}

function SectionLink({
  active,
  blocked,
  count,
  navigation,
  section
}: Readonly<{
  active: boolean;
  blocked: boolean;
  count: number;
  navigation: AdminSectionNavigation;
  section: (typeof adminSections)[number];
}>) {
  const Icon = section.Icon;
  const href = typeof window === "undefined"
    ? adminSectionPath("/admin", section.id)
    : adminSectionPath(window.location.href, section.id);
  const countId = `admin-nav-${section.id}-count`;
  return (
    <a
      aria-current={active ? "page" : undefined}
      aria-describedby={count > 0 ? countId : undefined}
      aria-disabled={blocked && !active ? true : undefined}
      className={[
        `flex min-h-9 items-center gap-2.5 rounded-[8px] px-3 text-sm font-medium transition-colors ${focusRing} ${touchTarget}`,
        active
          ? "bg-control-selected text-ink"
          : blocked
            ? "cursor-not-allowed text-ink-disabled"
            : "text-ink-secondary hover:bg-control-hover hover:text-ink"
      ].join(" ")}
      data-testid={`admin-nav-${section.id}`}
      href={href}
      onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        if (blocked && !active) return;
        navigation.selectSection(section.id);
      }}
      ref={(node) => navigation.registerSectionLink(section.id, node)}
    >
      <Icon aria-hidden="true" className={`size-4 shrink-0 ${active ? "text-proof" : ""}`} />
      <span className="min-w-0 flex-1 truncate">{section.label}</span>
      {count > 0 ? (
        <span
          aria-hidden="true"
          className="shrink-0 rounded-pill bg-caution/10 px-1.5 py-px text-metadata font-semibold text-caution"
          id={countId}
          title={`${count} need attention`}
        >
          {count}
        </span>
      ) : null}
    </a>
  );
}

function ChatsLink({
  className,
  onClick,
  variant
}: Readonly<{
  className?: string;
  onClick?(event: MouseEvent<HTMLAnchorElement>): void;
  variant: "rail" | "row";
}>) {
  if (variant === "rail") {
    return (
      <a
        aria-label="Chats"
        className={`v2-rail-button v2-focusable ${className ?? ""}`.trim()}
        data-tooltip="Chats"
        data-tooltip-side="right"
        href="/"
        onClick={onClick}
      >
        <UiV2Icon name="chat" />
      </a>
    );
  }
  return (
    <a className={`v2-navigation-destination v2-focusable ${className ?? ""}`.trim()} href="/" onClick={onClick}>
      <UiV2Icon name="chat" />
      Chats
    </a>
  );
}

export function AdminShell({
  accountLabel,
  attentionCounts = {},
  children,
  navigation,
  navigationBlocked = false,
  onReturnToChat,
  releaseStatus,
  topbar
}: AdminShellProps) {
  const drawerComposition = useAdminDrawerComposition();
  const drawerOpen = drawerComposition && navigation.sectionIndexOpen;
  const { closeSectionIndex } = navigation;
  const drawerRef = useDialogFocus<HTMLElement>({
    active: drawerOpen,
    onClose: closeSectionIndex
  });

  useEffect(() => {
    if (!drawerComposition && navigation.sectionIndexOpen) closeSectionIndex();
  }, [closeSectionIndex, drawerComposition, navigation.sectionIndexOpen]);

  const version = releaseStatus ? `v${releaseStatus.currentVersion}` : null;
  const sectionIndex = (
    <nav aria-label="Control Center sections" className="flex min-w-0 flex-col gap-0.5" data-testid="admin-section-index">
      {adminSections.filter((section) => section.group === null).map((section) => (
        <SectionLink
          active={section.id === navigation.activeSection}
          blocked={navigationBlocked}
          count={attentionCounts[section.id] ?? 0}
          key={section.id}
          navigation={navigation}
          section={section}
        />
      ))}
      {adminSectionGroups.map((group) => (
        <div className="flex min-w-0 flex-col gap-0.5" data-testid={`admin-nav-group-${group.id}`} key={group.id}>
          <p className="px-3 pb-1.5 pt-3.5 text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted">
            {group.label}
          </p>
          {adminSections.filter((section) => section.group === group.id).map((section) => (
            <SectionLink
              active={section.id === navigation.activeSection}
              blocked={navigationBlocked}
              count={attentionCounts[section.id] ?? 0}
              key={section.id}
              navigation={navigation}
              section={section}
            />
          ))}
        </div>
      ))}
    </nav>
  );

  return (
    <div
      className="grid min-h-[100dvh] min-w-0 grid-cols-[minmax(0,1fr)] bg-app-canvas text-ink md:grid-cols-[3.5rem_minmax(0,1fr)] lg:grid-cols-[3.5rem_16.25rem_minmax(0,1fr)]"
      data-drawer-open={drawerOpen ? "true" : undefined}
      data-testid="admin-shell"
    >
      <UiV2IconSprite />

      <nav aria-label="Workspace" className="v2-rail sticky top-0 max-md:hidden" data-testid="admin-rail">
        <span aria-hidden="true" className="v2-rail-brand">
          <UiV2Icon name="brand" />
        </span>
        <div className="v2-rail-group">
          <ChatsLink onClick={onReturnToChat} variant="rail" />
        </div>
        <div className="v2-rail-group v2-rail-bottom">
          <span
            aria-current="page"
            aria-label="Control Center"
            className="v2-rail-button"
            data-tooltip="Control Center"
            data-tooltip-side="right"
            role="link"
          >
            <UiV2Icon name="shield" />
          </span>
          <AccountMenuV2 accountLabel={accountLabel} variant="avatar" />
        </div>
      </nav>

      {drawerOpen ? (
        <button
          aria-label="Dismiss sections"
          className="fixed inset-0 z-[29] bg-scrim/70 md:left-14 lg:hidden"
          data-testid="admin-drawer-scrim"
          onClick={closeSectionIndex}
          type="button"
        />
      ) : null}

      <aside
        aria-label="Control Center sections"
        aria-modal={drawerOpen ? true : undefined}
        className={[
          "flex min-w-0 flex-col border-r border-trace-subtle bg-workspace-rail",
          "max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-30 max-lg:w-[min(17.5rem,calc(100vw-3rem))] max-lg:shadow-overlay md:max-lg:left-14 md:max-lg:w-[16.25rem]",
          "lg:sticky lg:top-0 lg:h-[100dvh]",
          drawerOpen ? "" : "max-lg:hidden"
        ].join(" ")}
        data-testid="admin-section-column"
        ref={drawerRef}
        role={drawerOpen ? "dialog" : undefined}
      >
        <div className="flex h-12 shrink-0 items-center justify-between gap-2 px-3 pl-6">
          <p className="min-w-0 truncate text-sm font-semibold text-ink">Control Center</p>
          <div className="flex shrink-0 items-center gap-1">
            {version ? (
              <span className="font-mono text-metadata text-ink-muted" data-testid="admin-version">{version}</span>
            ) : null}
            {drawerOpen ? (
              <UiV2IconButton icon="close" label="Close sections" onClick={closeSectionIndex} />
            ) : null}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-4" data-testid="admin-section-scroll">
          {sectionIndex}
        </div>
        <div className="v2-navigation-footer md:hidden">
          <ChatsLink onClick={onReturnToChat} variant="row" />
          <AccountMenuV2 accountLabel={accountLabel} variant="row" />
        </div>
      </aside>

      {/* Topbar openers and section detail panes share one focus scope so Back returns focus to the opener. */}
      <div className="flex min-w-0 flex-col" data-admin-task-focus-scope="true">
        <header
          className="sticky top-0 z-20 flex h-12 shrink-0 items-center justify-between gap-3 border-b border-trace-subtle bg-app-canvas px-4 sm:px-6"
          data-testid="admin-topbar"
        >
          <div className="flex min-w-0 items-center gap-2">
            <UiV2IconButton
              aria-expanded={drawerOpen}
              className="lg:hidden"
              disabled={navigationBlocked}
              icon="menu"
              label="Sections"
              onClick={navigation.openSectionIndex}
            />
            <h1 className="min-w-0 truncate text-sm font-semibold text-ink" data-testid="admin-topbar-title">
              {topbar.title}
            </h1>
          </div>
          {topbar.actions ? (
            <div className="flex shrink-0 items-center gap-2" data-testid="admin-topbar-actions">
              {topbar.actions}
            </div>
          ) : null}
        </header>
        <div className="min-w-0 flex-1" data-testid="admin-content">
          {children}
        </div>
      </div>
    </div>
  );
}
