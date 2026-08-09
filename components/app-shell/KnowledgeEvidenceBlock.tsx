import type { PersistedRun, ThreadArtifactSummary } from "@/components/app-shell/types";
import type { KnowledgeRunProjection } from "@/lib/contracts/runs";
import { BookOpen, ChevronDown, ChevronRight, ExternalLink, LoaderCircle } from "lucide-react";

function outcomeLabel(outcome: KnowledgeRunProjection["outcome"]): string {
  if (outcome === "complete") return "Retrieved evidence";
  if (outcome === "zero_above_threshold") return "No passage above threshold";
  if (outcome === "base_empty") return "Selected base is empty";
  if (outcome === "base_indexing") return "Selected base is still indexing";
  return "Embedding model unavailable";
}

function outcomeTone(outcome: KnowledgeRunProjection["outcome"]): string {
  return outcome === "complete" ? "text-positive" : "text-caution";
}

function versionLabel(value: number | undefined | null): string {
  return value ? `version ${value}` : "historical version";
}

function InvocationReceipt({ receipt }: { receipt: KnowledgeRunProjection }) {
  return (
    <details className="group border-t border-trace-subtle py-2" data-testid="knowledge-invocation">
      <summary className="flex min-h-control cursor-pointer list-none items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch">
        <ChevronRight className="size-3.5 shrink-0 text-ink-muted group-open:rotate-90" aria-hidden="true" />
        <span className="font-semibold text-ink">Invocation {receipt.invocationOrdinal}</span>
        <span className={outcomeTone(receipt.outcome)}>· {outcomeLabel(receipt.outcome)}</span>
        <span className="ml-auto hidden shrink-0 font-mono text-metadata text-ink-muted sm:inline">
          {receipt.results.length}/{receipt.candidateCount} passages · {receipt.durationMs} ms
        </span>
      </summary>
      <div className="grid gap-4 px-2 pb-3 pl-7 pt-2">
        <div>
          <div className="text-metadata font-semibold uppercase tracking-wide text-ink-muted">Generated query</div>
          <div className="mt-1 break-words rounded-control bg-control-surface px-3 py-2 font-mono text-xs text-ink [overflow-wrap:anywhere]">
            {receipt.query}
          </div>
        </div>
        <dl className="grid gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <div><dt className="text-ink-muted">Candidates</dt><dd className="font-mono text-ink">{receipt.candidateCount} / {receipt.candidateLimit}</dd></div>
          <div><dt className="text-ink-muted">Included</dt><dd className="font-mono text-ink">{receipt.results.length} / {receipt.resultLimit}</dd></div>
          <div><dt className="text-ink-muted">Threshold</dt><dd className="font-mono text-ink">{receipt.threshold}</dd></div>
          <div><dt className="text-ink-muted">Duration</dt><dd className="font-mono text-ink">{receipt.durationMs} ms</dd></div>
        </dl>
        <div>
          <div className="text-metadata font-semibold uppercase tracking-wide text-ink-muted">Base snapshot</div>
          <ol className="mt-1 divide-y divide-trace-subtle border-y border-trace-subtle">
            {receipt.baseEvidence.map((base) => (
              <li className="grid gap-1 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]" key={`${base.ordinal}:${base.knowledgeBaseId}`}>
                <span className="min-w-0 break-words font-medium text-ink">{base.ordinal + 1}. {base.baseName}</span>
                <span className="font-mono text-ink-muted">content {base.baseContentRevision} · indexed {base.indexedContentRevision}</span>
                <span className="text-ink-muted">{base.state}</span>
                <span className="font-mono text-ink-muted">{base.candidateCount} candidates</span>
              </li>
            ))}
          </ol>
        </div>
        {receipt.results.length > 0 ? (
          <div>
            <div className="text-metadata font-semibold uppercase tracking-wide text-ink-muted">Scored retrieved set and exact included text</div>
            <ol className="mt-1 space-y-3">
              {receipt.results.map((result) => (
                <li className="border-l-2 border-proof/45 pl-3" key={result.handle}>
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs">
                    <span className="font-mono font-semibold text-proof">[{result.handle}]</span>
                    <span className="break-words font-semibold text-ink [overflow-wrap:anywhere]">{result.fileName}</span>
                    <span className="text-ink-muted">{versionLabel(result.documentVersionNumber)} · page {result.page}</span>
                    <span className="font-mono text-ink-muted">score {result.fusedScore.toFixed(6)}</span>
                  </div>
                  <p className="mt-0.5 text-metadata text-ink-muted">{result.baseName}</p>
                  <pre className="mt-2 max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-control bg-control-surface p-3 font-sans text-xs leading-5 text-ink-secondary [overflow-wrap:anywhere]">{result.includedText}</pre>
                  <p className="mt-1 font-mono text-metadata text-ink-muted">
                    {result.includedTextBytes}/{result.sourceTextBytes} bytes included
                    {result.textTruncated ? " · truncated at the persisted inclusion boundary" : " · complete passage"}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        ) : (
          <div className="border-l-2 border-caution/45 bg-caution/[0.05] px-3 py-2 text-xs text-ink-secondary">
            <span className="font-semibold text-caution">{outcomeLabel(receipt.outcome)}</span>
            <span> · no answer passage was included by this invocation.</span>
          </div>
        )}
      </div>
    </details>
  );
}

export function KnowledgeEvidenceBlock({
  expanded,
  loading,
  onExpandedChange,
  onOpenEvidence,
  persistedRun,
  showCitations,
  summary
}: Readonly<{
  expanded: boolean;
  loading: boolean;
  onExpandedChange(expanded: boolean): void;
  onOpenEvidence(knowledgeBaseId: string): void;
  persistedRun: PersistedRun | null;
  showCitations: boolean;
  summary: ThreadArtifactSummary;
}>) {
  const citations = summary.knowledgeCitations ?? [];
  const outcomes = summary.knowledgeOutcomes ?? [];
  const invocationCount = summary.knowledgeInvocationCount ?? outcomes.length;
  const exactReceipts = persistedRun?.knowledgeRuns ?? [];
  const outcomeSummary = outcomes.length > 0
    ? outcomes.map((outcome) => outcomeLabel(outcome.outcome)).join("; ")
    : "Receipt available";

  return (
    <section className="border-t border-trace-subtle pt-2 text-xs text-ink-secondary" data-testid="thread-knowledge-evidence" aria-label="Knowledge evidence">
      {showCitations && citations.length > 0 ? (
        <div className="mb-3 border-b border-trace-subtle pb-3" data-testid="knowledge-citations">
          <div className="mb-1.5 flex items-center gap-2 font-semibold text-ink">
            <BookOpen className="size-3.5 text-proof" aria-hidden="true" />
            Knowledge sources · {citations.length}
          </div>
          <ol className="grid gap-1.5 sm:grid-cols-2">
            {citations.map((citation) => (
              <li className="min-w-0" key={`${citation.handle}:${citation.knowledgeBaseId}`}>
                <button
                  className="flex min-h-touch w-full items-start gap-2 rounded-control bg-control-surface px-3 py-2 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus"
                  onClick={() => onOpenEvidence(citation.knowledgeBaseId)}
                  title={`Open ${citation.baseName} evidence detail`}
                  type="button"
                >
                  <span className="font-mono font-semibold text-proof">[{citation.handle}]</span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words font-medium text-ink [overflow-wrap:anywhere]">{citation.fileName}</span>
                    <span className="mt-0.5 block text-metadata text-ink-muted">{citation.baseName} · {versionLabel(citation.documentVersionNumber)} · page {citation.page}</span>
                  </span>
                  <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
                </button>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      <button
        aria-expanded={expanded}
        aria-label={`Knowledge ${invocationCount} ${invocationCount === 1 ? "invocation" : "invocations"}. ${outcomeSummary}`}
        className="-mx-2 flex min-h-control w-[calc(100%+1rem)] items-center gap-2 rounded-control px-2 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
        onClick={() => onExpandedChange(!expanded)}
        type="button"
      >
        {expanded ? <ChevronDown className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" /> : <ChevronRight className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />}
        <BookOpen className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="font-semibold text-ink">Knowledge</span>
        <span className="text-ink-muted">{invocationCount} {invocationCount === 1 ? "invocation" : "invocations"}</span>
        <span className="min-w-0 truncate text-ink-muted">· {outcomeSummary}</span>
      </button>
      {expanded ? (
        <div className="mt-2 border-b border-trace-subtle" data-testid="thread-knowledge-details">
          {loading ? (
            <p className="flex items-center gap-2 px-2 py-4 text-ink-muted" role="status"><LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> Loading exact persisted receipt…</p>
          ) : exactReceipts.length > 0 ? (
            exactReceipts.map((receipt) => <InvocationReceipt key={receipt.id} receipt={receipt} />)
          ) : (
            <ol className="space-y-1 px-2 py-3">
              {outcomes.map((outcome) => <li key={outcome.invocationOrdinal}>Invocation {outcome.invocationOrdinal}: <span className={outcomeTone(outcome.outcome)}>{outcomeLabel(outcome.outcome)}</span></li>)}
            </ol>
          )}
        </div>
      ) : null}
    </section>
  );
}
