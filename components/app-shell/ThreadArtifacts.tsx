import { searchStrategyDescription } from "@/components/app-shell/shellFormatting";
import type {
  ThreadArtifactSummary,
  ThreadSearchExecution,
  ThreadSearchProviderOperation,
  ThreadSearchDetail,
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
  embedded = false,
  expanded,
  onExpandedChange,
  summary
}: DisclosureControl & {
  active?: boolean;
  embedded?: boolean;
  summary: ThreadArtifactSummary;
}) {
  const strategy = summary.searchDisplayName?.trim() ||
    (summary.searchStrategy ? searchStrategyDescription(summary.searchStrategy) : "Search/tool call");
  const searchDetails = summary.searchDetails ?? [];
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
      data-testid="thread-search-summary"
      aria-label={
        embedded
          ? `${summary.searchCount} search ${summary.searchCount === 1 ? "call" : "calls"} details`
          : undefined
      }
    >
      {!embedded ? (
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
          <span className="font-semibold text-ink">
            {active
              ? "Searching"
              : `${summary.searchCount} search ${summary.searchCount === 1 ? "call" : "calls"}`}
          </span>
          <span className="text-ink-muted">{strategy}</span>
          {summary.citationCount > 0 ? (
            <span className="text-ink-muted">· {summary.citationCount} citations</span>
          ) : null}
        </button>
      ) : null}
      {open && searchDetails.length > 0 ? (
        <div
          className={
            embedded
              ? "divide-y divide-trace-subtle"
              : "mt-2 divide-y divide-trace-subtle border-y border-trace-subtle"
          }
          data-testid="thread-search-details"
        >
          {searchDetails.map((detail, index) => (
            <div className="min-w-0 py-3" key={index}>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                <span className="font-mono text-ink-secondary">Search {index + 1}</span>
                {detail.status ? <span>{detail.status}</span> : null}
                {summary.searchDisplayName?.trim() ? (
                  <span>Search ran inside {summary.searchDisplayName.trim()}.</span>
                ) : detail.provider || detail.modelId ? (
                  <span>Search ran inside the answer provider.</span>
                ) : null}
              </div>
              {detail.callPreview !== undefined && detail.requestPreview === undefined && detail.responsePreview === undefined ? (
                <div className="grid gap-1">
                  <div className="text-xs font-medium text-ink-secondary">{searchCallLabel(detail)}</div>
                  {searchCallHasOnlyMetadata(detail.callPreview) ? (
                    <div className="border-l-2 border-trace-subtle px-2 py-1 text-ink-muted">
                      The Search source returned call metadata only for this run. Cited URLs, when available, are shown in Citations.
                    </div>
                  ) : null}
                  <pre className="max-h-52 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-control-surface p-2 font-mono text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
                    {formatPreview(detail.callPreview)}
                  </pre>
                </div>
              ) : (
                <div className="grid gap-2">
                  <div>
                    <div className="mb-1 text-xs font-medium text-ink-secondary">Request</div>
                    <pre className="max-h-52 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-control-surface p-2 font-mono text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
                      {formatPreview(detail.requestPreview)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-xs font-medium text-ink-secondary">Response</div>
                    <pre className="max-h-52 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-control-surface p-2 font-mono text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">
                      {formatPreview(detail.responsePreview)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : null}
      {open && searchDetails.length === 0 ? (
        <div
          className={
            embedded
              ? "py-3 text-ink-muted"
              : "mt-2 border-t border-trace-subtle py-3 text-ink-muted"
          }
        >
          No search/tool request or response preview captured for this run.
        </div>
      ) : null}
    </section>
  );
}

function searchCallLabel(detail: ThreadSearchDetail): string {
  return searchCallType(detail.callPreview) === "web_search_call"
    ? "Web search call"
    : "Search call";
}

function searchCallHasOnlyMetadata(callPreview: unknown): boolean {
  if (typeof callPreview !== "object" || callPreview === null || Array.isArray(callPreview)) {
    return false;
  }

  const record = callPreview as Record<string, unknown>;
  return record.type === "web_search_call" && !searchCallActionHasContent(record.action);
}

function searchCallType(callPreview: unknown): string | null {
  return typeof callPreview === "object" &&
    callPreview !== null &&
    !Array.isArray(callPreview) &&
    typeof (callPreview as Record<string, unknown>).type === "string"
    ? ((callPreview as Record<string, unknown>).type as string)
    : null;
}

function searchCallActionHasContent(action: unknown): boolean {
  if (typeof action !== "object" || action === null || Array.isArray(action)) {
    return false;
  }

  return Object.entries(action).some(([key, value]) => key !== "type" && hasPreviewValue(value));
}

function hasPreviewValue(value: unknown): boolean {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  if (Array.isArray(value)) {
    return value.some(hasPreviewValue);
  }

  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(hasPreviewValue);
  }

  return value !== undefined && value !== null;
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

function searchExecutionStatusLabel(status: ThreadSearchExecution["status"]): string {
  return status === "complete" ? "Completed" : "Failed";
}

function providerOperationLabel(kind: ThreadSearchProviderOperation["kind"]): string {
  if (kind === "search") return "Web search";
  if (kind === "open_page") return "Open page";
  if (kind === "find_in_page") return "Find in page";
  return "Provider operation";
}

function providerOperationStatusLabel(status: ThreadSearchProviderOperation["status"]): string {
  if (status === "complete") return "Completed";
  if (status === "error") return "Failed";
  if (status === "running") return "Running";
  return "Status unavailable";
}

function SearchProviderOperationRow({
  operation
}: Readonly<{ operation: ThreadSearchProviderOperation }>) {
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
      {operation.url ? (
        <p className="mt-1 break-all font-mono text-[11px] leading-5 text-ink-muted">
          {operation.url}
        </p>
      ) : null}
      {operation.pattern ? (
        <p className="mt-1 break-words font-mono text-[11px] leading-5 text-ink-secondary [overflow-wrap:anywhere]">
          Pattern: {operation.pattern}
        </p>
      ) : null}
    </li>
  );
}

function SearchExecutionDisclosure({
  execution,
  index
}: Readonly<{ execution: ThreadSearchExecution; index: number }>) {
  const operations = execution.providerOperations;
  return (
    <details className="group/search py-2" data-search-execution-status={execution.status}>
      <summary className="-mx-2 flex min-h-control cursor-pointer list-none flex-wrap items-center gap-2 rounded-control px-2 outline-none marker:hidden hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-proof/45">
        <Search className="size-3.5 shrink-0 text-proof" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words font-medium text-ink [overflow-wrap:anywhere]">
          {execution.displayName}
        </span>
        <span className={execution.status === "error" ? "text-critical" : "text-ink-muted"}>
          {searchExecutionStatusLabel(execution.status)}
        </span>
        {execution.sourceCount > 0 ? (
          <span className="text-ink-muted">
            {execution.sourceCount} {execution.sourceCount === 1 ? "source" : "sources"}
          </span>
        ) : null}
        {toolDuration(execution.durationMs) ? (
          <span className="font-mono text-ink-muted">{toolDuration(execution.durationMs)}</span>
        ) : null}
        <ChevronRight className="size-3.5 shrink-0 text-ink-muted transition-transform group-open/search:rotate-90" aria-hidden="true" />
      </summary>
      <div className="mt-2 grid gap-3 border-l border-trace-subtle pl-3" data-testid="thread-search-execution-details">
        <div className="flex flex-wrap gap-x-2 gap-y-1 text-ink-muted">
          <span>Search {index + 1}</span>
          <span>Only the generated search query was sent to {execution.displayName}.</span>
        </div>
        <div>
          <div className="mb-1 font-medium text-ink-secondary">Engine query</div>
          {execution.query ? (
            <div className="break-words rounded-control bg-control-surface px-2 py-1.5 font-mono text-[11px] leading-5 text-ink [overflow-wrap:anywhere]">
              {execution.query}
            </div>
          ) : (
            <p className="text-ink-muted">No engine query was captured.</p>
          )}
        </div>
        <div>
          <div className="font-medium text-ink-secondary">
            Provider operations{operations && operations.length > 0
              ? ` · ${operations.length}${execution.providerOperationsTruncated ? "+" : ""}`
              : execution.providerOperationsTruncated
                ? " · additional activity omitted"
                : ""}
          </div>
          {operations === null ? (
            <p className="mt-1 text-ink-muted">Provider operation details are unavailable for this run.</p>
          ) : operations.length === 0 ? (
            <p className="mt-1 text-ink-muted">
              {execution.providerOperationsTruncated
                ? "Provider activity exceeded the inspection limit; detailed operations were omitted."
                : "Provider reported no internal web-search operations."}
            </p>
          ) : (
            <>
              <ol className="mt-1 divide-y divide-trace-subtle">
                {operations.map((operation) => (
                  <SearchProviderOperationRow
                    key={operation.id ?? `${operation.ordinal}:${operation.kind}`}
                    operation={operation}
                  />
                ))}
              </ol>
              {execution.providerOperationsTruncated ? (
                <p className="mt-1 text-ink-muted">
                  Additional provider operations were omitted by the inspection limit.
                </p>
              ) : null}
            </>
          )}
        </div>
        {execution.warning ? (
          <p className="break-words text-critical [overflow-wrap:anywhere]">{execution.warning}</p>
        ) : null}
      </div>
    </details>
  );
}

function ToolActivityBlockComponent({
  expanded,
  onExpandedChange,
  summary
}: DisclosureControl & { summary: ThreadArtifactSummary }) {
  const calls = summary.toolCalls;
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
                      {call.searchExecutions && call.searchExecutions.length > 0 ? (
                        <section data-testid="thread-tool-search-executions" aria-label="Search executions">
                          <div className="mb-1 font-medium text-ink-secondary">
                            Search executions · {call.searchExecutions.length}
                          </div>
                          <div className="divide-y divide-trace-subtle border-y border-trace-subtle">
                            {call.searchExecutions.map((execution, index) => (
                              <SearchExecutionDisclosure
                                execution={execution}
                                index={index}
                                key={`${execution.optionId}:${index}`}
                              />
                            ))}
                          </div>
                        </section>
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
