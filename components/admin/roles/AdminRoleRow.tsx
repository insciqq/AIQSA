"use client";

import { AdminTopbarMenu } from "@/components/admin/AdminShell";
import { AdminStatusPill } from "@/components/admin/roles/AdminStatusPill";
import { ADMIN_ROLE_STATUS_LABEL, type AdminRoleStatus } from "@/components/admin/roles/rolesView";
import type { UiV2MenuAction } from "@/components/ui-v2";
import type { ReactNode } from "react";

const rowGrid = "grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-3 px-4 py-3 xl:grid-cols-[minmax(0,1fr)_minmax(16rem,22rem)_8.5rem_2.5rem] xl:items-start xl:gap-4";

/** One System roles table row: title and description, deployment controls, status pill and actions menu. */
export function RoleRow({
  children,
  description,
  menu,
  status,
  statusLabel,
  testId,
  title
}: Readonly<{
  children: ReactNode;
  description: string;
  menu: readonly UiV2MenuAction[];
  status: AdminRoleStatus;
  statusLabel?: string;
  testId: string;
  title: string;
}>) {
  return (
    <div className={`${rowGrid} border-t border-trace-subtle first:border-t-0`} data-testid={testId} id={testId} tabIndex={-1}>
      <div className="order-1 min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        <p className="mt-0.5 text-xs leading-5 text-ink-muted">{description}</p>
      </div>
      <div className="order-2 xl:order-4 xl:justify-self-end">
        {menu.length ? <AdminTopbarMenu actions={menu} label={`${title} actions`} /> : null}
      </div>
      <div className="order-3 col-span-2 grid gap-1.5 xl:order-2 xl:col-span-1">{children}</div>
      <div className="order-4 col-span-2 xl:order-3 xl:col-span-1 xl:pt-1.5">
        <AdminStatusPill label={statusLabel ?? ADMIN_ROLE_STATUS_LABEL[status]} status={status} testId={`${testId}-status`} />
      </div>
    </div>
  );
}
