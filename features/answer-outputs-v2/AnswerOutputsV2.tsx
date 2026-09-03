"use client";

import { MarkdownMessage } from "@/components/chat/MarkdownMessage";
import { submitMemorySourceAction } from "@/components/app-shell/memoryApi";
import {
  MEMORY_UI_LOCALE,
  formatMemoryUiCopy,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import {
  UiV2Button,
  UiV2Chip,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuActions,
  UiV2MenuSurface,
  UiV2Monogram,
  moveMenuFocusV2,
  type UiV2MenuAction
} from "@/components/ui-v2";
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
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { GeminiSearchSuggestionsV2 } from "./GeminiSearchSuggestionsV2";
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

function MemoryStatusV2({ status }: Readonly<{
  status: NonNullable<ThreadArtifactSummary["memoryStatus"]>;
}>) {
  const limited = status === "LIMITED";
  return (
    <p
      className="v2-memory-answer-state"
      data-testid={limited ? "memory-limited-status" : "memory-unavailable-status"}
      role="status"
    >
      <UiV2Icon name="memory" />
      <span>{mt(limited ? "answer.limited" : "answer.unavailable")}</span>
    </p>
  );
}

/* Knowledge rows carry the violet handle mark and a book glyph; the only
   action is "Open document ›" because the citation projection exposes no
   private base/document name (CRITICAL_INVARIANTS §9). */
function KnowledgeSourceV2({
  citation,
  reference
}: Readonly<{
  citation: ThreadKnowledgeCitation;
  reference?: Readonly<{ messageId: string; runId: string }>;
}>) {
  return (
    <li data-kind="knowledge">
      <span className="v2-answer-source-index" data-kind="knowledge">{citation.handle}</span>
      <UiV2Icon className="v2-answer-source-glyph" name="book" />
      <span className="v2-answer-source-main">
        <strong>{citation.deleted ? "Deleted Knowledge document" : "Knowledge document"}</strong>
        <small>
          {citation.deleted
            ? "citation evidence removed"
            : "exact accepted evidence"}
        </small>
      </span>
      {reference && !citation.deleted ? (
        <KnowledgeCitationSourceTrigger citation={citation} reference={reference} />
      ) : null}
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

export function MemorySourceRowV2({ source }: Readonly<{ source: MemoryAnswerSource }>) {
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(source.text ?? "");
  const [pending, setPending] = useState<MemorySourceAction | null>(null);
  const [completed, setCompleted] = useState<Exclude<MemorySourceAction, "OPEN_SOURCE"> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openHref, setOpenHref] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const rowId = useId();
  const statementId = `memory-source-statement-${rowId}`;
  const menuId = `memory-source-menu-${rowId}`;
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    queueMicrotask(() => {
      menuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not(:disabled)")?.focus();
    });
    const dismiss = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target)) return;
      setMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [menuOpen]);

  function closeMenu({ restoreFocus = false } = {}): void {
    setMenuOpen(false);
    if (restoreFocus) queueMicrotask(() => menuButtonRef.current?.focus());
  }

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
  // One row per fact: the verbs live behind "⋯" so recall reads as a quiet
  // list; Forget keeps its destructive tone inside the menu.
  const menuActions: UiV2MenuAction[] = [
    ...(hasAction("CORRECT") ? [{
      label: mt("source.correct"),
      onSelect: () => {
        setStatement(source.text ?? "");
        setNotice(null);
        setError(null);
        setEditing(true);
      }
    }] : []),
    ...(hasAction("NOT_RELEVANT") ? [{
      label: mt("source.notRelevant"),
      onSelect: () => void runAction("NOT_RELEVANT")
    }] : []),
    ...(hasAction("FORGET") ? [{
      label: mt("manager.forget"),
      onSelect: () => void runAction("FORGET"),
      separatorBefore: true,
      tone: "destructive" as const
    }] : [])
  ];
  const showMenu = !mutationDone && !editing && menuActions.length > 0;

  return (
    <article
      className="v2-memory-source-row"
      data-settled={mutationDone || undefined}
      data-testid="memory-source-card"
    >
      <div className="v2-memory-source-line">
        <UiV2Icon
          className="v2-memory-source-glyph"
          name={source.sourceType === "PAST_CHAT" ? "chat" : "memory"}
        />
        <span className="v2-sr-only">{memorySourceTypeLabel(source.sourceType)}</span>
        <span className="v2-memory-source-main">
          <p className="v2-memory-source-text">
            {sourceAvailable
              ? completed === "CORRECT" ? statement : source.text
              : mt("source.unavailableBody")}
          </p>
          <span className="v2-memory-source-meta">
            {sourceAvailable ? (
              <>
                <span>{memorySourceOriginLabel(source)}</span>
                <span aria-hidden="true">·</span>
                <time dateTime={source.date}>{memorySourceDate(source.date)}</time>
              </>
            ) : (
              <UiV2Chip tone="warn">{mt("source.unavailableLabel")}</UiV2Chip>
            )}
          </span>
        </span>
        {!mutationDone && hasAction("OPEN_SOURCE") ? (
          openHref ? (
            <a
              className="v2-memory-source-open"
              href={openHref}
              rel="noreferrer"
              target="_blank"
            >
              {mt("source.open")}
            </a>
          ) : (
            <UiV2Button
              busy={pending === "OPEN_SOURCE"}
              disabled={pending !== null}
              onClick={() => void runAction("OPEN_SOURCE")}
              type="button"
            >
              {mt("source.open")}
            </UiV2Button>
          )
        ) : null}
        {showMenu ? (
          <span className="v2-memory-source-menu-wrap">
            <UiV2IconButton
              ref={menuButtonRef}
              aria-controls={menuOpen ? menuId : undefined}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              data-testid="memory-source-actions"
              disabled={pending !== null}
              icon="more"
              label={mt("source.actions")}
              tooltip={mt("source.actions")}
              onClick={() => setMenuOpen((open) => !open)}
            />
            {menuOpen ? (
              <UiV2MenuSurface
                ref={menuRef}
                className="v2-memory-source-menu"
                id={menuId}
                label={mt("source.actions")}
                onKeyDown={(event) => moveMenuFocusV2(event, menuRef.current, () => closeMenu({ restoreFocus: true }))}
              >
                <UiV2MenuActions actions={menuActions} onClose={() => closeMenu()} />
              </UiV2MenuSurface>
            ) : null}
          </span>
        ) : null}
      </div>
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
      {notice ? <p aria-live="polite" className="v2-memory-source-notice" role="status">{notice}</p> : null}
      {error ? <p aria-live="assertive" className="v2-memory-source-error" role="alert">{error}</p> : null}
    </article>
  );
}

export function answerSourceCountV2(artifact: ThreadArtifactSummary | null): number {
  if (!artifact) return 0;
  return answerWebSources(artifact).length + (artifact.knowledgeCitations?.length ?? 0);
}

/**
 * Sources live in the actions row: a "Sources · N" chip (a button, so it can
 * sit inside the toolbar) and the list it expands in place directly under the
 * row. Inline [n] marks keep pointing at that list; the Knowledge citation
 * viewer is unchanged. Both nodes render from one open state, so the caller
 * places them in the toolbar and after it.
 */
export function useAnswerSourcesV2({ artifact, knowledgeReference }: Readonly<{
  artifact: ThreadArtifactSummary | null;
  knowledgeReference?: Readonly<{ messageId: string; runId: string }>;
}>): Readonly<{ chip: ReactNode; list: ReactNode }> {
  const [open, setOpen] = useState(false);
  const listId = `answer-sources-${useId()}`;
  const listRef = useRef<HTMLDivElement>(null);
  const presented = useMemo(
    () => artifact ? presentSearchSourcesV2(answerWebSources(artifact)) : null,
    [artifact]
  );
  useEffect(() => {
    // The list opens under the last answer, right above the composer dock.
    if (open) listRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [open]);
  const knowledge = artifact?.knowledgeCitations ?? [];
  const count = (presented?.sources.length ?? 0) + knowledge.length;
  if (!artifact || !presented || count === 0) return { chip: null, list: null };

  return {
    chip: (
      <button
        aria-controls={open ? listId : undefined}
        aria-expanded={open}
        className="v2-answer-sources-toggle v2-focusable"
        data-testid="answer-sources-toggle"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span>Sources</span>
        <span className="v2-answer-sources-count" aria-hidden="true">· {count}</span>
        <span className="v2-sr-only">{`, ${count} item${count === 1 ? "" : "s"}`}</span>
        <span className="v2-answer-sources-chevron" aria-hidden="true" />
      </button>
    ),
    list: open ? (
      <div className="v2-answer-sources" data-testid="answer-sources" id={listId} ref={listRef}>
        {presented.sources.length > 0 ? (
          <ol className="v2-answer-source-list">
            {presented.sources.map((source, index) => {
              const href = safeAnswerHref(source.url);
              return (
                <li key={`${source.rank}:${source.url}:${index}`}>
                  <span className="v2-answer-source-index">{index + 1}</span>
                  <UiV2Monogram className="v2-answer-source-monogram" label={source.domain ?? source.title} />
                  <span className="v2-answer-source-main">
                    {href ? (
                      <a href={href} rel="noreferrer" target="_blank">{source.title}</a>
                    ) : (
                      <span data-testid="unsafe-source-title">{source.title}</span>
                    )}
                    {source.snippet ? <small className="v2-answer-source-snippet">{source.snippet}</small> : null}
                    {source.domain && source.domain !== source.title ? (
                      <small className="v2-answer-source-domain-stacked">{source.domain}</small>
                    ) : null}
                  </span>
                  {source.domain && source.domain !== source.title ? (
                    <small className="v2-answer-source-domain">{source.domain}</small>
                  ) : null}
                </li>
              );
            })}
          </ol>
        ) : null}
        {knowledge.length > 0 ? (
          <ol className="v2-answer-knowledge-sources" aria-label="Knowledge documents">
            {knowledge.map((citation, index) => (
              <KnowledgeSourceV2
                citation={citation}
                key={`${citation.handle}:${index}`}
                reference={knowledgeReference}
              />
            ))}
          </ol>
        ) : null}
      </div>
    ) : null
  };
}

/**
 * Quiet status lines between the answer body and its actions row: Memory
 * limited/unavailable, Knowledge answer state, Gemini search suggestions.
 * The process fold above the text and the Sources chip in the row own the
 * rest of the anatomy.
 */
export function AnswerOutputsV2({
  artifact
}: Readonly<{
  artifact: ThreadArtifactSummary | null;
}>) {
  const hasSuggestions = artifact?.groundingDisplay?.provider === "gemini";
  const hasMemoryStatus = artifact?.memoryStatus === "LIMITED" ||
    artifact?.memoryStatus === "UNAVAILABLE";
  const hasKnowledgeState = Boolean(artifact?.knowledgeState && (
    artifact.knowledgeState.answer === "insufficient_evidence" ||
    artifact.knowledgeState.scope === "partial_sources_ready"
  ));

  if (!artifact || (!hasSuggestions && !hasMemoryStatus && !hasKnowledgeState)) {
    return null;
  }

  return (
    <div className="v2-answer-outputs" data-testid="answer-outputs">
      {artifact.memoryStatus ? <MemoryStatusV2 status={artifact.memoryStatus} /> : null}
      {artifact.knowledgeState ? <KnowledgeStateV2 state={artifact.knowledgeState} /> : null}
      {artifact.groundingDisplay?.provider === "gemini" ? (
        <GeminiSearchSuggestionsV2 html={artifact.groundingDisplay.suggestionsHtml} />
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
