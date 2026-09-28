"use client";

import { AdminAssistantRequestSheet } from "@/components/admin/assistants/AdminAssistantRequestSheet";
import {
  AdminAssistantsRequestError,
  loadAdminAssistants,
  setAdminAssistantFeatured,
  unlistAdminAssistant
} from "@/components/admin/assistants/adminAssistantsApi";
import {
  adminAssistantsErrorMessage,
  ASSISTANTS_FILTER_REQUESTS,
  chatCountLabel,
  formatAssistantDate,
  isAbortError
} from "@/components/admin/assistants/adminAssistantsPresentation";
import { AdminAssistantTile, FeaturedToggle, RequestStatusChip } from "@/components/admin/assistants/adminAssistantsPrimitives";
import { adminSectionPath } from "@/components/admin/adminSections";
import type { AdminConfirmationController } from "@/components/admin/useAdminConfirmationController";
import type { AdminFeedbackController } from "@/components/admin/useAdminFeedback";
import { FilterPill, UsersRowMenu } from "@/components/admin/users/usersPrimitives";
import { UiV2Button, type UiV2MenuAction } from "@/components/ui-v2";
import type {
  AdminAssistantFeaturedResponse,
  AdminAssistantListingRequestSummary,
  AdminAssistantListResponse,
  AdminAssistantListState,
  AdminListedAssistant
} from "@/lib/contracts/adminAssistants";
import { ASSISTANT_FEATURED_LIMIT } from "@/lib/contracts/assistantListing";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";

export type AdminAssistantsSectionProps = Readonly<{
  feedback: Pick<AdminFeedbackController, "reportError" | "reportNotice">;
  /** `requests` selects the requests view; anything else is the listed view. */
  filter: string | null;
  onPendingCount(count: number): void;
  onSelectFilter(filter: string | null): void;
  /** Opens (or closes, with null) the review sheet of one listing request. */
  onSelectResource(requestId: string | null): void;
  /** Requests an administrator can decide now, as last observed by the panel or this section. */
  pendingCount: number;
  requestConfirmation: AdminConfirmationController["requestConfirmation"];
  /** The listing request under review (`?resource=<requestId>`). */
  resource: string | null;
}>;

type Page<S extends AdminAssistantListState> = Extract<AdminAssistantListResponse, { state: S }>;

/** One set of tracks for each list's header and rows; both stack below `xl`. */
const listedTracks = "xl:grid-cols-[2.5rem_minmax(12rem,1fr)_8rem_8rem_9.5rem_4rem_2.75rem]";
const requestTracks = "xl:grid-cols-[2.5rem_minmax(12rem,1fr)_10rem_7rem_6rem]";
const rowBase = "grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 px-4 py-3 sm:px-5 xl:min-h-14 xl:gap-x-4 xl:py-2";
const headerBase = "hidden items-center gap-x-4 border-b border-trace-subtle px-5 py-2 text-metadata font-semibold uppercase tracking-[0.06em] text-ink-muted xl:grid";
const listFrame = "overflow-hidden rounded-[12px] border border-trace-subtle bg-answer-paper";

function currentHref(): string {
  return typeof window === "undefined" ? "/admin" : window.location.href;
}

/**
 * The Studio detail sheet of a listed Assistant: what every person who can
 * use it sees, so no private definition is reachable from here.
 */
function studioAssistantHref(assistantId: string): string {
  return `/?library=assistants&assistant=${encodeURIComponent(assistantId)}`;
}

function primaryClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** Featured first in their order, then the most recently listed, as the server pages them. */
function sortListed(items: readonly AdminListedAssistant[]): AdminListedAssistant[] {
  return [...items].sort((left, right) => {
    if (left.featuredOrder !== null || right.featuredOrder !== null) {
      if (left.featuredOrder === null) return 1;
      if (right.featuredOrder === null) return -1;
      if (left.featuredOrder !== right.featuredOrder) return left.featuredOrder - right.featuredOrder;
    }
    return Date.parse(right.listedAt) - Date.parse(left.listedAt) || left.assistantId.localeCompare(right.assistantId);
  });
}

function merge<S extends AdminAssistantListState>(previousPage: Page<S> | null, nextPage: Page<S>, appended: boolean): Page<S> {
  const previous: AdminAssistantListResponse | null = previousPage, next: AdminAssistantListResponse = nextPage;
  if (!appended || !previous) return nextPage;
  if (next.state === "listed" && previous.state === "listed") {
    const known = new Set(previous.assistants.map((item) => item.assistantId));
    return { ...next, assistants: [...previous.assistants, ...next.assistants.filter((item) => !known.has(item.assistantId))] } as Page<S>;
  }
  if (next.state === "requests" && previous.state === "requests") {
    const known = new Set(previous.requests.map((item) => item.id));
    return { ...next, requests: [...previous.requests, ...next.requests.filter((item) => !known.has(item.id))] } as Page<S>;
  }
  return nextPage;
}

/**
 * One view's pages with cursor paging. A refresh keeps the rows on screen
 * until the new first page arrives; responses from a superseded request are
 * ignored.
 */
function useAssistantsPage<S extends AdminAssistantListState>(state: S, onPendingCount: (count: number) => void) {
  const [page, setPage] = useState<Page<S> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pending = useRef<AbortController | null>(null);
  const failedCursor = useRef<string | undefined>(undefined);
  const reportCount = useRef(onPendingCount);
  useEffect(() => { reportCount.current = onPendingCount; }, [onPendingCount]);

  const load = useCallback((cursor?: string) => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    failedCursor.current = cursor;
    loadAdminAssistants(state, cursor, controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setPage((previous) => merge(previous, result as Page<S>, Boolean(cursor)));
        reportCount.current(result.pendingCount);
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted && !isAbortError(failure)) setError(adminAssistantsErrorMessage(failure));
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
  }, [state]);

  useEffect(() => {
    load();
    return () => pending.current?.abort();
  }, [load]);

  /** Every later load shows its busy state; the first one starts busy. */
  const reload = useCallback((cursor?: string) => {
    setLoading(true);
    setError(null);
    load(cursor);
  }, [load]);

  return {
    error,
    loadMore: reload,
    loading,
    page,
    refresh: useCallback(() => reload(), [reload]),
    retry: useCallback(() => reload(failedCursor.current), [reload]),
    setPage
  };
}

function ListStatus({ error, loading, loaded, loadingLabel, onRetry, subject }: Readonly<{
  error: string | null;
  loaded: boolean;
  loading: boolean;
  loadingLabel: string;
  onRetry(): void;
  subject: string;
}>) {
  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-[12px] border border-critical/25 bg-critical/5 px-5 py-3" role="alert">
        <p className="min-w-0 flex-1 text-sm text-ink">{subject} could not be loaded. {error}</p>
        <UiV2Button disabled={loading} onClick={onRetry} type="button">Try again</UiV2Button>
      </div>
    );
  }
  if (loading && !loaded) return <p className="px-1 py-10 text-center text-sm text-ink-muted" role="status">{loadingLabel}</p>;
  return null;
}

function EmptyState({ body, title }: Readonly<{ body: string; title: string }>) {
  return (
    <div className="rounded-[12px] border border-trace-subtle bg-answer-paper px-5 py-10 text-center" role="status">
      <p className="text-sm font-semibold text-ink-secondary">{title}</p>
      <p className="mx-auto mt-1 max-w-xl text-sm leading-6 text-ink-muted">{body}</p>
    </div>
  );
}

function ListedRow({ busy, featuredCount, item, onFeatured, onUnlist }: Readonly<{
  busy: boolean;
  featuredCount: number;
  item: AdminListedAssistant;
  onFeatured(item: AdminListedAssistant, order: number | null): void;
  onUnlist(item: AdminListedAssistant): void;
}>) {
  const order = item.featuredOrder;
  const updated = formatAssistantDate(item.updatedAt);
  const actions: UiV2MenuAction[] = [
    ...(order !== null ? [
      { disabled: busy || order === 0, label: "Move up", onSelect: () => onFeatured(item, order - 1) },
      { disabled: busy || order >= featuredCount - 1, label: "Move down", onSelect: () => onFeatured(item, order + 1) }
    ] : []),
    { disabled: busy, icon: "trash", label: "Unlist…", onSelect: () => onUnlist(item), separatorBefore: order !== null, tone: "destructive" }
  ];
  return (
    <li
      aria-busy={busy || undefined}
      className={`${rowBase} ${listedTracks}`}
      data-assistant-id={item.assistantId}
      data-featured-order={order ?? undefined}
      data-testid={`admin-assistant-row-${item.assistantId}`}
    >
      <AdminAssistantTile avatar={item.avatar} name={item.name} size={40} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink" title={item.name}>{item.name}</p>
        <p className="truncate text-xs text-ink-muted">By {item.ownerDisplayName}</p>
        <p className="mt-0.5 text-xs text-ink-muted xl:hidden">Updated {updated} · {chatCountLabel(item.chatCount30Days)}</p>
      </div>
      <span className="hidden text-xs text-ink-secondary xl:block"><span className="sr-only">Updated </span>{updated}</span>
      <span className="hidden text-xs text-ink-secondary xl:block">
        {item.chatCount30Days.toLocaleString()}<span className="sr-only"> {item.chatCount30Days === 1 ? "chat" : "chats"} in the last 30 days</span>
      </span>
      <div className="col-start-2 row-start-2 flex min-w-0 items-center gap-2 xl:col-start-auto xl:row-start-auto">
        <FeaturedToggle
          busy={busy}
          featured={order !== null}
          name={item.name}
          onChange={(next) => onFeatured(item, next ? Math.min(featuredCount, ASSISTANT_FEATURED_LIMIT - 1) : null)}
        />
        {order !== null ? (
          <span className="text-xs text-ink-muted" data-testid="admin-assistant-featured-position">
            <span aria-hidden="true">#{order + 1}</span><span className="sr-only">Featured position {order + 1}</span>
          </span>
        ) : null}
      </div>
      {/* Below `xl` it shares the Featured line and ends under the menu, so the name keeps its width. */}
      <a
        aria-label={`Open ${item.name}`}
        className="v2-button v2-focusable col-start-2 col-end-4 row-start-2 justify-self-end xl:col-start-auto xl:col-end-auto xl:row-start-auto"
        data-testid="admin-assistant-open"
        data-tone="ghost"
        href={studioAssistantHref(item.assistantId)}
      >
        <span>Open</span>
      </a>
      <div className="col-start-3 row-start-1 justify-self-end xl:col-start-auto xl:row-start-auto" data-focus-target="menu">
        <UsersRowMenu actions={actions} label={`More actions for ${item.name}`} />
      </div>
    </li>
  );
}

function ListedView({ feedback, onPendingCount, requestConfirmation, refreshSignal, onFocusFallback }: Readonly<{
  feedback: AdminAssistantsSectionProps["feedback"];
  onFocusFallback(): void;
  onPendingCount(count: number): void;
  refreshSignal: number;
  requestConfirmation: AdminAssistantsSectionProps["requestConfirmation"];
}>) {
  const { error, loadMore, loading, page, refresh, retry, setPage } = useAssistantsPage("listed", onPendingCount);
  const [busyId, setBusyId] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) refresh();
  }, [refresh, refreshSignal]);

  const items = page?.assistants ?? [];
  const featuredCount = items.filter((item) => item.featuredOrder !== null).length;

  /** Rows move when the order changes; put focus back on the same control of the same row. */
  const restoreFocus = (assistantId: string, target: string | undefined) => {
    requestAnimationFrame(() => {
      const row = listRef.current?.querySelector<HTMLElement>(`[data-assistant-id="${CSS.escape(assistantId)}"]`);
      if (!row || row.contains(document.activeElement)) return;
      const control = target === "featured"
        ? row.querySelector<HTMLElement>('[data-focus-target="featured"] [aria-checked="true"]')
        : row.querySelector<HTMLElement>('[data-focus-target="menu"] button');
      control?.focus();
    });
  };

  const applyFeatured = (featured: AdminAssistantFeaturedResponse["featured"]) => {
    const orders = new Map(featured.map((entry) => [entry.assistantId, entry.featuredOrder]));
    setPage((current) => current && { ...current, assistants: sortListed(current.assistants.map((item) =>
      ({ ...item, featuredOrder: orders.get(item.assistantId) ?? null }))) });
  };

  async function placeFeatured(item: AdminListedAssistant, order: number | null) {
    if (busyId) return;
    const focused = document.activeElement;
    const target = focused instanceof HTMLElement ? focused.closest<HTMLElement>("[data-focus-target]")?.dataset.focusTarget : undefined;
    setBusyId(item.assistantId);
    try {
      const featured = await setAdminAssistantFeatured(item.assistantId, order);
      applyFeatured(featured);
      const position = featured.findIndex((entry) => entry.assistantId === item.assistantId);
      feedback.reportNotice(position >= 0 ? `${item.name} is Featured at #${position + 1}.` : `${item.name} is no longer Featured.`);
    } catch (failure) {
      feedback.reportError(adminAssistantsErrorMessage(failure));
      if (failure instanceof AdminAssistantsRequestError && failure.code === "assistant_not_available") refresh();
    } finally {
      setBusyId(null);
      restoreFocus(item.assistantId, target);
    }
  }

  function unlist(item: AdminListedAssistant) {
    requestConfirmation({
      body: `${item.name} will be removed from everyone's Assistants list${item.featuredOrder !== null ? " and from Featured" : ""}. ` +
        "People who can use it only because it is listed lose access to it. The owner keeps the Assistant and can ask to list it again.",
      confirmLabel: "Unlist",
      dialogLabel: `Unlist ${item.name}`,
      icon: "x",
      onConfirm: async () => {
        setBusyId(item.assistantId);
        try {
          await unlistAdminAssistant(item.assistantId);
          setPage((current) => current && { ...current, assistants: current.assistants.filter((entry) => entry.assistantId !== item.assistantId) });
          feedback.reportNotice(`${item.name} is no longer listed for everyone.`);
          refresh();
          requestAnimationFrame(onFocusFallback);
        } catch (failure) {
          feedback.reportError(adminAssistantsErrorMessage(failure));
          if (failure instanceof AdminAssistantsRequestError && failure.code === "assistant_not_available") refresh();
        } finally {
          setBusyId(null);
        }
      },
      testId: "admin-confirm-unlist-assistant",
      title: `Unlist ${item.name}?`,
      tone: "destructive"
    });
  }

  return (
    <>
      <p className="text-sm text-ink-muted">
        Featured Assistants come first for everyone, in this order. Up to {ASSISTANT_FEATURED_LIMIT} can be Featured.
      </p>
      <ListStatus error={error} loaded={page !== null} loading={loading} loadingLabel="Loading Assistants…" onRetry={retry} subject="Assistants" />
      {page && items.length === 0 && !error ? (
        <EmptyState
          body="Assistants appear here when you approve a request to list one, or when an administrator lists their own Assistant from Studio."
          title="No Assistants are listed for everyone yet"
        />
      ) : null}
      {items.length ? (
        <div className={listFrame}>
          <div aria-hidden="true" className={`${headerBase} ${listedTracks}`}>
            <span />
            <span>Assistant</span>
            <span>Updated</span>
            <span className="whitespace-nowrap">Chats · 30 days</span>
            <span>Featured</span>
            <span />
            <span />
          </div>
          <ul aria-label="Assistants listed for everyone" className="divide-y divide-trace-subtle" data-testid="admin-assistants-listed" ref={listRef}>
            {items.map((item) => (
              <ListedRow
                busy={busyId === item.assistantId}
                featuredCount={featuredCount}
                item={item}
                key={item.assistantId}
                onFeatured={(target, order) => void placeFeatured(target, order)}
                onUnlist={unlist}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {page?.nextCursor ? (
        <div><UiV2Button busy={loading} onClick={() => loadMore(page.nextCursor!)} type="button">Load more</UiV2Button></div>
      ) : null}
    </>
  );
}

function RequestRow({ onOpen, request }: Readonly<{ onOpen(id: string): void; request: AdminAssistantListingRequestSummary }>) {
  const requested = formatAssistantDate(request.createdAt);
  const status = request.outdated ? "outdated" : "pending";
  return (
    <li className={`${rowBase} ${requestTracks}`} data-request-status={status} data-testid={`admin-assistant-request-${request.id}`}>
      <AdminAssistantTile avatar={request.avatar} name={request.name} size={40} />
      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-ink" title={request.name}>{request.name}</p>
        <p className="truncate text-xs text-ink-muted">By {request.ownerDisplayName}</p>
        <p className="mt-0.5 text-xs text-ink-muted xl:hidden">Requested {requested}</p>
      </div>
      <span className="hidden text-xs text-ink-secondary xl:block">Requested {requested}</span>
      <span className="col-start-2 row-start-2 xl:col-start-auto xl:row-start-auto"><RequestStatusChip status={status} /></span>
      <a
        aria-label={`Review ${request.name}`}
        className="v2-button v2-focusable col-start-3 row-start-1 justify-self-end xl:col-start-auto xl:row-start-auto"
        data-tone="ghost"
        href={adminSectionPath(currentHref(), "assistants", request.id, ASSISTANTS_FILTER_REQUESTS)}
        onClick={(event) => {
          if (!primaryClick(event)) return;
          event.preventDefault();
          onOpen(request.id);
        }}
      >
        <span>Review</span>
      </a>
    </li>
  );
}

function RequestsView({ onOpen, onPendingCount, refreshSignal }: Readonly<{
  onOpen(id: string): void;
  onPendingCount(count: number): void;
  refreshSignal: number;
}>) {
  const { error, loadMore, loading, page, refresh, retry } = useAssistantsPage("requests", onPendingCount);
  const firstSignal = useRef(refreshSignal);
  useEffect(() => {
    if (refreshSignal !== firstSignal.current) refresh();
  }, [refresh, refreshSignal]);
  const requests = page?.requests ?? [];
  return (
    <>
      <p className="text-sm text-ink-muted">
        {page ? `${page.pendingCount.toLocaleString()} awaiting review · ` : ""}Approving lists the Assistant for everyone. Outdated requests wait for their owner to send a new one.
      </p>
      <ListStatus error={error} loaded={page !== null} loading={loading} loadingLabel="Loading requests…" onRetry={retry} subject="Requests" />
      {page && requests.length === 0 && !error ? (
        <EmptyState
          body="Owners ask to list an Assistant for everyone from its Sharing panel in Studio. New requests appear here."
          title="No requests waiting for review"
        />
      ) : null}
      {requests.length ? (
        <div className={listFrame}>
          <div aria-hidden="true" className={`${headerBase} ${requestTracks}`}>
            <span />
            <span>Assistant</span>
            <span>Requested</span>
            <span>Status</span>
            <span />
          </div>
          <ul aria-label="Requests to list an Assistant for everyone" className="divide-y divide-trace-subtle" data-testid="admin-assistant-requests">
            {requests.map((request) => <RequestRow key={request.id} onOpen={onOpen} request={request} />)}
          </ul>
        </div>
      ) : null}
      {page?.nextCursor ? (
        <div><UiV2Button busy={loading} onClick={() => loadMore(page.nextCursor!)} type="button">Load more</UiV2Button></div>
      ) : null}
    </>
  );
}

/**
 * Control Center > Assistants (PRD 9.4): the Assistants listed for everyone
 * with Featured order and 30-day chat counts, and the requests to list one.
 * The filter and the request under review live in the URL.
 */
export function AdminAssistantsSection({
  feedback,
  filter,
  onPendingCount,
  onSelectFilter,
  onSelectResource,
  pendingCount,
  requestConfirmation,
  resource
}: AdminAssistantsSectionProps) {
  const view: AdminAssistantListState = filter === ASSISTANTS_FILTER_REQUESTS ? "requests" : "listed";
  const [refreshSignal, setRefreshSignal] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const refresh = useCallback(() => setRefreshSignal((value) => value + 1), []);
  const focusFallback = useCallback(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) headingRef.current?.focus();
  }, []);

  return (
    <div className="flex max-w-[1120px] min-w-0 flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8" data-testid="admin-assistants-section">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink outline-none" ref={headingRef} tabIndex={-1}>Assistants</h2>
          <p className="mt-1 text-sm text-ink-muted">
            Assistants listed for everyone and requests to list them. Private Assistants stay private to their owners.
          </p>
        </div>
        <UiV2Button icon="regenerate" onClick={refresh} type="button">Refresh</UiV2Button>
      </div>
      <div aria-label="Show" className="flex flex-wrap items-center gap-2" role="group">
        <FilterPill label="Listed for everyone" onSelect={() => onSelectFilter(null)} selected={view === "listed"} />
        <FilterPill
          count={pendingCount}
          label="Requests"
          onSelect={() => onSelectFilter(ASSISTANTS_FILTER_REQUESTS)}
          selected={view === "requests"}
          tone="caution"
        />
      </div>
      {view === "listed" ? (
        <ListedView
          feedback={feedback}
          key="listed"
          onFocusFallback={focusFallback}
          onPendingCount={onPendingCount}
          refreshSignal={refreshSignal}
          requestConfirmation={requestConfirmation}
        />
      ) : (
        <RequestsView key="requests" onOpen={onSelectResource} onPendingCount={onPendingCount} refreshSignal={refreshSignal} />
      )}
      {resource ? (
        <AdminAssistantRequestSheet
          key={resource}
          onChanged={refresh}
          onClose={() => {
            onSelectResource(null);
            requestAnimationFrame(focusFallback);
          }}
          requestId={resource}
        />
      ) : null}
    </div>
  );
}
