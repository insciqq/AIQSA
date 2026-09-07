"use client";

import type { AdminModelCheckState } from "@/components/admin/providers/models/useAdminModelChecks";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminProviderConnection } from "@/lib/contracts/adminProviders";
import { useState } from "react";

export type AdminProviderCheckBannerProps = Readonly<{
  checks: AdminModelCheckState;
  connection: AdminProviderConnection;
  disabled: boolean;
}>;

/**
 * The `KeyVerifying` state (PRD 5.4): while the background check runs the
 * page shows one banner with the count, a bar and `Stop checking`; a run
 * lost to a restart shows the same slot with `Restart`. Single-model checks
 * only spin inside their row.
 */
export function AdminProviderCheckBanner({ checks, connection, disabled }: AdminProviderCheckBannerProps) {
  const [stopping, setStopping] = useState(false);
  const { interrupted, run } = checks;
  const keyLabel = (credentialId: string) =>
    connection.credentials.find(({ id }) => id === credentialId)?.label ?? "the key";

  if (run?.state === "running" && run.reason !== "model") {
    const progress = run.total === 0 ? 100 : Math.round((run.done / run.total) * 100);
    const title = run.reason === "requested"
      ? `Checking what each model can do with key ${keyLabel(run.credentialId)} — ${run.done} of ${run.total} done.`
      : `Key ${keyLabel(run.credentialId)} saved and working. Checking what each model can do — ${run.done} of ${run.total} done.`;
    return (
      <section
        aria-live="polite"
        className="flex min-w-0 flex-col gap-2.5 rounded-[12px] border border-proof/30 bg-answer-paper px-4 py-3.5 sm:px-5"
        data-testid="provider-check-banner"
        role="status"
      >
        <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
          <span aria-hidden="true" className="v2-spinner hidden shrink-0 text-proof sm:block" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-ink" data-testid="provider-check-progress">{title}</p>
            <p className="mt-0.5 text-xs leading-5 text-ink-muted">
              Tools, JSON output, PDF and image input, streaming. About 6 small requests per model. You can leave this page.
            </p>
          </div>
          <UiV2Button
            busy={stopping}
            disabled={disabled}
            onClick={() => {
              setStopping(true);
              void checks.stop().finally(() => setStopping(false));
            }}
            tone="ghost"
            type="button"
          >
            Stop checking
          </UiV2Button>
        </div>
        <div
          aria-label="Models checked"
          aria-valuemax={run.total}
          aria-valuemin={0}
          aria-valuenow={run.done}
          className="h-1 overflow-hidden rounded-pill bg-trace-strong"
          role="progressbar"
        >
          <span className="block h-full rounded-pill bg-proof transition-[width]" style={{ width: `${progress}%` }} />
        </div>
      </section>
    );
  }

  if (interrupted) {
    return (
      <section
        className="flex min-w-0 flex-col gap-3 rounded-[12px] border border-caution/30 bg-answer-paper px-4 py-3.5 sm:flex-row sm:items-center sm:px-5"
        data-testid="provider-check-interrupted"
        role="status"
      >
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-ink">Checking was interrupted before it finished.</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-muted">
            Results already stored are kept. Start again to check the remaining models with key {keyLabel(interrupted.credentialId)}.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <UiV2Button disabled={disabled} onClick={() => void checks.restart()} tone="primary" type="button">Restart</UiV2Button>
          <UiV2Button onClick={checks.dismissInterrupted} tone="ghost" type="button">Dismiss</UiV2Button>
        </div>
      </section>
    );
  }

  return null;
}
