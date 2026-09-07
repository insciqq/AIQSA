"use client";

import { cardClass, sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { SearchSourceTile } from "@/components/admin/search/searchPrimitives";
import {
  durationLabel,
  searchCheckSummary,
  searchHeaderStatus,
  searchModelLabel,
  searchModelsReach,
  searchModelsReachDetail
} from "@/components/admin/search/searchSourceView";
import type { AdminSearchController } from "@/components/admin/search/useAdminSearchController";
import { UiV2Button } from "@/components/ui-v2";
import type { AdminSearchIntegration } from "@/lib/contracts/adminSearch";

const termClass = "text-xs font-medium text-ink-muted sm:pt-0.5";
const detailClass = "min-w-0 break-words text-sm text-ink [overflow-wrap:anywhere]";

/**
 * One source page (PRD 5.6): header with the status line, the last check
 * with `Run check`, and the facts of the source. Configure opens the sheet;
 * Enabled and Archive live in the topbar the section owns.
 */
export function AdminSearchSourcePage({
  controller,
  onOpenConfigure,
  source
}: Readonly<{
  controller: AdminSearchController;
  onOpenConfigure(): void;
  source: AdminSearchIntegration;
}>) {
  const busy = controller.state.busy;
  const check = searchCheckSummary(source);
  const reachDetail = searchModelsReachDetail(source);
  const archived = source.archivedAt !== null;

  return (
    <div className="flex max-w-[1120px] flex-col gap-7 px-4 py-6 sm:px-6 lg:px-8" data-testid="search-source-page">
      <header className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start">
        <SearchSourceTile label={source.displayName} size="header" />
        <div className="min-w-0 flex-1">
          <h2 className="break-words text-xl font-semibold leading-tight text-ink [overflow-wrap:anywhere]">
            {source.displayName}
          </h2>
          <p className="mt-0.5 text-[13px] text-ink-muted" data-testid="search-source-page-status">
            {searchHeaderStatus(source)}
          </p>
        </div>
        {source.configurable ? (
          <UiV2Button disabled={archived} icon="settings" onClick={onOpenConfigure} tone="ghost" type="button">
            Configure
          </UiV2Button>
        ) : null}
      </header>

      <section aria-labelledby="search-source-check-heading" className="grid gap-2.5">
        <h3 className={sectionHeadingClass} id="search-source-check-heading">Check</h3>
        <div className={cardClass}>
          <div className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
            <div className="min-w-0">
              <p className="text-sm font-medium text-ink" data-check-tone={check.tone} data-testid="search-source-check" role="status">
                {source.configurable ? check.detail : "Managed with its provider connection"}
              </p>
              <p className="mt-0.5 text-xs leading-5 text-ink-muted">
                {source.configurable
                  ? "Sends one small request to the source and keeps only whether it answered and how many sources it found. The result does not turn the source on or off."
                  : "This built-in source has no settings of its own; its provider page owns the key and the models."}
              </p>
            </div>
            {source.configurable ? (
              <div className="flex flex-col items-start gap-1 md:items-end">
                <UiV2Button
                  busy={busy}
                  disabled={archived}
                  icon="regenerate"
                  onClick={() => void controller.actions.runCheck(source.id)}
                  tone="ghost"
                  type="button"
                >
                  Run check
                </UiV2Button>
                <span className="text-xs text-ink-muted">Paid request</span>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section aria-labelledby="search-source-details-heading" className="grid gap-2.5">
        <h3 className={sectionHeadingClass} id="search-source-details-heading">Details</h3>
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
          <dt className={termClass}>Chat models</dt>
          <dd className={detailClass}>
            {searchModelsReach(source)}
            {reachDetail ? <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{reachDetail}</span> : null}
          </dd>
          <dt className={termClass}>Search model</dt>
          <dd className={detailClass}>{searchModelLabel(source)}</dd>
          <dt className={termClass}>Time limit</dt>
          <dd className={detailClass}>
            {source.configuration ? durationLabel(source.configuration.timeoutMs) : "Set by the provider"}
          </dd>
          <dt className={termClass}>Purpose</dt>
          <dd className={detailClass}>{source.description}</dd>
        </dl>
      </section>
    </div>
  );
}
