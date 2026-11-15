"use client";

import { UiV2Monogram } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import type { ThreadArtifactSummary, ThreadSearchSource } from "@/lib/contracts/chats";
import { useId, useMemo, useState, type ReactNode } from "react";
import {
  answerCitedUrlsV2,
  filterSourcesV2,
  groupSourcesBySiteV2,
  presentSearchSourcesV2,
  splitCitedSourcesV2,
  type PresentedSearchSourceV2,
  type SourceSiteGroupV2
} from "./sourcePresentation";

/** Rows a list renders before its "Show more"; a run can list thousands of sources. */
export const ANSWER_SOURCES_PAGE_SIZE = 50;

function safeAnswerHref(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.startsWith("//") ||
    /[\u0000-\u001F\u007F\s]/u.test(value)
  ) {
    return null;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

function answerWebSources(artifact: ThreadArtifactSummary): readonly ThreadSearchSource[] {
  const citationSources = artifact.citations.map((citation) => ({
    rank: citation.index,
    ...(citation.snippet ? { snippet: citation.snippet } : {}),
    title: citation.title,
    url: citation.url
  }));
  return [...artifact.sources, ...citationSources];
}

function SourceTitleV2({ source }: Readonly<{ source: PresentedSearchSourceV2 }>) {
  const href = safeAnswerHref(source.url);
  return href ? (
    <a className="v2-answer-source-title v2-focusable" href={href} rel="noreferrer" target="_blank">{source.title}</a>
  ) : (
    <span className="v2-answer-source-title" data-testid="unsafe-source-title">{source.title}</span>
  );
}

/** A list that renders a page of rows at a time, so thousands of sources never mount at once. */
function PagedListV2<T>({ as: List = "ul", className, items, renderItem, testId }: Readonly<{
  as?: "ol" | "ul";
  className: string;
  items: readonly T[];
  renderItem(item: T, index: number): ReactNode;
  testId?: string;
}>) {
  const [shown, setShown] = useState(ANSWER_SOURCES_PAGE_SIZE);
  const remaining = items.length - shown;
  return (
    <>
      <List className={className} data-testid={testId}>
        {items.slice(0, shown).map(renderItem)}
      </List>
      {remaining > 0 ? (
        <button
          className="v2-answer-sources-more v2-focusable"
          onClick={() => setShown((current) => current + ANSWER_SOURCES_PAGE_SIZE)}
          type="button"
        >
          <span>Show more</span>
          {" "}<span className="v2-answer-sources-count">{`· ${remaining} left`}</span>
        </button>
      ) : null}
    </>
  );
}

function SourceSiteRowV2({ group }: Readonly<{ group: SourceSiteGroupV2 }>) {
  const [open, setOpen] = useState(false);
  const linksId = useId();
  const label = group.site || "Other links";
  return (
    <li className="v2-answer-source-site" data-testid="answer-source-site">
      <button
        aria-controls={open ? linksId : undefined}
        aria-expanded={open}
        className="v2-answer-source-site-toggle v2-focusable"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <UiV2Monogram className="v2-answer-source-monogram" label={label} />
        <span className="v2-answer-source-site-name">
          <span>{label}</span>
          {" "}<span className="v2-answer-sources-count">{`· ${group.sources.length}`}</span>
        </span>
        <span aria-hidden="true" className="v2-answer-sources-chevron" />
      </button>
      {open ? (
        <div className="v2-answer-source-site-links" id={linksId}>
          <PagedListV2
            className="v2-answer-source-links"
            items={group.sources}
            renderItem={(source, index) => (
              <li key={`${source.url}:${index}`}><SourceTitleV2 source={source} /></li>
            )}
          />
        </div>
      ) : null}
    </li>
  );
}

function AnswerSourcesSheetBodyV2({ cited, uncited }: Readonly<{
  cited: readonly PresentedSearchSourceV2[];
  uncited: readonly PresentedSearchSourceV2[];
}>) {
  // What the answer cites leads; the rest is one tap away, and opens by
  // itself only when the answer cites nothing.
  const [othersOpen, setOthersOpen] = useState(cited.length === 0);
  const [query, setQuery] = useState("");
  const citedHeadingId = useId();
  const othersId = useId();
  const groups = useMemo(() => groupSourcesBySiteV2(uncited), [uncited]);
  const filtering = query.trim().length > 0;
  const matches = useMemo(() => filtering ? filterSourcesV2(uncited, query) : [], [filtering, query, uncited]);

  return (
    <div className="v2-answer-sources-sheet">
      {cited.length > 0 ? (
        <section aria-labelledby={citedHeadingId} className="v2-answer-sources-section" data-testid="answer-sources-cited">
          <h3 className="v2-answer-sources-heading" id={citedHeadingId}>
            <span>Cited in the answer</span>
            {" "}<span className="v2-answer-sources-count">{`· ${cited.length}`}</span>
          </h3>
          <PagedListV2
            as="ol"
            className="v2-answer-source-list"
            items={cited}
            renderItem={(source, index) => (
              <li key={`${source.url}:${index}`}>
                <span aria-hidden="true" className="v2-answer-source-index">{index + 1}</span>
                <span className="v2-answer-source-main">
                  <SourceTitleV2 source={source} />
                  {source.domain && source.domain !== source.title ? (
                    <small className="v2-answer-source-domain">{source.domain}</small>
                  ) : null}
                  {source.snippet ? <small className="v2-answer-source-snippet">{source.snippet}</small> : null}
                </span>
              </li>
            )}
          />
        </section>
      ) : null}
      {uncited.length > 0 ? (
        <section className="v2-answer-sources-section" data-testid="answer-sources-searched">
          <h3 className="v2-answer-sources-heading">
            <button
              aria-controls={othersOpen ? othersId : undefined}
              aria-expanded={othersOpen}
              className="v2-answer-sources-section-toggle v2-focusable"
              onClick={() => setOthersOpen((current) => !current)}
              type="button"
            >
              <span>{cited.length > 0 ? "Also searched" : "Searched"}</span>
              {" "}<span className="v2-answer-sources-count">{`· ${uncited.length}`}</span>
              <span aria-hidden="true" className="v2-answer-sources-chevron" />
            </button>
          </h3>
          {othersOpen ? (
            <div className="v2-answer-sources-searched" id={othersId}>
              <input
                aria-label="Filter sources"
                autoComplete="off"
                className="v2-answer-sources-filter v2-focusable"
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Filter by title, site or link"
                spellCheck={false}
                type="search"
                value={query}
              />
              {filtering ? (
                <>
                  <p aria-live="polite" className="v2-answer-sources-note" role="status">
                    {matches.length === 0 ? "No sources match." : `${matches.length} matching`}
                  </p>
                  {matches.length > 0 ? (
                    <PagedListV2
                      // A new query starts again from its first page.
                      key={query}
                      className="v2-answer-source-matches"
                      items={matches}
                      renderItem={(source, index) => (
                        <li key={`${source.url}:${index}`}>
                          <SourceTitleV2 source={source} />
                          {source.domain && source.domain !== source.title ? (
                            <small className="v2-answer-source-domain">{source.domain}</small>
                          ) : null}
                        </li>
                      )}
                      testId="answer-source-matches"
                    />
                  ) : null}
                </>
              ) : (
                <PagedListV2
                  className="v2-answer-source-sites"
                  items={groups}
                  renderItem={(group) => <SourceSiteRowV2 group={group} key={group.site} />}
                />
              )}
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * Sources live in the actions row: a "Sources · N" chip that opens a side
 * sheet (full screen on phones). N counts the sources the answer cites (its
 * citations and the links of its text that match a listed source), or every
 * source when it cites none. The sheet lists the cited ones first and the
 * rest of the run's searches grouped by site.
 */
export function useAnswerSourcesV2({ artifact, content }: Readonly<{
  artifact: ThreadArtifactSummary | null;
  /** The answer text as shown; its links mark sources as cited. */
  content: string;
}>): Readonly<{ chip: ReactNode; sheet: ReactNode }> {
  const [open, setOpen] = useState(false);
  const presented = useMemo(
    () => artifact ? presentSearchSourcesV2(answerWebSources(artifact)) : null,
    [artifact]
  );
  // A settled answer's text no longer changes, so the links are read once.
  const split = useMemo(
    () => artifact && presented && presented.sources.length > 0
      ? splitCitedSourcesV2(presented.sources, answerCitedUrlsV2(artifact.citations, content))
      : null,
    [artifact, content, presented]
  );
  if (!artifact || !split) return { chip: null, sheet: null };
  const count = split.cited.length > 0 ? split.cited.length : split.uncited.length;
  const truncated = artifact.citationsTruncated || artifact.sourcesTruncated;

  return {
    chip: (
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="v2-answer-sources-toggle v2-focusable"
        data-testid="answer-sources-toggle"
        onClick={() => setOpen(true)}
        type="button"
      >
        <span>Sources</span>
        <span className="v2-answer-sources-count" aria-hidden="true">· {count}</span>
        <span className="v2-sr-only">{`, ${count} item${count === 1 ? "" : "s"}`}</span>
      </button>
    ),
    sheet: (
      <UiV2Sheet
        description={truncated ? (
          <span data-testid="answer-sources-truncated">This answer has more sources than can be listed.</span>
        ) : undefined}
        onClose={() => setOpen(false)}
        open={open}
        phoneFullScreen
        testId="answer-sources"
        title="Sources"
      >
        <AnswerSourcesSheetBodyV2 cited={split.cited} uncited={split.uncited} />
      </UiV2Sheet>
    )
  };
}
