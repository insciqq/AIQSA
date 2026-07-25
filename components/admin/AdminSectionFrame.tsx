import { AdminInactiveSectionPanels } from "@/components/admin/AdminSectionTabs";
import { SectionHeader } from "@/components/admin/adminPrimitives";
import { adminSectionPanelId, adminSectionTabId } from "@/components/admin/adminSections";
import type { AdminSectionNavigation } from "@/components/admin/useAdminSectionNavigation";
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
          actions={headerActions}
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
