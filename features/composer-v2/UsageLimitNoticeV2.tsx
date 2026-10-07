"use client";

import { usageLimitNotice } from "@/components/app-shell/usageLimitStatus";
import { useUsageLimitStatus, type UsageLimitStatusLoader } from "@/components/app-shell/useUsageLimitStatus";

/**
 * The composer's usage-limit line: a caution near a limit, the reset time once
 * one is reached. It never blocks Send (admission decides), and it stays
 * silent without limits, while loading and when the status cannot be read.
 */
export function UsageLimitNoticeV2({
  accountId,
  busy,
  load
}: Readonly<{ accountId: string; busy: boolean; load?: UsageLimitStatusLoader }>) {
  const { state } = useUsageLimitStatus({ busy, load, scopeKey: accountId });
  const notice = state.kind === "ready" ? usageLimitNotice(state.status, { now: new Date() }) : null;
  if (!notice) return null;
  return (
    <p className="v2-composer-status v2-composer-usage-limit" data-testid="composer-usage-limit" data-tone={notice.tone} role="status">
      {notice.text}
    </p>
  );
}
