"use client";

import { useAdminSectionTopbar } from "@/components/admin/AdminShell";
import { ProxyListPanel } from "@/features/settings-v2/ProxyListPanel";

const topbar = { title: "Proxies" };

/** The proxies everyone on the installation can use. */
export function AdminProxiesSection() {
  useAdminSectionTopbar(topbar);
  return <div className="max-w-[1120px] min-w-0 px-4 py-6 sm:px-6 lg:px-8">
    <ProxyListPanel audience="administrator" />
  </div>;
}
