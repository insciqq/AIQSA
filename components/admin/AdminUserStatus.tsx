import { AvailabilityStatus } from "@/components/resource-lifecycle/AvailabilityStatus";
import { userStatusClass } from "@/components/admin/adminUserView";
import type { AdminUserRecord } from "@/lib/contracts/admin";

export function AdminUserStatus({ status }: Readonly<{ status: AdminUserRecord["status"] }>) {
  if (status === "active" || status === "disabled") {
    return (
      <AvailabilityStatus
        enabled={status === "active"}
        enabledLabel="Active"
      />
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-semibold leading-none ${userStatusClass(status)}`}
      data-user-status={status}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      <span className="capitalize">{status}</span>
    </span>
  );
}
