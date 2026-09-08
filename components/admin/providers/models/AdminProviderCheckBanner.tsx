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
    const progress = run.total === 0 ? 0 : Math.round((run.done / run.total) * 100);
    const title = run.setup?.state === "running" ? "Models checked. Setting up Search, roles and Knowledge…" : run.reason === "requested"
      ? `Checking what each model can do with key ${keyLabel(run.credentialId)} — ${run.done} of ${run.total} done.`
      : `Key ${keyLabel(run.credentialId)} saved. Checking what each model can do — ${run.done} of ${run.total} done.`;
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
              {run.setup?.state === "running"
                ? "Uses small verification requests. Existing models, role assignments and Knowledge configurations are kept."
                : "Checks supported capabilities, including tools, JSON, PDF, embeddings and reranking. You can leave this page."}
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
          aria-valuemax={Math.max(1, run.total)}
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

  if (run?.state === "completed" && (run.total === 0 || run.setup || run.skipped?.length)) {
    const setup = run.setup && run.setup.state !== "running" ? run.setup : null;
    const retry = run.total === 0 || setup?.state === "partial" || run.failed.length > 0 || Boolean(run.skipped?.length);
    return (
      <section className="rounded-[12px] border border-trace-subtle bg-answer-paper px-4 py-3.5 sm:px-5" role="status">
        <p className="text-sm font-medium text-ink">{run.total === 0
          ? "No models were checked."
          : retry ? "Some setup steps need another check." : "Automatic setup finished."}</p>
        <p className="mt-1 text-xs leading-5 text-ink-muted">{run.total === 0
          ? "Add a supported model or check which models this key can access."
          : setup?.search === "failed" ? "Search could not be verified. Your saved key and model results are kept."
          : run.failed.length ? `${run.failed.length} models hit a temporary failure. Results already stored are kept.`
          : setup?.state === "partial" ? "Some default assignments could not be saved. Retry setup to finish."
          : setup?.search === "ready" ? "Search checked and ready."
          : run.skipped?.length ? "Some models changed during checking. Recheck to use their current settings." : "Model results are shown below."}</p>
        {setup?.defaults.length ? <p className="mt-1 text-xs leading-5 text-ink-muted">Defaults set — {setup.defaults.join("; ")}.</p> : null}
        {retry ? <UiV2Button className="mt-2" disabled={disabled} onClick={() => void checks.restart()} tone="ghost" type="button">Retry setup</UiV2Button> : null}
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
