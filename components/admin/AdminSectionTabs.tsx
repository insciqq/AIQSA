import {
  adminSectionPanelId,
  adminSections,
  adminSectionTabId,
  type AdminSectionId
} from "@/components/admin/adminSections";
import { focusRing, touchTarget } from "@/components/admin/adminPrimitives";
import type { AdminSectionNavigation } from "@/components/admin/useAdminSectionNavigation";

type AdminSectionTabsProps = Readonly<{
  navigation: Pick<
    AdminSectionNavigation,
    "activeSection" | "onTabKeyDown" | "registerTab" | "selectSection"
  >;
}>;

export function AdminSectionTabs({ navigation }: AdminSectionTabsProps) {
  return (
    <nav
      aria-label="Admin sections"
      className="mt-3 flex gap-1 overflow-x-auto border-b border-separator-subtle pb-2"
      role="tablist"
    >
      {adminSections.map((section) => {
        const active = section.id === navigation.activeSection;
        const SectionIcon = section.Icon;

        return (
          <button
            aria-controls={adminSectionPanelId(section.id)}
            aria-selected={active}
            className={[
              `flex min-h-control shrink-0 items-center gap-1.5 rounded-control px-3 text-xs font-medium ${focusRing} ${touchTarget}`,
              active
                ? "bg-surface-selected text-accent-cyan"
                : "bg-transparent text-content-secondary hover:bg-surface-hover hover:text-content-primary"
            ].join(" ")}
            data-testid={adminSectionTabId(section.id)}
            id={adminSectionTabId(section.id)}
            key={section.id}
            onClick={() => navigation.selectSection(section.id)}
            onKeyDown={(event) => navigation.onTabKeyDown(event, section.id)}
            ref={(node) => navigation.registerTab(section.id, node)}
            role="tab"
            tabIndex={active ? 0 : -1}
            type="button"
          >
            <SectionIcon aria-hidden="true" className="size-3.5" />
            {section.label}
          </button>
        );
      })}
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
