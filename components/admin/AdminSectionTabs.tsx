import {
  adminSectionGroups,
  adminSectionPanelId,
  adminSections,
  adminSectionTabId,
  type AdminSectionId
} from "@/components/admin/adminSections";
import { focusRing, touchTarget } from "@/components/admin/adminPrimitives";
import type { AdminSectionNavigation } from "@/components/admin/useAdminSectionNavigation";
import { useEffect, useRef } from "react";

type AdminSectionTabsProps = Readonly<{
  navigation: Pick<
    AdminSectionNavigation,
    "activeSection" | "onTabKeyDown" | "registerTab" | "selectSection"
  >;
}>;

export function AdminSectionTabs({ navigation }: AdminSectionTabsProps) {
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
      if (tabRect.left < tablistRect.left) {
        tablist.scrollLeft -= tablistRect.left - tabRect.left;
      } else if (tabRect.right > tablistRect.right) {
        tablist.scrollLeft += tabRect.right - tablistRect.right;
      }

      if (tabRect.top < tablistRect.top) {
        tablist.scrollTop -= tablistRect.top - tabRect.top;
      } else if (tabRect.bottom > tablistRect.bottom) {
        tablist.scrollTop += tabRect.bottom - tablistRect.bottom;
      }
    });

    return () => window.cancelAnimationFrame(frame);
  }, [navigation.activeSection]);

  return (
    <nav
      aria-label="Control Center sections"
      className="flex min-w-0 gap-4 overflow-x-auto px-4 py-3 lg:sticky lg:top-0 lg:h-[100dvh] lg:flex-col lg:gap-5 lg:overflow-x-hidden lg:overflow-y-auto lg:px-3 lg:py-5"
      ref={tablistRef}
      role="tablist"
    >
      {adminSectionGroups.map((group) => (
        <div className="flex shrink-0 flex-col gap-1.5 lg:w-full" key={group.id} role="presentation">
          <p className="px-2.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
            {group.label}
          </p>
          <div className="flex gap-1 lg:flex-col" role="presentation">
            {adminSections
              .filter((section) => section.group === group.id)
              .map((section) => {
                const active = section.id === navigation.activeSection;
                const SectionIcon = section.Icon;

                return (
                  <button
                    aria-controls={adminSectionPanelId(section.id)}
                    aria-selected={active}
                    className={[
                      `group/nav-item flex min-h-control shrink-0 items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm font-medium transition-colors lg:w-full ${focusRing} ${touchTarget}`,
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
                    {section.label}
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </nav>
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
