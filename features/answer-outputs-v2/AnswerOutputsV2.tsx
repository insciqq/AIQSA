"use client";

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { submitMemorySourceAction } from "@/components/app-shell/memoryApi";
import {
  MEMORY_UI_LOCALE,
  formatMemoryUiCopy,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import { UiV2Button, UiV2Chip, UiV2Icon } from "@/components/ui-v2";
import type {
  ThreadArtifactSummary,
  ThreadKnowledgeAnswerState,
  ThreadKnowledgeCitation,
  ThreadSearchSource
} from "@/lib/contracts/chats";
import {
  MEMORY_STATEMENT_MAX_LENGTH,
  isSafeMemorySourceActionHref,
  type MemoryAnswerSource
} from "@/lib/contracts/memoryClient";
import { KnowledgeCitationSourceTrigger } from "@/features/citations-v2/KnowledgeCitationViewer";
import { useId, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { GeminiSearchSuggestionsV2 } from "./GeminiSearchSuggestionsV2";
import { MemoryActionConfirmationV2 } from "./MemoryActionConfirmationV2";
import { presentSearchSourcesV2 } from "./sourcePresentation";

function mt(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

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

function KnowledgeStateV2({ state }: Readonly<{ state: ThreadKnowledgeAnswerState }>) {
  const insufficient = state.answer === "insufficient_evidence";
  const partial = state.scope === "partial_sources_ready";
  if (!insufficient && !partial) return null;
  const text = insufficient && partial
    ? "The ready documents did not contain enough evidence for a supported answer; some selected documents are still processing."
    : insufficient
      ? "The selected documents did not contain enough evidence for a supported answer."
      : "Answered from the ready documents; some selected documents are still processing.";
  return (
    <p
      className="v2-knowledge-answer-state"
      data-answer={state.answer}
      data-scope={state.scope}
      role="status"
    >
      <UiV2Icon name="library" />
      <span>{text}</span>
    </p>
  );
}

function MemoryStatusV2() {
  return (
    <p className="v2-memory-answer-state" data-testid="memory-unavailable-status" role="status">
      <UiV2Icon name="memory" />
      <span>{mt("answer.unavailable")}</span>
    </p>
  );
}

function KnowledgeSourceV2({
  citation,
  index,
  reference
}: Readonly<{
  citation: ThreadKnowledgeCitation;
  index: number;
  reference?: Readonly<{ messageId: string; runId: string }>;
}>) {
  return (
    <li>
      <span className="v2-answer-source-index">{index}</span>
      <div>
        {reference ? (
          <KnowledgeCitationSourceTrigger citation={citation} reference={reference} />
        ) : <strong>{citation.deleted ? "Deleted Knowledge source" : `Knowledge source [${citation.handle}]`}</strong>}
        <small>
          {citation.deleted
            ? `${citation.handle} · citation evidence removed`
            : `${citation.handle} · open exact accepted evidence`}
        </small>
      </div>
    </li>
  );
}

function memorySourceTypeLabel(sourceType: MemoryAnswerSource["sourceType"]): string {
  switch (sourceType) {
    case "LEARNED_MEMORY": return mt("source.learnedMemory");
    case "PAST_CHAT": return mt("source.pastChat");
    case "SAVED_MEMORY": return mt("source.savedMemory");
  }
}

function memorySourceOriginLabel(source: MemoryAnswerSource): string {
  switch (source.sourceType) {
    case "LEARNED_MEMORY": return mt("source.learnedFromChat");
    case "PAST_CHAT": return "origin" in source
      ? source.origin ?? mt("source.pastChat")
      : mt("source.pastChat");
    case "SAVED_MEMORY": return mt("source.savedByYou");
  }
}

function memorySourceDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return mt("source.dateUnavailable");
  return new Intl.DateTimeFormat(MEMORY_UI_LOCALE, { dateStyle: "medium" }).format(date);
}

type MemorySourceAction = "CORRECT" | "FORGET" | "NOT_RELEVANT" | "OPEN_SOURCE";

function memorySourceActionMessage(action: Exclude<MemorySourceAction, "OPEN_SOURCE">): string {
  switch (action) {
    case "CORRECT": return mt("source.corrected");
    case "FORGET": return mt("source.forgotten");
    case "NOT_RELEVANT": return mt("source.notRelevantDone");
  }
}

function MemorySourceCard({ source }: Readonly<{ source: MemoryAnswerSource }>) {
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(source.text ?? "");
  const [pending, setPending] = useState<MemorySourceAction | null>(null);
  const [completed, setCompleted] = useState<Exclude<MemorySourceAction, "OPEN_SOURCE"> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openHref, setOpenHref] = useState<string | null>(null);
  const statementId = `memory-source-statement-${useId()}`;

  async function runAction(action: MemorySourceAction, nextStatement?: string): Promise<void> {
    if (!source.sourceAvailable || !source.memoryRef) return;
    setPending(action);
    setNotice(null);
    setError(null);
    try {
      const response = await submitMemorySourceAction(action, source.memoryRef, nextStatement);
      if (action === "OPEN_SOURCE") {
        if (response.status !== "READY") throw new Error("memory_source_response_invalid");
        if (!isSafeMemorySourceActionHref(response.href)) {
          throw new Error("memory_source_href_invalid");
        }
        setOpenHref(response.href);
        setNotice(mt("source.ready"));
      } else {
        if (response.status !== "COMMITTED") throw new Error("memory_source_response_invalid");
        if (action === "CORRECT" && nextStatement) setStatement(nextStatement);
        setCompleted(action);
        setEditing(false);
        setNotice(memorySourceActionMessage(action));
      }
    } catch {
      setError(mt("source.actionError"));
    } finally {
      setPending(null);
    }
  }

  function submitCorrection(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const nextStatement = statement.trim();
    if (!nextStatement || nextStatement.length > MEMORY_STATEMENT_MAX_LENGTH) {
      setError(formatMemoryUiCopy("action.correctionLength", {
        count: MEMORY_STATEMENT_MAX_LENGTH.toLocaleString(MEMORY_UI_LOCALE)
      }));
      return;
    }
    void runAction("CORRECT", nextStatement);
  }

  const hasAction = (action: MemorySourceAction): boolean =>
    source.sourceAvailable &&
    (source.actions as readonly MemorySourceAction[]).includes(action);
  // Every action ref is bound to the exact committed source version. Once a
  // mutation commits, leave the historical receipt readable but remove every
  // control that would replay that now-stale authority.
  const mutationDone = completed !== null;
  const sourceAvailable = source.sourceAvailable && completed !== "FORGET";

  return (
    <article className="v2-memory-source-card" data-testid="memory-source-card">
      <div className="v2-memory-source-card-heading">
        <span className="v2-memory-source-type">{memorySourceTypeLabel(source.sourceType)}</span>
        {sourceAvailable ? null : (
          <UiV2Chip tone="warn">{mt("source.unavailableLabel")}</UiV2Chip>
        )}
      </div>
      {sourceAvailable ? (
        <>
          <p className="v2-memory-source-text">{completed === "CORRECT" ? statement : source.text}</p>
          <div className="v2-memory-source-meta">
            <span>{memorySourceOriginLabel(source)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={source.date}>{memorySourceDate(source.date)}</time>
          </div>
        </>
      ) : (
        <p className="v2-memory-source-text">{mt("source.unavailableBody")}</p>
      )}
      {editing ? (
        <form className="v2-memory-source-correction" onSubmit={submitCorrection}>
          <label htmlFor={statementId}>{mt("source.correctStatement")}</label>
          <textarea
            aria-describedby={`${statementId}-help`}
            id={statementId}
            maxLength={MEMORY_STATEMENT_MAX_LENGTH}
            onChange={(event) => setStatement(event.target.value.slice(0, MEMORY_STATEMENT_MAX_LENGTH))}
            rows={3}
            value={statement}
          />
          <small id={`${statementId}-help`}>
            {statement.length.toLocaleString(MEMORY_UI_LOCALE)}/
            {MEMORY_STATEMENT_MAX_LENGTH.toLocaleString(MEMORY_UI_LOCALE)}
          </small>
          <div className="v2-memory-action-buttons">
            <UiV2Button
              busy={pending === "CORRECT"}
              disabled={pending !== null}
              type="submit"
              tone="primary"
            >
              {mt("action.saveCorrection")}
            </UiV2Button>
            <UiV2Button
              disabled={pending !== null}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              type="button"
            >
              {mt("manager.cancel")}
            </UiV2Button>
          </div>
        </form>
      ) : null}
      {!mutationDone ? (
        hasAction("CORRECT") && !editing ? (
          <div className="v2-memory-action-buttons">
            <UiV2Button
              disabled={pending !== null}
              onClick={() => {
                setStatement(source.text ?? "");
                setNotice(null);
                setError(null);
                setEditing(true);
              }}
              type="button"
            >
              {mt("source.correct")}
            </UiV2Button>
            {hasAction("FORGET") ? (
              <UiV2Button
                busy={pending === "FORGET"}
                disabled={pending !== null}
                onClick={() => void runAction("FORGET")}
                type="button"
                tone="destructive"
              >
                {mt("manager.forget")}
              </UiV2Button>
            ) : null}
            {hasAction("NOT_RELEVANT") ? (
              <UiV2Button
                busy={pending === "NOT_RELEVANT"}
                disabled={pending !== null}
                onClick={() => void runAction("NOT_RELEVANT")}
                type="button"
              >
                {mt("source.notRelevant")}
              </UiV2Button>
            ) : null}
          </div>
        ) : !editing ? (
          <div className="v2-memory-action-buttons">
            {hasAction("FORGET") ? (
              <UiV2Button
                busy={pending === "FORGET"}
                disabled={pending !== null}
                onClick={() => void runAction("FORGET")}
                type="button"
                tone="destructive"
              >
                {mt("manager.forget")}
              </UiV2Button>
            ) : null}
            {hasAction("NOT_RELEVANT") ? (
              <UiV2Button
                busy={pending === "NOT_RELEVANT"}
                disabled={pending !== null}
                onClick={() => void runAction("NOT_RELEVANT")}
                type="button"
              >
                {mt("source.notRelevant")}
              </UiV2Button>
            ) : null}
          </div>
        ) : null
      ) : null}
      {!mutationDone && hasAction("OPEN_SOURCE") ? (
        openHref ? (
          <div className="v2-memory-action-buttons">
            <a
              className="v2-memory-source-open"
              href={openHref}
              rel="noreferrer"
              target="_blank"
            >
              {mt("source.open")}
            </a>
          </div>
        ) : (
          <div className="v2-memory-action-buttons">
            <UiV2Button
              busy={pending === "OPEN_SOURCE"}
              disabled={pending !== null}
              onClick={() => void runAction("OPEN_SOURCE")}
              type="button"
            >
              {mt("source.open")}
            </UiV2Button>
          </div>
        )
      ) : null}
      {notice ? <p aria-live="polite" className="v2-memory-source-notice" role="status">{notice}</p> : null}
      {error ? <p aria-live="assertive" className="v2-memory-source-error" role="alert">{error}</p> : null}
    </article>
  );
}

function MemorySourcesV2({ sources }: Readonly<{ sources: readonly MemoryAnswerSource[] }>) {
  const headingId = `answer-memory-sources-heading-${useId()}`;
  if (sources.length === 0) return null;
  return (
    <section
      aria-labelledby={headingId}
      className="v2-memory-sources"
      data-testid="answer-memory-sources"
    >
      <h3 id={headingId}>
        {formatMemoryUiCopy("source.heading", { count: sources.length })}
      </h3>
      <div className="v2-memory-source-list">
        {sources.map((source, index) => (
          <MemorySourceCard
            key={source.sourceAvailable
              ? `memory-source-${source.memoryRef}`
              : `memory-source-${source.sourceType}-${source.date}-${index}`}
            source={source}
          />
        ))}
      </div>
    </section>
  );
}

export function SourcesV2({ artifact, knowledgeReference }: Readonly<{
  artifact: ThreadArtifactSummary;
  knowledgeReference?: Readonly<{ messageId: string; runId: string }>;
}>) {
  const presented = useMemo(
    () => presentSearchSourcesV2(answerWebSources(artifact)),
    [artifact]
  );
  const knowledge = artifact.knowledgeCitations ?? [];
  const memorySources = artifact.memorySources ?? [];
  const count = presented.sources.length + knowledge.length;
  if (count === 0 && memorySources.length === 0) return null;

  return (
    <>
      {count > 0 ? (
        <details className="v2-answer-sources" data-testid="answer-sources">
          <summary aria-label={`Sources, ${count} item${count === 1 ? "" : "s"}`}>
            <UiV2Icon name="library" />
            <span>Sources</span>
          </summary>
          <div className="v2-answer-sources-body">
            {presented.sources.length > 0 ? (
              <ol className="v2-answer-source-list">
                {presented.sources.map((source, index) => {
                  const href = safeAnswerHref(source.url);
                  return (
                    <li key={`${source.rank}:${source.url}:${index}`}>
                      <span className="v2-answer-source-index">{index + 1}</span>
                      <span>
                        {href ? (
                          <a href={href} rel="noreferrer" target="_blank">{source.title}</a>
                        ) : (
                          <span data-testid="unsafe-source-title">{source.title}</span>
                        )}
                        {source.domain && source.domain !== source.title ? (
                          <small>{source.domain}</small>
                        ) : null}
                        {source.snippet ? <small>{source.snippet}</small> : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : null}
            {knowledge.length > 0 ? (
              <ol className="v2-answer-knowledge-sources" aria-label="Knowledge sources">
                {knowledge.map((citation, index) => (
                  <KnowledgeSourceV2
                    citation={citation}
                    index={presented.sources.length + index + 1}
                    key={`${citation.handle}:${index}`}
                    reference={knowledgeReference}
                  />
                ))}
              </ol>
            ) : null}
          </div>
        </details>
      ) : null}
      <MemorySourcesV2 sources={memorySources} />
    </>
  );
}

export function ReasoningV2({ texts }: Readonly<{ texts: readonly string[] }>) {
  const content = texts.map((text) => text.trim()).filter(Boolean).join("\n\n");
  if (!content) return null;
  return (
    <details className="v2-live-reasoning" data-testid="answer-reasoning">
      <summary>Reasoning</summary>
      <div className="v2-live-reasoning-body">
        <MarkdownMessage content={content} />
      </div>
    </details>
  );
}

export function AnswerOutputsV2({
  artifact,
  identitySlot = null,
  knowledgeReference,
  onOpenMemorySettings,
  showReasoning
}: Readonly<{
  artifact: ThreadArtifactSummary | null;
  identitySlot?: ReactNode;
  knowledgeReference?: Readonly<{ messageId: string; runId: string }>;
  onOpenMemorySettings?(): void;
  showReasoning: boolean;
}>) {
  const hasSources = Boolean(
    artifact && (
      answerWebSources(artifact).length > 0 ||
      (artifact.knowledgeCitations?.length ?? 0) > 0 ||
      (artifact.memorySources?.length ?? 0) > 0
    )
  );
  const hasSuggestions = artifact?.groundingDisplay?.provider === "gemini";
  const hasReasoning = Boolean(
    artifact && showReasoning && artifact.reasoningText.some((text) => text.trim())
  );
  const hasMemoryAction = Boolean(artifact?.memoryAction);
  const hasMemoryStatus = artifact?.memoryStatus === "UNAVAILABLE";
  const hasKnowledgeState = Boolean(artifact?.knowledgeState && (
    artifact.knowledgeState.answer === "insufficient_evidence" ||
    artifact.knowledgeState.scope === "partial_sources_ready"
  ));

  if (!identitySlot && !hasSources && !hasSuggestions && !hasReasoning && !hasMemoryAction &&
    !hasMemoryStatus &&
    !hasKnowledgeState) {
    return null;
  }

  return (
    <div className="v2-answer-outputs" data-testid="answer-outputs">
      {identitySlot ? <div className="v2-answer-identity">{identitySlot}</div> : null}
      {artifact?.memoryStatus === "UNAVAILABLE" ? <MemoryStatusV2 /> : null}
      {artifact?.knowledgeState ? <KnowledgeStateV2 state={artifact.knowledgeState} /> : null}
      {artifact && hasSources ? (
        <SourcesV2 artifact={artifact} knowledgeReference={knowledgeReference} />
      ) : null}
      {artifact?.groundingDisplay?.provider === "gemini" ? (
        <GeminiSearchSuggestionsV2 html={artifact.groundingDisplay.suggestionsHtml} />
      ) : null}
      {artifact && showReasoning ? <ReasoningV2 texts={artifact.reasoningText} /> : null}
      {artifact?.memoryAction ? (
        <MemoryActionConfirmationV2
          action={artifact.memoryAction}
          onOpenMemorySettings={onOpenMemorySettings}
        />
      ) : null}
    </div>
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
  const pending = status === "pending" ||
    status === "allowing" ||
    status === "rejecting" ||
    status === "error";

  return (
    <aside className="v2-tool-approval" aria-label={`Approval required for ${serverName} ${toolName}`}>
      <div className="v2-tool-approval-heading">
        <UiV2Icon name="lock" />
        <span>
          <small>Tool approval required</small>
          <strong>{serverName} · {toolName}</strong>
        </span>
        <UiV2Chip tone={
          status === "error"
            ? "danger"
            : status === "allowed"
              ? "ok"
              : status === "rejected"
                ? "warn"
                : "neutral"
        }>
          {status}
        </UiV2Chip>
      </div>
      <p>Review the bounded, redacted preview before this server receives the request.</p>
      <details>
        <summary>Review arguments</summary>
        <pre>{preview.text}</pre>
        {preview.truncated ? <small>Preview truncated at the presentation boundary.</small> : null}
      </details>
      {error ? <p className="v2-answer-output-error" role="alert">{error}</p> : null}
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
