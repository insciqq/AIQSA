import { requestAdminReleaseStatus } from "@/components/admin/adminReleaseApi";
import type { AdminReleaseStatus } from "@/lib/contracts/adminRelease";
import { useEffect, useState } from "react";

export function useAdminReleaseStatus(refreshKey: number | null): AdminReleaseStatus | null {
  const [status, setStatus] = useState<AdminReleaseStatus | null>(null);

  useEffect(() => {
    if (refreshKey === null) return;
    let active = true;
    void requestAdminReleaseStatus().then((result) => {
      if (active && result.ok) setStatus(result.status);
    });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  return status;
}
