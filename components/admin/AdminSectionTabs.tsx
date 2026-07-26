import {
  adminSectionGroups,
  adminSectionPanelId,
  adminSections,
  adminSectionTabId,
  type AdminSectionId
} from "@/components/admin/adminSections";
import { focusRing, touchTarget } from "@/components/admin/adminPrimitives";
import type { AdminSectionNavigation } from "@/components/admin/useAdminSectionNavigation";
import type { AdminDashboard } from "@/lib/contracts/admin";
import { useEffect, useRef } from "react";

type AdminSectionTabsProps = Readonly<{
  navigation: Pick<
    AdminSectionNavigation,
    "activeSection" | "closeSectionIndex" | "onTabKeyDown" | "registerTab" | "selectSection"
  >;
  summary?: AdminDashboard["navigation"] | null;
}>;

function sectionAttention(
  section: AdminSectionId,
  attention: AdminDashboard["navigation"]["attention"] | null
): number {
  if (!attention) return 0;
  if (section === "users") {
    return attention.pendingUsers + attention.activeUsersWithoutModelAccess;
  }
  return section === "invites" ? attention.openInvites : 0;
}

export function AdminSectionTabs({ navigation, summary = null }: AdminSectionTabsProps) {
  const activeTabRef = useRef<HTMLButtonElement | null>(null);
  const tablistRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const activeTab = activeTabRef.current;
    if (!activeTab) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const tablist = tablistRef.current;
      if (!tablist) return;

      const tablistRect = tablist.getBoundingClientRect();
      const tabRect = activeTab.getBoundingClientRect();
      if (tabRect.top < tablistRect.top) {
        tablist.scrollTop -= tablistRect.top - tabRect.top;
      } else if (tabRect.bottom > tablistRect.bottom) {
        tablist.scrollTop += tabRect.bottom - tablistRect.bottom;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [navigation.activeSection]);

  return (
    <div className="flex min-h-full min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-trace-subtle px-4 py-4 lg:hidden">
        <div>
          <p className="text-sm font-semibold text-ink">Sections</p>
          <p className="mt-0.5 text-xs text-ink-muted">Choose one Control Center task.</p>
        </div>
        <button
          className={`min-h-control-sm rounded-control px-3 text-xs font-medium text-ink-secondary hover:bg-control-hover ${focusRing} ${touchTarget}`}
          onClick={navigation.closeSectionIndex}
          type="button"
        >
          Back
        </button>
      </div>

      <nav
        aria-label="Control Center sections"
        className="min-h-0 min-w-0 flex-1 overflow-y-auto px-3 py-4 lg:sticky lg:top-0 lg:h-[100dvh] lg:py-5"
        data-testid="admin-section-index"
        ref={tablistRef}
        role="tablist"
      >
        <div className="flex min-w-0 flex-col gap-5">
          {adminSectionGroups.map((group) => {
            const sections = adminSections.filter((section) => section.group === group.id);

            return (
              <div className="min-w-0" data-testid={`admin-nav-group-${group.id}`} key={group.id} role="presentation">
                <p className="px-2.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted">
                  {group.label}
                </p>

                {sections.length ? (
                  <div className="mt-1 flex min-w-0 flex-col gap-1" role="presentation">
                    {sections.map((section) => {
                      const active = section.id === navigation.activeSection;
                      const SectionIcon = section.Icon;
                      const attention = sectionAttention(section.id, summary?.attention ?? null);

                      return (
                        <button
                          aria-controls={adminSectionPanelId(section.id)}
                          aria-selected={active}
                          className={[
                            `group/nav-item flex min-h-control w-full min-w-0 items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm font-medium transition-colors ${focusRing} ${touchTarget}`,
                            active
                              ? "bg-control-selected text-ink"
                              : "bg-transparent text-ink-secondary hover:bg-control-hover hover:text-ink active:bg-control-pressed"
                          ].join(" ")}
                          data-testid={adminSectionTabId(section.id)}
                          id={adminSectionTabId(section.id)}
                          key={section.id}
                          onClick={() => navigation.selectSection(section.id)}
                          onKeyDown={(event) => navigation.onTabKeyDown(event, section.id)}
                          ref={(node) => {
                            navigation.registerTab(section.id, node);
                            if (active) {
                              activeTabRef.current = node;
                            }
                          }}
                          role="tab"
                          tabIndex={active ? 0 : -1}
                          type="button"
                        >
                          <SectionIcon
                            aria-hidden="true"
                            className={`size-4 shrink-0 ${active ? "text-proof" : "text-ink-muted group-hover/nav-item:text-ink-secondary"}`}
                          />
                          <span className="min-w-0 flex-1 truncate">{section.label}</span>
                          {attention > 0 ? (
                            <span
                              aria-hidden="true"
                              className="shrink-0 rounded-pill bg-caution/10 px-1.5 py-0.5 font-mono text-[10px] text-caution"
                            >
                              {attention}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </nav>
    </div>
  );
}

export function AdminInactiveSectionPanels({ activeSection }: { activeSection: AdminSectionId }) {
  return adminSections
    .filter((section) => section.id !== activeSection)
    .map((section) => (
      <section
        aria-labelledby={adminSectionTabId(section.id)}
        hidden
        id={adminSectionPanelId(section.id)}
        key={section.id}
        role="tabpanel"
      />
    ));
}
