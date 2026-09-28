"use client";

import {
  ASSISTANT_GALLERY_FILTERS,
  filterAssistantGallery,
  type AssistantGalleryFilter,
  type AssistantGalleryGroup,
  type AssistantGalleryQuery,
  type AssistantGalleryView,
  type LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { SectionHeading } from "@/features/library-v2/LibraryV2";
import {
  ASSISTANT_CATEGORIES,
  ASSISTANT_CATEGORY_LABELS,
  type AssistantCategory
} from "@/lib/contracts/assistants";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type Ref } from "react";
import { AssistantCardV2 } from "./AssistantCardV2";
import "../assistants.css";

/** PRD 5.2: one sentence that tells an Assistant apart from Instructions and Skills. */
export const ASSISTANTS_DESCRIPTION =
  "An Assistant is a saved chat setup: its own instructions, model, tools and knowledge. Pick one for a chat; your Chat defaults fill whatever it leaves open.";

const filterLabels: Readonly<Record<AssistantGalleryFilter, string>> = {
  all: "All",
  archived: "Archived",
  featured: "Featured",
  pinned: "Pinned",
  shared: "Shared",
  yours: "Yours"
};

const groupHeadings: Readonly<Record<AssistantGalleryGroup["kind"], { note: string | null; title: string }>> = {
  featured: { note: "Chosen by an administrator", title: "Featured" },
  pinned: { note: "Open from any new chat", title: "Pinned" },
  rest: { note: null, title: "Recently updated" }
};

export function AssistantGalleryNoticeV2({
  live = true,
  notice,
  noticeRef,
  onDismiss
}: Readonly<{
  /** False when the owner announces the text itself, in a region that stays mounted. */
  live?: boolean;
  notice: LibraryNotice;
  noticeRef?: Ref<HTMLDivElement>;
  onDismiss(): void;
}>) {
  return (
    <div
      className="v2-assistants-notice v2-focusable"
      data-testid="assistant-gallery-notice"
      data-tone={notice.kind}
      ref={noticeRef}
      role={live ? notice.kind === "error" ? "alert" : "status" : undefined}
      tabIndex={-1}
    >
      <span>{notice.text}</span>
      <UiV2IconButton icon="close" label="Dismiss" onClick={onDismiss} />
    </div>
  );
}

function focusIsLost(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || !active.isConnected;
}

/** A sheet or dialog above the gallery makes the rest of the page inert while it is open. */
function underModalLayer(element: HTMLElement): boolean {
  for (let current: HTMLElement | null = element; current; current = current.parentElement) {
    if (current.inert || current.hasAttribute("inert")) return true;
  }
  return false;
}

/**
 * A notice about a card that moved or went away takes the focus that left
 * with it. Once any sheet or dialog above the gallery has closed and
 * returned focus, the notice is focused if focus ended on the page or on
 * an element that is gone; otherwise focus stays where it is and the
 * gallery's live region reads the notice. The next list change, the
 * refresh that follows the action, hands focus to the notice too if it
 * takes the focused card away.
 */
function useNoticeFocus(notice: LibraryNotice | null, listed: unknown) {
  const noticeRef = useRef<HTMLDivElement>(null);
  const waiting = useRef<LibraryNotice | null>(null);
  const settled = useRef<LibraryNotice | null>(null);
  const [announced, setAnnounced] = useState<LibraryNotice | null>(null);

  // The notice sticks to the top of the scroll container, so it is in view already.
  const takeFocus = useCallback((element: HTMLElement) => {
    waiting.current = null;
    element.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const element = noticeRef.current;
    waiting.current = notice;
    if (!notice || !element) return;
    let timer: number | undefined;
    let observer: MutationObserver | undefined;
    const settle = () => {
      if (underModalLayer(element)) return;
      observer?.disconnect();
      window.clearTimeout(timer);
      // A macrotask later the closed layer has run its own focus return.
      timer = window.setTimeout(() => {
        if (waiting.current !== notice) return;
        settled.current = notice;
        if (focusIsLost()) takeFocus(element);
        else setAnnounced(notice);
      }, 0);
    };
    if (underModalLayer(element)) {
      observer = new MutationObserver(settle);
      observer.observe(document.body, { attributeFilter: ["inert"], attributes: true, subtree: true });
    } else {
      settle();
    }
    return () => {
      observer?.disconnect();
      window.clearTimeout(timer);
    };
  }, [notice, takeFocus]);

  useEffect(() => {
    const element = noticeRef.current;
    if (!waiting.current || !element) return;
    const timer = window.setTimeout(() => {
      if (!waiting.current || underModalLayer(element)) return;
      if (focusIsLost()) takeFocus(element);
      else if (settled.current === waiting.current) waiting.current = null;
    }, 0);
    return () => window.clearTimeout(timer);
  }, [listed, takeFocus]);

  return { announcedText: notice && announced === notice ? notice.text : "", noticeRef };
}

/**
 * Studio › Assistants (PRD 10.1): filter chips whose counts equal what each
 * lists, a category, a search over name, description and author, and the
 * Featured, Pinned and recently updated groups under All.
 */
export function AssistantGalleryV2({
  busy,
  catalogError,
  catalogState,
  gallery,
  initialQuery,
  notice,
  onDismissNotice,
  onFromCurrentChat,
  onNewAssistant,
  onRetry
}: Readonly<{
  busy: boolean;
  catalogError: string | null;
  catalogState: "error" | "loading" | "ready";
  /** Null until Studio has loaded the Assistants section. */
  gallery: AssistantGalleryView | null;
  /** The chip, category and search the gallery starts with; All, Any and none by default. */
  initialQuery?: Partial<AssistantGalleryQuery>;
  /** Shown here unless the detail sheet shows it. */
  notice: LibraryNotice | null;
  onDismissNotice(): void;
  onFromCurrentChat(): void;
  onNewAssistant(): void;
  onRetry(): void;
}>) {
  const [filter, setFilter] = useState<AssistantGalleryFilter>(initialQuery?.filter ?? "all");
  const [category, setCategory] = useState<AssistantCategory | null>(initialQuery?.category ?? null);
  const [search, setSearch] = useState(initialQuery?.search ?? "");
  const [copyStatus, setCopyStatus] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const headingIdPrefix = useId();
  const listed = gallery?.assistants;
  const assistants = useMemo(() => listed ?? [], [listed]);
  const result = useMemo(
    () => filterAssistantGallery(assistants, { category, filter, search }),
    [assistants, category, filter, search]
  );
  const { announcedText, noticeRef } = useNoticeFocus(notice, listed);
  const onCopied = (copied: boolean) => setCopyStatus(copied ? "Assistant link copied." : "Could not copy the Assistant link.");
  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(""), 4000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);
  const grouped = filter === "all" && !search.trim() &&
    (result.groups.length > 1 || result.groups.some((group) => group.kind !== "rest"));
  const loading = !gallery || catalogState === "loading";

  let content;
  if (loading && assistants.length === 0) {
    content = (
      <div aria-label="Loading Assistants" className="v2-assistants-skeletons" role="status">
        {Array.from({ length: 6 }, (_, index) => (
          <span aria-hidden="true" className="v2-assistants-skeleton" key={index}>
            <span /><span /><span /><span />
          </span>
        ))}
        <span className="sr-only">Loading your Assistants…</span>
      </div>
    );
  } else if (catalogState === "error" && assistants.length === 0) {
    content = (
      <div className="v2-assistants-empty" data-state="error" role="alert">
        <span className="v2-assistants-empty-icon"><UiV2Icon name="alert" /></span>
        <h3>The list did not load</h3>
        <p>{catalogError ?? "Nothing was changed. Your Assistants are still there."}</p>
        <UiV2Button icon="regenerate" tone="primary" onClick={onRetry}>Reload</UiV2Button>
      </div>
    );
  } else if (assistants.length === 0) {
    content = (
      <div className="v2-assistants-empty" data-state="empty">
        <span className="v2-assistants-empty-icon"><UiV2Icon name="assistant" /></span>
        <h3>No Assistants yet</h3>
        <p>Create one from a template or from your current chat.</p>
        <div>
          <UiV2Button disabled={busy} icon="plus" tone="primary" onClick={onNewAssistant}>New assistant</UiV2Button>
          <UiV2Button disabled={busy} onClick={onFromCurrentChat}>From current chat</UiV2Button>
        </div>
      </div>
    );
  } else if (result.groups.length === 0) {
    // The way back is offered only when search or the category emptied the list, not an empty chip.
    const narrowed = search.trim() !== "" || category !== null;
    content = (
      <div className="v2-assistants-nothing">
        <p role="status">Nothing matches</p>
        {narrowed ? (
          <UiV2Button
            onClick={() => {
              setSearch("");
              setCategory(null);
              searchRef.current?.focus();
            }}
          >
            Clear search
          </UiV2Button>
        ) : null}
      </div>
    );
  } else {
    content = result.groups.map((group) => {
      const headingId = `${headingIdPrefix}-${group.kind}`;
      const heading = groupHeadings[group.kind];
      return (
        <section
          aria-labelledby={grouped ? headingId : undefined}
          aria-label={grouped ? undefined : "Assistants"}
          className="v2-assistants-group"
          data-group={group.kind}
          key={group.kind}
        >
          {grouped ? (
            <header className="v2-assistants-group-head">
              <h3 id={headingId}>{heading.title}</h3>
              {heading.note ? <span>{heading.note}</span> : null}
            </header>
          ) : null}
          <div className="v2-assistants-grid">
            {group.cards.map((card) => (
              <AssistantCardV2
                busy={busy}
                card={card}
                gallery={gallery!}
                headingLevel={grouped ? 4 : 3}
                key={card.assistant.id}
                onCopied={onCopied}
              />
            ))}
          </div>
        </section>
      );
    });
  }

  return (
    <div className="v2-assistants-gallery" data-testid="assistant-gallery">
      <SectionHeading
        action={<UiV2Button disabled={busy} icon="plus" tone="primary" onClick={onNewAssistant}>New assistant</UiV2Button>}
        description={ASSISTANTS_DESCRIPTION}
      >
        Assistants
      </SectionHeading>
      {notice ? <AssistantGalleryNoticeV2 live={false} notice={notice} noticeRef={noticeRef} onDismiss={onDismissNotice} /> : null}
      {/* Mounted before any notice, so a notice that does not take focus is read when its text arrives. */}
      <p className="sr-only" role="status">{announcedText}</p>
      {gallery && assistants.length > 0 ? (
        <div className="v2-assistants-toolbar">
          <div aria-label="Filter Assistants" className="v2-resource-filters v2-assistants-filters" role="group">
            {ASSISTANT_GALLERY_FILTERS.map((candidate) => (
              <button
                aria-pressed={filter === candidate}
                className="v2-resource-filter v2-focusable"
                data-selected={filter === candidate || undefined}
                key={candidate}
                type="button"
                onClick={() => setFilter(candidate)}
              >
                {filterLabels[candidate]}{" "}
                <span>{result.counts[candidate]}</span>
              </button>
            ))}
          </div>
          <div className="v2-assistants-toolbar-end">
            {/* The select lies transparent over the whole box, so any tap opens its list; the
                box shows the value, stacked over every other label to keep the widest one's width. */}
            <div className="v2-assistants-category">
              <span aria-hidden="true">Category:</span>
              <span aria-hidden="true" className="v2-assistants-category-value">
                <span data-current={category === null || undefined}>Any</span>
                {ASSISTANT_CATEGORIES.map((value) => (
                  <span data-current={category === value || undefined} key={value}>{ASSISTANT_CATEGORY_LABELS[value]}</span>
                ))}
              </span>
              <select
                aria-label="Category"
                value={category ?? ""}
                onChange={(event) => setCategory((event.currentTarget.value || null) as AssistantCategory | null)}
              >
                <option value="">Any</option>
                {ASSISTANT_CATEGORIES.map((value) => (
                  <option key={value} value={value}>{ASSISTANT_CATEGORY_LABELS[value]}</option>
                ))}
              </select>
              <UiV2Icon name="chevron-down" />
            </div>
            <label className="v2-resource-search v2-assistants-search">
              <UiV2Icon name="search" />
              <input
                aria-label="Search Assistants"
                placeholder="Search Assistants…"
                ref={searchRef}
                type="search"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
          </div>
        </div>
      ) : null}
      {content}
      <p className="v2-assistants-copy-status" role="status">{copyStatus}</p>
    </div>
  );
}
