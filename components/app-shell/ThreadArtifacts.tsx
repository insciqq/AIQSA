import { searchStrategyDescription } from "@/components/app-shell/shellFormatting";
import type {
  ThreadArtifactSummary,
  ThreadSearchActivity,
  ThreadSearchOperation,
  ThreadToolActivity
} from "@/components/app-shell/types";
import { safeExternalHref } from "@/lib/domain/links";
import {
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  Scissors,
  Search,
  Square,
  Wrench
} from "lucide-react";
import { memo, useState } from "react";

type DisclosureControl = {
  expanded?: boolean;
  onExpandedChange?(expanded: boolean): void;
};

function useDisclosureControl({
  expanded,
  onExpandedChange
}: DisclosureControl): readonly [boolean, () => void] {
  const [localExpanded, setLocalExpanded] = useState(false);
  const resolvedExpanded = expanded ?? localExpanded;

  return [
    resolvedExpanded,
    () => {
      const nextExpanded = !resolvedExpanded;
      if (expanded === undefined) {
        setLocalExpanded(nextExpanded);
      }
      onExpandedChange?.(nextExpanded);
    }
  ] as const;
}

function ContextTruncationBlockComponent({ summary }: { summary: ThreadArtifactSummary }) {
  const truncation = summary.contextTruncation;

  if (!truncation) {
    return null;
  }

  return (
    <aside
      className="mb-5 border-l-2 border-caution/45 bg-caution/[0.05] px-4 py-3 text-xs leading-5 text-ink-secondary"
      data-testid="thread-context-truncation"
      aria-label="Context trimmed"
    >
      <div className="flex items-start gap-2">
        <Scissors className="mt-0.5 size-3.5 shrink-0 text-caution" aria-hidden="true" />
        <div className="min-w-0">
          <div className="font-semibold text-caution">Context trimmed</div>
          <div className="mt-0.5">
            {truncation.droppedMessages === 1
              ? "The oldest message was not sent because the context window was full"
              : `The oldest ${truncation.droppedMessages} messages were not sent because the context window was full`}
            {truncation.approxDroppedTokens > 0 ? (
              <span className="font-mono text-ink"> · ~{truncation.approxDroppedTokens} tokens</span>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}

function SearchSummaryBlockComponent({
  active = false,
  expanded,
  onExpandedChange,
  summary
}: DisclosureControl & {
  active?: boolean;
  summary: ThreadArtifactSummary;
}) {
  const activities = summary.searchActivity ?? [];
  const activityNames = [...new Set(activities.map((activity) => activity.displayName))];
  const strategy = activityNames.join(" + ") || summary.searchDisplayName?.trim() ||
    (summary.searchStrategy ? searchStrategyDescription(summary.searchStrategy) : "Search source");
  const status = active ? "Searching" : searchActivitySummaryStatus(activities);
  const allAttemptsFailed = !active && activities.length > 0 &&
    activities.every((activity) => activity.status === "error");
  const sourceFact = searchSourceCountFact(activities);
  const [open, toggleOpen] = useDisclosureControl({ expanded, onExpandedChange });

  return (
    <section
      className="border-t border-trace-subtle pt-2 text-xs text-ink-secondary"
      data-testid="thread-search-summary"
      aria-label="Search activity"
    >
      <button
        className="-mx-2 flex min-h-control w-[calc(100%+1rem)] cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-control px-2 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-proof/45 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        type="button"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        )}
        <Search className={active ? "size-4 shrink-0 text-proof" : "size-4 shrink-0 text-ink-muted"} aria-hidden="true" />
        <span className="font-semibold text-ink">Search</span>
        <span className="min-w-0 truncate text-ink-muted" title={strategy}>{strategy}</span>
        <span className={status === "Failed" || allAttemptsFailed ? "text-critical" : "text-ink-muted"}>· {status}</span>
        {sourceFact ? <span className="text-ink-muted">· {sourceFact}</span> : null}
        {summary.citationCount > 0 ? (
          <span className="text-ink-muted">
            · {summary.citationCount} {summary.citationCount === 1 ? "citation" : "citations"}
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          className="mt-2 divide-y divide-trace-subtle border-y border-trace-subtle"
          data-testid="thread-search-details"
        >
          {activities.length > 0 ? activities.map((activity, index) => (
            <SearchAttemptDisclosure
              activity={activity}
              index={index}
              initiallyExpanded={activities.length === 1}
              key={`${activity.displayName}:${index}`}
            />
          )) : (
            <p className="py-3 text-ink-muted">Detailed Search evidence is unavailable for this run.</p>
          )}
          {summary.citations.length > 0 ? (
            <section className="py-3" aria-label="Search citations">
              <div className="mb-1 font-medium text-ink-secondary">Citations · {summary.citations.length}</div>
              <ol className="grid gap-1.5">
                {summary.citations.map((citation) => {
                  const href = safeSearchEvidenceHref(citation.url);
                  return (
                    <li className="min-w-0" key={`${citation.index}:${citation.url}`}>
                      {href ? (
                        <a
                          className="break-words font-medium text-proof underline-offset-2 hover:text-proof-hover hover:underline [overflow-wrap:anywhere]"
                          href={href}
                          rel="noreferrer"
                          target="_blank"
                        >
                          [{citation.index}] {citation.title}
                        </a>
                      ) : (
                        <span className="break-words font-medium text-ink [overflow-wrap:anywhere]">
                          [{citation.index}] {citation.title}
                        </span>
                      )}
                    </li>
                  );
                })}
              </ol>
            </section>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function SearchAttemptDisclosure({
  activity,
  index,
  initiallyExpanded
}: Readonly<{
  activity: ThreadSearchActivity;
  index: number;
  initiallyExpanded: boolean;
}>) {
  const [open, setOpen] = useState(initiallyExpanded);
  const status = searchActivityStatusLabel(activity.status);
  const sourceFact = activity.sourceCount === null
    ? null
    : `${activity.sourceCount} ${activity.sourceCount === 1 ? "source" : "sources"}`;
  const failureReason = activity.failureReason ?? (
    activity.status === "error"
      ? "This Search source could not complete the attempt."
      : activity.status === "partial"
        ? "Some Search work did not complete."
        : null
  );

  return (
    <section className="min-w-0 py-1" data-testid="thread-search-attempt">
      <button
        aria-expanded={open}
        className="-mx-2 flex min-h-control w-[calc(100%+1rem)] items-center gap-2 rounded-control px-2 py-1.5 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-proof/45 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        onClick={() => setOpen((value) => !value)}
        type="button"
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        )}
        <span className="shrink-0 text-ink-muted">Attempt {index + 1}</span>
        <span className="min-w-0 flex-1 truncate font-semibold text-ink" title={activity.displayName}>
          {activity.displayName}
        </span>
        <span className={activity.status === "error" ? "shrink-0 text-critical" : "shrink-0 text-ink-muted"}>
          {status}
        </span>
        {sourceFact ? <span className="hidden shrink-0 text-ink-muted sm:inline">· {sourceFact}</span> : null}
      </button>

      {open ? (
        <div className="grid gap-3 pb-3 pl-5 pt-2" data-testid="thread-search-attempt-details">
          {failureReason ? (
            <div className="border-l-2 border-critical/45 bg-critical/[0.04] px-3 py-2 text-ink-secondary">
              <div className="font-medium text-critical">Could not complete</div>
              <p className="mt-0.5 leading-5">{failureReason}</p>
            </div>
          ) : null}
          <div>
            <div className="mb-1 font-medium text-ink-secondary">Generated query</div>
            {activity.query ? (
              <div className="break-words rounded-control bg-control-surface px-2 py-1.5 font-mono text-[11px] leading-5 text-ink [overflow-wrap:anywhere]">
                {activity.query}
              </div>
            ) : (
              <p className="text-ink-muted">The Search source did not report its query.</p>
            )}
          </div>
          <SearchSources activity={activity} />
          <div>
            <div className="font-medium text-ink-secondary">
              Provider operations{activity.providerOperations && activity.providerOperations.length > 0
                ? ` · ${activity.providerOperations.length}${activity.providerOperationsTruncated ? "+" : ""}`
                : activity.providerOperationsTruncated
                  ? " · additional activity omitted"
                  : ""}
            </div>
            {activity.providerOperations === null ? (
              <p className="mt-1 text-ink-muted">Provider operation details are unavailable for this run.</p>
            ) : activity.providerOperations.length === 0 ? (
              <p className="mt-1 text-ink-muted">
                {activity.providerOperationsTruncated
                  ? "Provider activity exceeded the inspection limit; detailed operations were omitted."
                  : "The provider reported no detailed web operations."}
              </p>
            ) : (
              <>
                <ol className="mt-1 divide-y divide-trace-subtle">
                  {activity.providerOperations.map((operation) => (
                    <SearchProviderOperationRow
                      key={`${operation.ordinal}:${operation.kind}`}
                      operation={operation}
                    />
                  ))}
                </ol>
                {activity.providerOperationsTruncated ? (
                  <p className="mt-1 text-ink-muted">Additional provider operations were omitted by the inspection limit.</p>
                ) : null}
              </>
            )}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function searchActivityStatusLabel(status: ThreadSearchActivity["status"]): string {
  if (status === "complete") return "Completed";
  if (status === "partial") return "Partially completed";
  if (status === "error") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "running") return "Running";
  return "Status unavailable";
}

function searchActivitySummaryStatus(activities: readonly ThreadSearchActivity[]): string {
  const statuses = new Set(activities.map((activity) => activity.status));
  if (statuses.has("running")) return "Searching";
  if (activities.length > 1) {
    const completed = activities.filter((activity) => activity.status === "complete").length;
    return `${completed} of ${activities.length} completed`;
  }
  if (statuses.has("partial")) return "Partially completed";
  const terminalStatusCount = (["complete", "error", "cancelled"] as const)
    .filter((status) => statuses.has(status)).length;
  if (!statuses.has("unknown") && terminalStatusCount > 1) return "Partially completed";
  if (statuses.size === 1 && statuses.has("complete")) return "Completed";
  if (statuses.size === 1 && statuses.has("error")) return "Failed";
  if (statuses.size === 1 && statuses.has("cancelled")) return "Cancelled";
  return "Status unavailable";
}

function searchSourceCountFact(activities: readonly ThreadSearchActivity[]): string | null {
  const known = activities.flatMap((activity) =>
    activity.sourceCount === null ? [] : [activity.sourceCount]
  );
  if (known.length === 0) return null;
  const count = known.reduce((total, value) => total + value, 0);
  const suffix = known.length < activities.length ? "+" : "";
  return `${count}${suffix} ${count === 1 && !suffix ? "source" : "sources"}`;
}

function SearchSources({ activity }: Readonly<{ activity: ThreadSearchActivity }>) {
  return (
    <div>
      <div className="font-medium text-ink-secondary">
        Sources{activity.sourceCount === null ? "" : ` · ${activity.sourceCount}`}
      </div>
      {activity.sources.length > 0 ? (
        <ol className="mt-1 grid gap-2">
          {activity.sources.map((source) => {
            const href = safeSearchEvidenceHref(source.url);
            return (
              <li className="min-w-0 border-l border-trace-subtle pl-2" key={`${source.rank}:${source.url}`}>
                {href ? (
                  <a
                    className="break-words font-medium text-proof underline-offset-2 hover:text-proof-hover hover:underline [overflow-wrap:anywhere]"
                    href={href}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {source.title}
                  </a>
                ) : (
                  <span className="break-words font-medium text-ink [overflow-wrap:anywhere]">{source.title}</span>
                )}
                {source.date ? <span className="ml-2 text-ink-muted">{source.date}</span> : null}
                {source.snippet ? (
                  <p className="mt-0.5 break-words leading-5 text-ink-muted [overflow-wrap:anywhere]">{source.snippet}</p>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : activity.sourceCount === null ? (
        <p className="mt-1 text-ink-muted">Normalized source details are unavailable for this run.</p>
      ) : activity.sourceCount === 0 ? (
        <p className="mt-1 text-ink-muted">No normalized sources were captured.</p>
      ) : (
        <p className="mt-1 text-ink-muted">Source links are unavailable for this historical run.</p>
      )}
      {activity.sourceCount !== null && activity.sourceCount > activity.sources.length && activity.sources.length > 0 ? (
        <p className="mt-1 text-ink-muted">
          Showing {activity.sources.length} of {activity.sourceCount} sources.
        </p>
      ) : null}
    </div>
  );
}

function formatPreview(value: unknown): string {
  if (typeof value === "string") {
    return value.trim() || "n/a";
  }

  if (value === null || value === undefined) {
    return "n/a";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "n/a";
  }
}

function toolStatusLabel(status: ThreadToolActivity["status"]): string {
  if (status === "complete") return "Completed";
  if (status === "error") return "Failed";
  if (status === "cancelled") return "Cancelled";
  return "Running";
}

function ToolStatusIcon({ status }: { status: ThreadToolActivity["status"] }) {
  if (status === "complete") {
    return <CheckCircle2 className="size-3.5 text-positive" aria-hidden="true" />;
  }
  if (status === "error") {
    return <CircleAlert className="size-3.5 text-critical" aria-hidden="true" />;
  }
  if (status === "cancelled") {
    return <Square className="size-3.5 text-ink-muted" aria-hidden="true" />;
  }
  return <LoaderCircle className="size-3.5 animate-spin text-proof" aria-hidden="true" />;
}

function toolDuration(durationMs: number | null): string | null {
  if (durationMs === null) return null;
  return durationMs < 1_000 ? `${durationMs} ms` : `${(durationMs / 1_000).toFixed(1)} s`;
}

function toolIdentity(call: ThreadToolActivity): string {
  return call.serverName ? `${call.serverName} / ${call.toolName}` : call.toolName;
}

function providerOperationLabel(kind: ThreadSearchOperation["kind"]): string {
  if (kind === "search") return "Web search";
  if (kind === "open_page") return "Open page";
  if (kind === "find_in_page") return "Find in page";
  return "Provider operation";
}

function providerOperationStatusLabel(status: ThreadSearchOperation["status"]): string {
  if (status === "complete") return "Completed";
  if (status === "error") return "Failed";
  if (status === "running") return "Running";
  return "Status unavailable";
}

function safeSearchEvidenceHref(value: unknown): string | null {
  const href = safeExternalHref(value);
  if (!href) return null;
  try {
    const url = new URL(href);
    return (url.protocol === "https:" || url.protocol === "http:") &&
      !url.username &&
      !url.password
      ? href
      : null;
  } catch {
    return null;
  }
}

function SearchProviderOperationRow({
  operation
}: Readonly<{ operation: ThreadSearchOperation }>) {
  const operationHref = safeSearchEvidenceHref(operation.url);
  return (
    <li className="min-w-0 py-2" data-provider-operation-kind={operation.kind}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium text-ink-secondary">
          {operation.ordinal + 1}. {providerOperationLabel(operation.kind)}
        </span>
        <span className="text-ink-muted">{providerOperationStatusLabel(operation.status)}</span>
      </div>
      {operation.queries.length > 0 ? (
        <ul className="mt-1 grid gap-1" aria-label="Provider search queries">
          {operation.queries.map((query, index) => (
            <li
              className="break-words border-l border-trace-subtle pl-2 font-mono text-[11px] leading-5 text-ink [overflow-wrap:anywhere]"
              key={`${operation.ordinal}:${index}:${query}`}
            >
              {query}
            </li>
          ))}
        </ul>
      ) : operation.kind === "search" ? (
        <p className="mt-1 text-ink-muted">Provider did not report the internal query.</p>
      ) : null}
      {operationHref ? (
        <a
          className="mt-1 block break-all font-mono text-[11px] leading-5 text-proof underline-offset-2 hover:text-proof-hover hover:underline"
          href={operationHref}
          rel="noreferrer"
          target="_blank"
        >
          {operationHref}
        </a>
      ) : null}
      {operation.pattern ? (
        <p className="mt-1 break-words font-mono text-[11px] leading-5 text-ink-secondary [overflow-wrap:anywhere]">
          Pattern: {operation.pattern}
        </p>
      ) : null}
    </li>
  );
}

function ToolActivityBlockComponent({
  expanded,
  onExpandedChange,
  summary
}: DisclosureControl & { summary: ThreadArtifactSummary }) {
  const calls = summary.toolCalls.filter((call) => call.capability === "mcp");
  const [open, toggleOpen] = useDisclosureControl({ expanded, onExpandedChange });
  if (calls.length === 0) return null;

  const rounds = new Map<number, ThreadToolActivity[]>();
  for (const call of calls) {
    const current = rounds.get(call.round) ?? [];
    current.push(call);
    rounds.set(call.round, current);
  }
  const running = calls.filter((call) => call.status === "running").length;
  const failed = calls.filter((call) => call.status === "error").length;
  const servers = Array.from(new Set(calls.map((call) => call.serverName).filter(Boolean)));
  const headline = running > 0
    ? `Running ${running} ${running === 1 ? "tool" : "tools"}`
    : `Used ${calls.length} ${calls.length === 1 ? "tool" : "tools"}`;

  return (
    <section
      className="border-t border-trace-subtle pt-2 text-xs text-ink-secondary"
      data-testid="thread-tool-activity"
      aria-label="Tool activity"
    >
      <button
        className="-mx-2 flex min-h-control w-[calc(100%+1rem)] flex-wrap items-center gap-x-2 gap-y-1 rounded-control px-2 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-proof/45 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        type="button"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        )}
        <Wrench className="size-4 shrink-0 text-proof" aria-hidden="true" />
        <span className="font-semibold text-ink">{headline}</span>
        {failed > 0 ? <span className="text-critical">· {failed} failed</span> : null}
        {servers.length > 0 ? (
          <span className="min-w-0 truncate text-ink-muted">{servers.join(", ")}</span>
        ) : null}
      </button>

      {open ? (
        <div
          className="mt-2 divide-y divide-trace-subtle border-y border-trace-subtle"
          data-testid="thread-tool-activity-details"
        >
          {[...rounds.entries()].map(([round, roundCalls]) => (
            <section className="py-3" key={round} aria-label={`Tool round ${round}`}>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                <span className="font-semibold text-ink-secondary">Round {round}</span>
                <span>
                  {roundCalls.length > 1
                    ? `${roundCalls.length} parallel calls`
                    : "1 call"}
                </span>
              </div>
              <div className="divide-y divide-trace-subtle">
                {roundCalls.map((call) => (
                  <details
                    className="group/tool py-2"
                    data-tool-status={call.status}
                    key={call.callId}
                  >
                    <summary className="-mx-2 flex min-h-control cursor-pointer list-none items-center gap-2 break-words rounded-control px-2 outline-none marker:hidden hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-proof/45 [overflow-wrap:anywhere]">
                      <ToolStatusIcon status={call.status} />
                      <span className="min-w-0 flex-1 font-medium text-ink">
                        {toolIdentity(call)}
                      </span>
                      <span className={call.status === "error" ? "text-critical" : "text-ink-muted"}>
                        {toolStatusLabel(call.status)}
                      </span>
                      {toolDuration(call.durationMs) ? (
                        <span className="font-mono text-ink-muted">{toolDuration(call.durationMs)}</span>
                      ) : null}
                      <ChevronRight className="size-3.5 shrink-0 text-ink-muted transition-transform group-open/tool:rotate-90" aria-hidden="true" />
                    </summary>
                    <div className="mt-2 grid gap-2 border-l border-trace-subtle pl-3">
                      {call.externalAccountLabel || call.credentialSources.length > 0 ? (
                        <div className="flex flex-wrap gap-x-2 gap-y-1 text-xs text-ink-muted">
                          {call.externalAccountLabel ? <span>Account: {call.externalAccountLabel}</span> : null}
                          {call.credentialSources.length > 0 ? (
                            <span>Credentials: {call.credentialSources.join(", ")}</span>
                          ) : null}
                        </div>
                      ) : null}
                      <div>
                        <div className="mb-1 text-xs font-medium text-ink-secondary">Arguments · sensitive values redacted</div>
                        <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-control-surface p-2 font-mono text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
                          {formatPreview(call.argumentsPreview)}
                        </pre>
                      </div>
                      <div>
                        <div className="mb-1 text-xs font-medium text-ink-secondary">Result preview</div>
                        <pre className="max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-control-surface p-2 font-mono text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
                          {formatPreview(call.resultPreview)}
                        </pre>
                      </div>
                      {call.errorMessage ? (
                        <p className="break-words text-xs leading-5 text-critical [overflow-wrap:anywhere]">
                          {call.errorMessage}
                        </p>
                      ) : null}
                    </div>
                  </details>
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CitationBlockComponent({
  embedded = false,
  expanded,
  onExpandedChange,
  summary
}: DisclosureControl & { embedded?: boolean; summary: ThreadArtifactSummary }) {
  const citations = summary.citations ?? [];
  const [open, toggleOpen] = useDisclosureControl({ expanded, onExpandedChange });

  if (embedded && !open) {
    return null;
  }

  return (
    <section
      className={
        embedded
          ? "mt-2 border-t border-trace-subtle pt-2 text-xs text-ink-secondary"
          : "border-t border-trace-subtle pt-2 text-xs text-ink-secondary"
      }
      data-testid="thread-citations-block"
      aria-label={
        embedded
          ? `${summary.citationCount} citation ${summary.citationCount === 1 ? "source" : "sources"}`
          : undefined
      }
    >
      {!embedded ? (
        <button
          className="-mx-2 flex min-h-control w-[calc(100%+1rem)] items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-proof/45 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
          type="button"
          aria-expanded={open}
          onClick={toggleOpen}
        >
          {open ? (
            <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          ) : (
            <ChevronRight className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          )}
          <span className="font-semibold text-ink">Citations</span>
          <span className="text-ink-muted">{summary.citationCount}</span>
        </button>
      ) : null}
      {open && citations.length > 0 ? (
        <ol
          className={
            embedded
              ? "divide-y divide-trace-subtle"
              : "mt-2 divide-y divide-trace-subtle border-y border-trace-subtle"
          }
        >
          {citations.map((citation) => {
            const href = safeExternalHref(citation.url);

            return (
              <li className="min-w-0 py-3" key={`${citation.index}:${citation.url}`}>
                {href ? (
                  <a
                    className="block break-words font-medium text-proof underline-offset-2 hover:text-proof-hover hover:underline [overflow-wrap:anywhere]"
                    href={href}
                    rel="noreferrer"
                    target="_blank"
                  >
                    [{citation.index}] {citation.title}
                  </a>
                ) : (
                  <div className="block break-words font-medium text-ink [overflow-wrap:anywhere]">
                    [{citation.index}] {citation.title}
                  </div>
                )}
                <div className="mt-0.5 break-all text-xs text-ink-muted">{citation.url}</div>
                {citation.snippet ? (
                  <div className="mt-1 break-words text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
                    {citation.snippet}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : open ? (
        <div
          className={
            embedded
              ? "py-3 text-ink-muted"
              : "mt-2 border-t border-trace-subtle py-3 text-ink-muted"
          }
        >
          No citation text captured for this run.
        </div>
      ) : null}
    </section>
  );
}

function ReasoningBlockComponent({
  expanded,
  onExpandedChange,
  summary
}: DisclosureControl & { summary: ThreadArtifactSummary }) {
  const [open, toggleOpen] = useDisclosureControl({ expanded, onExpandedChange });

  return (
    <section
      className="border-t border-trace-subtle pt-2 text-xs text-ink-secondary"
      data-testid="thread-reasoning-block"
    >
      <button
        className="-mx-2 flex min-h-control w-[calc(100%+1rem)] items-center gap-2 rounded-control px-2 text-left font-semibold text-ink outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-proof/45 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        type="button"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        )}
        <Brain className="size-3.5 text-ink-muted" aria-hidden="true" />
        Reasoning
        <span className="font-normal text-ink-muted">{summary.reasoningCount}</span>
      </button>
      {open && summary.reasoningText.length > 0 ? (
        <pre className="mt-2 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words border-y border-trace-subtle bg-control-surface p-3 font-sans text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
          {summary.reasoningText.join("\n")}
        </pre>
      ) : open ? (
        <div className="mt-2 border-t border-trace-subtle py-3 text-ink-muted">
          No reasoning text captured for this run.
        </div>
      ) : null}
    </section>
  );
}

export const ContextTruncationBlock = memo(ContextTruncationBlockComponent);
export const SearchSummaryBlock = memo(SearchSummaryBlockComponent);
export const CitationBlock = memo(CitationBlockComponent);
export const ReasoningBlock = memo(ReasoningBlockComponent);
export const ToolActivityBlock = memo(ToolActivityBlockComponent);
