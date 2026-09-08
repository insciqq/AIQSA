"use client";

import { adminSectionPath } from "@/components/admin/adminSections";
import { AdminTopbarMenu, useAdminSectionTopbar, type AdminShellTopbar } from "@/components/admin/AdminShell";
import { sectionHeadingClass } from "@/components/admin/roles/rolesControls";
import { AdminSearchList } from "@/components/admin/search/AdminSearchList";
import { AdminSearchPlanCard } from "@/components/admin/search/AdminSearchPlanCard";
import { AdminSearchSourcePage } from "@/components/admin/search/AdminSearchSourcePage";
import { AdminSearchSourceSheet } from "@/components/admin/search/AdminSearchSourceSheet";
import { useAdminSearchController } from "@/components/admin/search/useAdminSearchController";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { UiV2Button, UiV2Icon, UiV2Switch } from "@/components/ui-v2";
import type { AdminSearchIntegration } from "@/lib/contracts/adminSearch";
import { useCallback, useMemo, useState, type MouseEvent } from "react";

const crumbLink =
  "rounded-[6px] font-medium text-ink-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-focus";

export type AdminSearchSectionProps = Readonly<{
  active: boolean;
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  onMutationCommitted?(): void | Promise<unknown>;
  onSelectResource(resource: string | null): void;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  /** Open source page from `?resource=`, or null for the list. */
  resource: string | null;
}>;

function Crumbs({ current, onBack }: Readonly<{ current: string; onBack(): void }>) {
  const href = adminSectionPath(typeof window === "undefined" ? "/admin" : window.location.href, "search");
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <a
        className={crumbLink}
        href={href}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onBack();
        }}
      >
        Search
      </a>
      <UiV2Icon className="size-3.5 shrink-0 text-ink-muted" name="chevron-right" />
      <span className="truncate">{current}</span>
    </span>
  );
}

/**
 * Search section (PRD 5.6): the recommended plan and the source list on one
 * page, one source page per `?resource=`, and the Add source / Configure
 * sheets. The section owns the topbar and the one controller.
 */
export function AdminSearchSection({
  active,
  feedback,
  onMutationCommitted,
  onSelectResource,
  requestConfirmation,
  resource
}: AdminSearchSectionProps) {
  const [addingRequested, setAdding] = useState(false);
  // Keyed by the open page so a page change never carries a sheet along.
  const [configureOpenFor, setConfigureOpenFor] = useState<string | null>(null);
  const adding = addingRequested && resource === null;
  const configureOpen = resource !== null && configureOpenFor === resource;
  const controller = useAdminSearchController(active, {
    onError: feedback.reportError,
    onMutationCommitted,
    onNotice: feedback.reportNotice
  });
  const { busy, catalog, error, loaded, loading } = controller.state;
  const source = useMemo(
    () => (resource && catalog ? catalog.integrations.find(({ id }) => id === resource) ?? null : null),
    [catalog, resource]
  );

  const backToList = useCallback(() => {
    setAdding(false);
    onSelectResource(null);
  }, [onSelectResource]);

  const requestArchive = useCallback((target: AdminSearchIntegration) => {
    const name = target.displayName;
    requestConfirmation({
      body: `“${name}” is turned off and hidden from new chats. Chats already running finish, and history keeps its sources. Nothing is deleted; adding a source on the same model brings it back.`,
      confirmLabel: "Archive source",
      dialogLabel: `Archive ${name}`,
      icon: "trash",
      onConfirm: async () => {
        const archived = await controller.actions.archive(target.id);
        if (archived) onSelectResource(null);
      },
      testId: "admin-confirm-archive-search-source",
      title: `Archive “${name}”?`,
      tone: "destructive"
    });
  }, [controller.actions, onSelectResource, requestConfirmation]);

  const topbar = useMemo<AdminShellTopbar>(() => {
    if (resource && source) {
      const archived = source.archivedAt !== null;
      return {
        actions: (
          <>
            <label className="flex items-center gap-2 text-[13px] text-ink-secondary">
              Enabled
              <UiV2Switch
                checked={source.enabled}
                data-testid="search-source-enabled"
                disabled={busy || archived}
                label={`${source.displayName} enabled`}
                onChange={(next) => void controller.actions.setEnabled(source.id, next)}
              />
            </label>
            {source.system || archived ? null : (
              <AdminTopbarMenu
                actions={[
                  {
                    disabled: busy,
                    icon: "archive",
                    label: "Archive",
                    onSelect: () => requestArchive(source),
                    tone: "destructive"
                  }
                ]}
                label={`More actions for ${source.displayName}`}
              />
            )}
          </>
        ),
        title: <Crumbs current={source.displayName} onBack={backToList} />
      };
    }
    if (resource) {
      return { title: <Crumbs current="Source" onBack={backToList} /> };
    }
    return {
      actions: (
        <UiV2Button
          data-testid="search-add"
          disabled={!loaded || !catalog}
          icon="plus"
          onClick={() => setAdding(true)}
          tone="primary"
          type="button"
        >
          Add source
        </UiV2Button>
      ),
      title: "Search"
    };
  }, [backToList, busy, catalog, controller.actions, loaded, requestArchive, resource, source]);
  useAdminSectionTopbar(topbar);

  if (resource) {
    if (!source) {
      return (
        <div className="px-4 py-12 text-center sm:px-6" data-testid="admin-search-section" role={loaded ? "alert" : "status"}>
          {loaded ? (
            <>
              <p className="text-sm font-semibold text-ink-secondary">{error ?? "This Search source no longer exists."}</p>
              {error ? <UiV2Button className="mt-4" disabled={loading} onClick={() => void controller.actions.refresh()} tone="ghost" type="button">Try again</UiV2Button>
                : <UiV2Button className="mt-4" onClick={backToList} tone="ghost" type="button">Back to Search</UiV2Button>}
            </>
          ) : (
            <p className="text-sm text-ink-muted">Loading Search source…</p>
          )}
        </div>
      );
    }
    return (
      <div className="min-w-0" data-testid="admin-search-section">
        <AdminSearchSourcePage
          controller={controller}
          onOpenConfigure={() => setConfigureOpenFor(source.id)}
          source={source}
        />
        {catalog ? (
          <AdminSearchSourceSheet
            catalog={catalog}
            controller={controller}
            key={source.id}
            mode={{ kind: "configure", source }}
            onClose={() => setConfigureOpenFor(null)}
            onSaved={() => setConfigureOpenFor(null)}
            open={configureOpen}
          />
        ) : null}
      </div>
    );
  }

  return (
    <div className="min-w-0" data-testid="admin-search-section">
      <div className="flex max-w-[1120px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        {catalog ? (
          <AdminSearchPlanCard
            busy={busy}
            catalog={catalog}
            key={catalog.policy.version}
            onSave={(plan) => controller.actions.savePolicy(plan, catalog.policy.version)}
          />
        ) : null}
        <section aria-labelledby="admin-search-sources-heading" className="grid gap-2.5">
          <h2 className={sectionHeadingClass} id="admin-search-sources-heading">Sources</h2>
          <AdminSearchList
            error={controller.state.error}
            loaded={loaded}
            loading={controller.state.loading}
            onOpen={(sourceId) => onSelectResource(sourceId)}
            onRetry={() => void controller.actions.refresh()}
            sources={catalog?.integrations ?? []}
          />
          <p className="text-xs leading-5 text-ink-muted">
            People choose sources in chat; who may use which source is set per group in Groups. Sources for built-in providers appear when the provider is added.
          </p>
        </section>
      </div>
      {catalog ? (
        <AdminSearchSourceSheet
          catalog={catalog}
          controller={controller}
          mode={{ kind: "create" }}
          onClose={() => setAdding(false)}
          onSaved={(sourceId) => {
            setAdding(false);
            if (sourceId) onSelectResource(sourceId);
          }}
          open={adding}
        />
      ) : null}
    </div>
  );
}
