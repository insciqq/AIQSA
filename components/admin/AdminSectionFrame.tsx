import { AdminInactiveSectionPanels } from "@/components/admin/AdminSectionTabs";
import { quietButton, SectionHeader } from "@/components/admin/adminPrimitives";
import { adminSectionPanelId, adminSectionTabId } from "@/components/admin/adminSections";
import type { AdminSectionNavigation } from "@/components/admin/useAdminSectionNavigation";
import { ListTree } from "lucide-react";
import type { ReactNode } from "react";

export function AdminSectionFrame({
  children,
  headerActions,
  navigation
}: Readonly<{
  children: ReactNode;
  headerActions?: ReactNode;
  navigation: AdminSectionNavigation;
}>) {
  const { activeSection, activeSectionConfig } = navigation;

  return (
    <>
      <section
        aria-labelledby={adminSectionTabId(activeSection)}
        className="min-h-full min-w-0 bg-answer-paper"
        data-testid={`admin-section-${activeSection}`}
        id={adminSectionPanelId(activeSection)}
        role="tabpanel"
      >
        <SectionHeader
          actions={
            <>
              <button
                className={`${quietButton} lg:hidden`}
                onClick={navigation.openSectionIndex}
                type="button"
              >
                <ListTree aria-hidden="true" className="size-3.5" />
                All sections
              </button>
              {headerActions}
            </>
          }
          description={activeSectionConfig.description}
          Icon={activeSectionConfig.Icon}
          title={activeSectionConfig.label}
        />
        {children}
      </section>
      <AdminInactiveSectionPanels activeSection={activeSection} />
    </>
  );
}
