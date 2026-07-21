import { searchStrategyDescription } from "@/components/app-shell/shellFormatting";
import type { ThreadArtifactSummary, ThreadSearchDetail } from "@/components/app-shell/types";
import { safeExternalHref } from "@/lib/domain/links";
import { Brain, ChevronDown, ChevronRight, Scissors, Search } from "lucide-react";
import { memo, useState } from "react";

function ContextTruncationBlockComponent({ summary }: { summary: ThreadArtifactSummary }) {
  const truncation = summary.contextTruncation;

  if (!truncation) {
    return null;
  }

  return (
    <aside
      className="mb-4 rounded-control bg-accent-amber/[0.08] px-3 py-2.5 text-xs leading-5 text-content-secondary"
      data-testid="thread-context-truncation"
      aria-label="Context trimmed"
    >
      <div className="flex items-start gap-2">
        <Scissors className="mt-0.5 size-3.5 shrink-0 text-accent-amber" aria-hidden="true" />
        <div className="min-w-0">
          <div className="font-semibold text-accent-amber">Context trimmed</div>
          <div className="mt-0.5">
            {truncation.droppedMessages === 1
              ? "The oldest message was not sent because the context window was full"
              : `The oldest ${truncation.droppedMessages} messages were not sent because the context window was full`}
            {truncation.approxDroppedTokens > 0 ? (
              <span className="font-mono text-content-primary"> · ~{truncation.approxDroppedTokens} tokens</span>
            ) : null}
          </div>
        </div>
      </div>
    </aside>
  );
}

function SearchSummaryBlockComponent({
  active = false,
  summary
}: {
  active?: boolean;
  summary: ThreadArtifactSummary;
}) {
  const strategy = summary.searchStrategy ? searchStrategyDescription(summary.searchStrategy) : "Search/tool call";
  const searchDetails = summary.searchDetails ?? [];
  const [open, setOpen] = useState(false);

  return (
    <section
      className="border-l-2 border-accent-cyan/35 pl-3 text-xs text-content-secondary"
      data-testid="thread-search-summary"
    >
      <button
        className="flex min-h-control w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 rounded-control px-2 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-cyan/55 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((expanded) => !expanded)}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
        )}
        <Search className={active ? "size-4 shrink-0 text-accent-cyan" : "size-4 shrink-0 text-content-muted"} aria-hidden="true" />
        <span className="font-semibold text-content-primary">
          {active
            ? "Searching"
            : `${summary.searchCount} search ${summary.searchCount === 1 ? "call" : "calls"}`}
        </span>
        <span className="text-content-muted">{strategy}</span>
        {summary.citationCount > 0 ? (
          <span className="text-content-muted">· {summary.citationCount} citations</span>
        ) : null}
      </button>
      {open && searchDetails.length > 0 ? (
        <div className="mt-2 grid gap-2" data-testid="thread-search-details">
          {searchDetails.map((detail, index) => (
            <div className="min-w-0 rounded-control bg-surface-thread p-3" key={index}>
              <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] text-content-muted">
                <span className="font-mono text-content-secondary">Search {index + 1}</span>
                {detail.status ? <span>{detail.status}</span> : null}
                {detail.provider || detail.modelId ? (
                  <span>{[detail.provider, detail.modelId].filter(Boolean).join(" / ")}</span>
                ) : null}
              </div>
              {detail.callPreview !== undefined && detail.requestPreview === undefined && detail.responsePreview === undefined ? (
                <div className="grid gap-1">
                  <div className="text-[11px] font-medium text-content-secondary">{searchCallLabel(detail)}</div>
                  {searchCallHasOnlyMetadata(detail.callPreview) ? (
                    <div className="rounded-control bg-surface-active px-2 py-1.5 text-content-muted">
                      OpenAI returned call metadata only for this run. Cited URLs, when available, are shown in Citations.
                    </div>
                  ) : null}
                  <pre className="max-h-52 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-canvas p-2 font-mono text-[11px] leading-5 text-content-secondary [overflow-wrap:anywhere]">
                    {formatPreview(detail.callPreview)}
                  </pre>
                </div>
              ) : (
                <div className="grid gap-2">
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-content-secondary">Request</div>
                    <pre className="max-h-52 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-canvas p-2 font-mono text-[11px] leading-5 text-content-secondary [overflow-wrap:anywhere]">
                      {formatPreview(detail.requestPreview)}
                    </pre>
                  </div>
                  <div>
                    <div className="mb-1 text-[11px] font-medium text-content-secondary">Response</div>
                    <pre className="max-h-52 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-canvas p-2 font-mono text-[11px] leading-5 text-content-secondary [overflow-wrap:anywhere]">
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
        <div className="mt-2 rounded-control bg-surface-thread px-3 py-2 text-content-muted">
          No search/tool request or response preview captured for this run.
        </div>
      ) : null}
    </section>
  );
}

function searchCallLabel(detail: ThreadSearchDetail): string {
  return detail.strategyId === "openai-native-web-search" || searchCallType(detail.callPreview) === "web_search_call"
    ? "OpenAI web search call"
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

function CitationBlockComponent({ summary }: { summary: ThreadArtifactSummary }) {
  const citations = summary.citations ?? [];
  const [open, setOpen] = useState(false);

  return (
    <section
      className="border-l-2 border-separator-strong pl-3 text-xs text-content-secondary"
      data-testid="thread-citations-block"
    >
      <button
        className="flex min-h-control w-full items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-cyan/55 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((expanded) => !expanded)}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
        )}
        <span className="font-semibold text-content-primary">Citations</span>
        <span className="text-content-muted">{summary.citationCount}</span>
      </button>
      {open && citations.length > 0 ? (
        <ol className="mt-2 space-y-2">
          {citations.map((citation) => {
            const href = safeExternalHref(citation.url);

            return (
              <li className="min-w-0 rounded-control bg-surface-thread px-3 py-2" key={`${citation.index}:${citation.url}`}>
                {href ? (
                  <a
                    className="block break-words font-medium text-content-link underline-offset-2 hover:underline [overflow-wrap:anywhere]"
                    href={href}
                    rel="noreferrer"
                    target="_blank"
                  >
                    [{citation.index}] {citation.title}
                  </a>
                ) : (
                  <div className="block break-words font-medium text-content-primary [overflow-wrap:anywhere]">
                    [{citation.index}] {citation.title}
                  </div>
                )}
                <div className="mt-0.5 break-all text-[11px] text-content-muted">{citation.url}</div>
                {citation.snippet ? (
                  <div className="mt-1 break-words text-[11px] leading-5 text-content-secondary [overflow-wrap:anywhere]">
                    {citation.snippet}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : open ? (
        <div className="mt-2 rounded-control bg-surface-thread px-3 py-2 text-content-muted">
          No citation text captured for this run.
        </div>
      ) : null}
    </section>
  );
}

function ReasoningBlockComponent({ summary }: { summary: ThreadArtifactSummary }) {
  const [open, setOpen] = useState(false);

  return (
    <section
      className="border-l-2 border-separator-strong pl-3 text-xs text-content-secondary"
      data-testid="thread-reasoning-block"
    >
      <button
        className="flex min-h-control w-full items-center gap-2 rounded-control px-2 text-left font-semibold text-content-primary outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-cyan/55 [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((expanded) => !expanded)}
      >
        {open ? (
          <ChevronDown className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
        )}
        <Brain className="size-3.5 text-content-muted" aria-hidden="true" />
        Reasoning
        <span className="font-normal text-content-muted">{summary.reasoningCount}</span>
      </button>
      {open && summary.reasoningText.length > 0 ? (
        <pre className="mt-2 max-h-48 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-surface-thread p-3 font-sans text-xs leading-5 text-content-secondary [overflow-wrap:anywhere]">
          {summary.reasoningText.join("\n")}
        </pre>
      ) : open ? (
        <div className="mt-2 rounded-control bg-surface-thread px-3 py-2 text-content-muted">
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
