"use client";

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { UiV2Button, UiV2Chip, UiV2Icon } from "@/components/ui-v2";
import type {
  ThreadArtifactSummary,
  ThreadKnowledgeOutcome,
  ThreadRunEvidenceSummary,
  ThreadSearchActivity,
  ThreadToolActivity
} from "@/lib/contracts/chats";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import { GeminiSearchSuggestionsV2 } from "./GeminiSearchSuggestionsV2";
import { presentSearchSourcesV2 } from "./sourcePresentation";

export type EvidenceRowV2Props = Readonly<{
  /**
   * Optional quiet identity item (catalog-resolved model display name or the
   * accepted Assistant identity) rendered as plain muted text in the same
   * row. Raw adapter/provider/model ids never reach this slot.
   */
  identitySlot?: ReactNode;
  onOpenFiles?(): void;
  onOpenRunDetails(): void;
  onOpenSources?(): void;
  onOpenTools?(): void;
  summary: ThreadRunEvidenceSummary;
}>;

function countLabel(label: string, count: number): string {
  return `${label} ${count}`;
}

export function EvidenceRowV2({
  identitySlot,
  onOpenFiles,
  onOpenRunDetails,
  onOpenSources,
  onOpenTools,
  summary
}: EvidenceRowV2Props) {
  return (
    <nav
      aria-label="Answer evidence"
      className="v2-evidence-row"
      data-testid="evidence-row"
    >
      <div className="v2-evidence-row-track">
        {identitySlot ? (
          <span className="v2-evidence-row-identity">{identitySlot}</span>
        ) : null}
        {summary.sourceCount > 0 ? (
          <button
            aria-label={countLabel("Sources", summary.sourceCount)}
            type="button"
            onClick={onOpenSources ?? onOpenRunDetails}
          >
            {countLabel("Sources", summary.sourceCount)}
          </button>
        ) : null}
        {summary.toolCallCount > 0 ? (
          <button
            aria-label={countLabel("Tools", summary.toolCallCount)}
            type="button"
            onClick={onOpenTools ?? onOpenRunDetails}
          >
            {countLabel("Tools", summary.toolCallCount)}
          </button>
        ) : null}
        {summary.fileCount > 0 ? (
          <button
            aria-label={countLabel("Files", summary.fileCount)}
            type="button"
            onClick={onOpenFiles ?? onOpenRunDetails}
          >
            {countLabel("Files", summary.fileCount)}
          </button>
        ) : null}
        <button
          aria-label={summary.hasUsage ? "Run details, usage available" : "Run details"}
          type="button"
          onClick={onOpenRunDetails}
        >
          Run details
        </button>
      </div>
    </nav>
  );
}

function safeEvidenceHref(value: unknown): string | null {
  if (typeof value !== "string" || value.startsWith("//") || /[\u0000-\u001F\u007F\s]/u.test(value)) {
    return null;
  }
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username && !url.password
      ? value
      : null;
  } catch {
    return null;
  }
}

function statusLabel(status: ThreadSearchActivity["status"]): string {
  if (status === "complete") return "Complete";
  if (status === "partial") return "Partial";
  if (status === "error") return "Failed";
  if (status === "running") return "Searching";
  if (status === "cancelled") return "Cancelled";
  return "Status unavailable";
}

function searchHeadline(summary: ThreadArtifactSummary): string {
  const activities = summary.searchActivity ?? [];
  if (activities.some((activity) => activity.status === "running")) return "Searching";
  if (activities.length > 0 && activities.every((activity) => activity.status === "error")) {
    return "Failed";
  }
  if (activities.some((activity) => activity.status === "partial" || activity.status === "error")) {
    return "Partial";
  }
  const knownSources = activities.reduce(
    (total, activity) => total + (activity.sourceCount ?? activity.sources.length),
    0
  );
  if (activities.length > 0 && knownSources === 0 && summary.citationCount === 0) return "No results";
  if (activities.length === 0 && summary.groundingDisplay?.provider === "gemini") {
    return "Complete";
  }
  if (activities.length === 0) return "Evidence unavailable";
  return "Complete";
}

function SearchAttemptV2({ activity, ordinal }: {
  activity: ThreadSearchActivity;
  ordinal: number;
}) {
  const knownSourceCount = activity.sourceCount ?? activity.sources.length;
  const presented = presentSearchSourcesV2(activity.sources);
  const failure = activity.failureReason ?? (
    activity.status === "error"
      ? "This Search attempt did not complete."
      : activity.status === "partial"
        ? "Some Search work did not complete."
        : null
  );

  return (
    <li className="v2-search-attempt" data-status={activity.status}>
      <div className="v2-search-attempt-heading">
        <span>Attempt {ordinal}</span>
        <strong>{activity.displayName}</strong>
        <span className="v2-search-source-fact">
          {knownSourceCount} source{knownSourceCount === 1 ? "" : "s"}
        </span>
        {activity.status !== "complete" ? (
          <UiV2Chip tone={activity.status === "error" ? "danger" : activity.status === "partial" ? "warn" : "neutral"}>
            {statusLabel(activity.status)}
          </UiV2Chip>
        ) : null}
      </div>
      {failure ? <p className="v2-evidence-warning">{failure}</p> : null}
      {activity.query ? (
        <p className="v2-search-query"><span>Query</span><code>{activity.query}</code></p>
      ) : null}
      {knownSourceCount === 0 ? (
        <p className="v2-evidence-empty">No sources were returned by this attempt.</p>
      ) : presented.sources.length > 0 ? (
        <ol className="v2-source-list">
          {presented.sources.map((source, index) => {
            const href = safeEvidenceHref(source.url);
            return (
              <li key={`${source.rank}:${source.url}:${index}`}>
                <span className="v2-source-index">{source.rank}</span>
                <span>
                  {href ? (
                    <a href={href} rel="noreferrer" target="_blank">{source.title}</a>
                  ) : (
                    <span data-testid="unsafe-source-title">{source.title}</span>
                  )}
                  {source.domain && source.domain !== source.title ? (
                    <small className="v2-source-domain">{source.domain}</small>
                  ) : null}
                  {source.snippet ? <small>{source.snippet}</small> : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
      {presented.mergedDuplicateCount > 0 ? (
        <p className="v2-evidence-empty" data-testid="merged-duplicate-sources">
          {presented.mergedDuplicateCount} duplicate link{presented.mergedDuplicateCount === 1 ? "" : "s"} merged.
        </p>
      ) : null}
      {knownSourceCount > activity.sources.length && activity.sources.length > 0 ? (
        <p className="v2-evidence-empty">
          {knownSourceCount - activity.sources.length} additional source{knownSourceCount - activity.sources.length === 1 ? "" : "s"} not included in the bounded preview.
        </p>
      ) : knownSourceCount > 0 && activity.sources.length === 0 ? (
        <p className="v2-evidence-empty">
          {knownSourceCount} source{knownSourceCount === 1 ? "" : "s"} reported; preview unavailable.
        </p>
      ) : null}
    </li>
  );
}

export function SearchEvidenceV2({
  focusCitationIndex = null,
  onFocusCitationSettled,
  onOpenChange,
  open,
  summary
}: Readonly<{
  focusCitationIndex?: number | null;
  onFocusCitationSettled?(): void;
  onOpenChange(open: boolean): void;
  open: boolean;
  summary: ThreadArtifactSummary;
}>) {
  const regionId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const activities = summary.searchActivity ?? [];
  const headline = searchHeadline(summary);

  useEffect(() => {
    if (!open || focusCitationIndex === null) return;
    const target = rootRef.current?.querySelector<HTMLElement>(
      `[data-citation-index="${focusCitationIndex}"]`
    );
    target?.focus({ preventScroll: false });
    onFocusCitationSettled?.();
  }, [focusCitationIndex, onFocusCitationSettled, open]);

  return (
    <section className="v2-evidence-disclosure" ref={rootRef} data-testid="search-evidence">
      <button
        aria-controls={regionId}
        aria-expanded={open}
        aria-label={`Search, ${headline}, ${activities.length} attempt${activities.length === 1 ? "" : "s"}`}
        className="v2-evidence-disclosure-trigger"
        onClick={() => onOpenChange(!open)}
        type="button"
      >
        <UiV2Icon name={open ? "chevron-down" : "chevron-right"} />
        <UiV2Icon name="search" />
        <strong>Search</strong>
        <span>{headline}</span>
        <span className="v2-evidence-disclosure-count">
          {activities.length} attempt{activities.length === 1 ? "" : "s"}
        </span>
      </button>
      {open ? (
        <div className="v2-evidence-disclosure-body" id={regionId}>
          {activities.length > 0 ? (
            <ol className="v2-search-attempt-list">
              {activities.map((activity, index) => (
                <SearchAttemptV2
                  activity={activity}
                  key={`${activity.displayName}:${index}`}
                  ordinal={index + 1}
                />
              ))}
            </ol>
          ) : (
            <p className="v2-evidence-empty">
              Search was requested, but detailed attempt evidence is unavailable for this run.
            </p>
          )}
          {summary.citations.length > 0 ? (
            <section className="v2-citation-sources" aria-label="Cited sources">
              <h4>Cited sources</h4>
              <ol>
                {summary.citations.map((citation) => {
                  const href = safeEvidenceHref(citation.url);
                  return (
                    <li
                      data-citation-index={citation.index}
                      id={`${regionId}-citation-${citation.index}`}
                      key={`${citation.index}:${citation.url}`}
                      tabIndex={-1}
                    >
                      <span>[{citation.index}]</span>
                      <span>
                        {href ? (
                          <a href={href} rel="noreferrer" target="_blank">{citation.title}</a>
                        ) : (
                          <span data-testid="unsafe-citation-title">{citation.title}</span>
                        )}
                        {citation.source ? <small>{citation.source}</small> : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
          {summary.groundingDisplay?.provider === "gemini" ? (
            <GeminiSearchSuggestionsV2 html={summary.groundingDisplay.suggestionsHtml} />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function CitationMarkerV2({ index, onActivate }: Readonly<{
  index: number;
  onActivate(index: number): void;
}>) {
  return (
    <button
      aria-label={`Open source ${index}`}
      className="v2-citation-marker"
      onClick={() => onActivate(index)}
      type="button"
    >
      [{index}]
    </button>
  );
}

function knowledgeOutcomeLabel(outcome: ThreadKnowledgeOutcome["outcome"]): string {
  if (outcome === "complete") return "Evidence retrieved";
  if (outcome === "zero_above_threshold") return "No passage above threshold";
  if (outcome === "base_empty") return "Selected base is empty";
  if (outcome === "base_indexing") return "Selected base is indexing";
  return "Embedding model unavailable";
}

export function KnowledgeEvidenceV2({ summary }: { summary: ThreadArtifactSummary }) {
  const [open, setOpen] = useState(false);
  const outcomes = summary.knowledgeOutcomes ?? [];
  const citations = summary.knowledgeCitations ?? [];
  if ((summary.knowledgeInvocationCount ?? 0) === 0 && outcomes.length === 0) return null;

  return (
    <section className="v2-evidence-disclosure" data-testid="knowledge-evidence">
      <button
        aria-expanded={open}
        aria-label={`Knowledge, ${summary.knowledgeInvocationCount ?? outcomes.length} invocation${(summary.knowledgeInvocationCount ?? outcomes.length) === 1 ? "" : "s"}, ${citations.length} cited`}
        className="v2-evidence-disclosure-trigger"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        <UiV2Icon name={open ? "chevron-down" : "chevron-right"} />
        <UiV2Icon name="library" />
        <strong>Knowledge</strong>
        <span>{summary.knowledgeInvocationCount ?? outcomes.length} invocation{(summary.knowledgeInvocationCount ?? outcomes.length) === 1 ? "" : "s"}</span>
        <span className="v2-evidence-disclosure-count">{citations.length} cited</span>
      </button>
      {open ? (
        <div className="v2-evidence-disclosure-body">
          <ol className="v2-knowledge-outcomes">
            {outcomes.map((outcome) => (
              <li key={outcome.invocationOrdinal}>
                <span>Invocation {outcome.invocationOrdinal}</span>
                <strong>{knowledgeOutcomeLabel(outcome.outcome)}</strong>
              </li>
            ))}
          </ol>
          {citations.length > 0 ? (
            <ol className="v2-knowledge-citations">
              {citations.map((citation) => (
                <li key={citation.handle}>
                  <code>[{citation.handle}]</code>
                  <span>
                    <strong>{citation.fileName}</strong>
                    <small>{citation.baseName} · page {citation.page}</small>
                  </span>
                </li>
              ))}
            </ol>
          ) : <p className="v2-evidence-empty">No Knowledge passage was cited in the answer.</p>}
        </div>
      ) : null}
    </section>
  );
}

const PREVIEW_LIMIT = 4_096;

function boundedPreview(value: unknown): { text: string; truncated: boolean } {
  try {
    const serialized = JSON.stringify(value, null, 2) ?? "Unavailable";
    return serialized.length <= PREVIEW_LIMIT
      ? { text: serialized, truncated: false }
      : { text: `${serialized.slice(0, PREVIEW_LIMIT)}\n…`, truncated: true };
  } catch {
    return { text: "Preview unavailable", truncated: false };
  }
}

function toolStatusTone(status: ThreadToolActivity["status"]): "danger" | "neutral" | "ok" | "warn" {
  if (status === "complete") return "ok";
  if (status === "error") return "danger";
  if (status === "cancelled") return "warn";
  return "neutral";
}

export function ToolEvidenceV2({
  onOpenChange,
  open: controlledOpen,
  toolCalls
}: {
  onOpenChange?(open: boolean): void;
  open?: boolean;
  toolCalls: readonly ThreadToolActivity[];
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  if (toolCalls.length === 0) return null;

  function toggle() {
    const next = !open;
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  }

  return (
    <section className="v2-evidence-disclosure" data-testid="tool-evidence">
      <button
        aria-expanded={open}
        aria-label={`Tools, ${toolCalls.length} call${toolCalls.length === 1 ? "" : "s"}`}
        className="v2-evidence-disclosure-trigger"
        onClick={toggle}
        type="button"
      >
        <UiV2Icon name={open ? "chevron-down" : "chevron-right"} />
        <UiV2Icon name="tool" />
        <strong>Tools</strong>
        <span>{toolCalls.length} call{toolCalls.length === 1 ? "" : "s"}</span>
      </button>
      {open ? (
        <ol className="v2-tool-call-list">
          {toolCalls.map((call, index) => {
            const argumentsPreview = boundedPreview(call.argumentsPreview);
            const resultPreview = boundedPreview(call.resultPreview);
            return (
              <li key={`${call.round}:${call.ordinal}:${index}`}>
                <div className="v2-tool-call-heading">
                  <span>{call.serverName ?? "Tool"}</span>
                  <strong>{call.toolName}</strong>
                  <UiV2Chip tone={toolStatusTone(call.status)}>{call.status}</UiV2Chip>
                </div>
                {call.errorMessage ? <p className="v2-evidence-warning">{call.errorMessage}</p> : null}
                <details>
                  <summary>Redacted arguments</summary>
                  <pre>{argumentsPreview.text}</pre>
                  {argumentsPreview.truncated ? <small>Preview truncated at the presentation boundary.</small> : null}
                </details>
                <details>
                  <summary>Untrusted result preview</summary>
                  <pre>{resultPreview.text}</pre>
                  {resultPreview.truncated ? <small>Preview truncated at the presentation boundary.</small> : null}
                </details>
              </li>
            );
          })}
        </ol>
      ) : null}
    </section>
  );
}

export type ToolApprovalStatusV2 =
  | "allowed"
  | "allowing"
  | "error"
  | "pending"
  | "rejected"
  | "rejecting";

export function ToolApprovalCardV2({
  error,
  onAllow,
  onReject,
  redactedArgumentsPreview,
  serverName,
  status,
  toolName
}: Readonly<{
  error?: string | null;
  onAllow(): void;
  onReject(): void;
  redactedArgumentsPreview: unknown;
  serverName: string;
  status: ToolApprovalStatusV2;
  toolName: string;
}>) {
  const preview = useMemo(
    () => boundedPreview(redactedArgumentsPreview),
    [redactedArgumentsPreview]
  );
  const pending = status === "pending" || status === "allowing" || status === "rejecting" || status === "error";

  return (
    <aside className="v2-tool-approval" aria-label={`Approval required for ${serverName} ${toolName}`}>
      <div className="v2-tool-approval-heading">
        <UiV2Icon name="lock" />
        <span>
          <small>Tool approval required</small>
          <strong>{serverName} · {toolName}</strong>
        </span>
        <UiV2Chip tone={status === "error" ? "danger" : status === "allowed" ? "ok" : status === "rejected" ? "warn" : "neutral"}>
          {status}
        </UiV2Chip>
      </div>
      <p>Review the bounded, redacted preview before this server receives the request.</p>
      <details>
        <summary>Review arguments</summary>
        <pre>{preview.text}</pre>
        {preview.truncated ? <small>Preview truncated at the presentation boundary.</small> : null}
      </details>
      {error ? <p className="v2-evidence-warning" role="alert">{error}</p> : null}
      {pending ? (
        <div className="v2-tool-approval-actions">
          <UiV2Button
            busy={status === "rejecting"}
            disabled={status === "allowing"}
            onClick={onReject}
          >
            Reject
          </UiV2Button>
          <UiV2Button
            busy={status === "allowing"}
            disabled={status === "rejecting"}
            onClick={onAllow}
            tone="primary"
          >
            Allow once
          </UiV2Button>
        </div>
      ) : null}
    </aside>
  );
}

export function EvidenceStackV2({ children }: { children: ReactNode }) {
  return <div className="v2-evidence-stack">{children}</div>;
}

/**
 * Collapsed reasoning disclosure for a settled answer. Text renders through
 * the shared safe Markdown pipeline so provider markup never shows as literal
 * asterisks. The header carries a duration only when the caller derived one
 * from persisted run evidence timestamps; no counter or duration is ever
 * invented.
 */
export function ReasoningEvidenceV2({ durationLabel = null, texts }: Readonly<{
  durationLabel?: string | null;
  texts: readonly string[];
}>) {
  const content = texts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  if (!content) return null;

  return (
    <details className="v2-live-reasoning" data-testid="reasoning-evidence">
      <summary>{durationLabel ? `Reasoning · ${durationLabel}` : "Reasoning"}</summary>
      <div className="v2-live-reasoning-body">
        <MarkdownMessage content={content} />
      </div>
    </details>
  );
}
