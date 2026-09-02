"use client";

import {
  MEMORY_UI_LOCALE,
  formatMemoryUiCopy,
  memoryCategoryLabel,
  memoryUiCopy
} from "@/components/app-shell/memoryUiCopy";
import { submitMemorySourceAction } from "@/components/app-shell/memoryApi";
import {
  UiV2Button,
  UiV2Chip,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuActions,
  UiV2MenuSurface,
  moveMenuFocusV2,
  type UiV2MenuAction
} from "@/components/ui-v2";
import {
  MEMORY_STATEMENT_MAX_LENGTH,
  type MemoryActionFeedback
} from "@/lib/contracts/memoryClient";
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";

type MemoryActionResultItem = NonNullable<MemoryActionFeedback["items"]>[number];

function t(key: Parameters<typeof memoryUiCopy>[0]): string {
  return memoryUiCopy(key);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return t("manager.notSet");
  return new Intl.DateTimeFormat(MEMORY_UI_LOCALE, { dateStyle: "medium" }).format(date);
}

function provenanceLabel(item: MemoryActionResultItem): string {
  return item.provenance === "SAVED"
    ? t("manager.savedByYou")
    : t("manager.learnedFromChat");
}

function statusLabel(action: MemoryActionFeedback): string {
  switch (action.status) {
    case "COMMITTED": return t("action.statusDone");
    case "COMPLETE": return t("action.statusReady");
    case "AMBIGUOUS": return t("action.statusNeedsChoice");
    case "CONFIRMATION_REQUIRED": return t("action.statusConfirmation");
    case "REJECTED": return t("action.statusNotApplied");
    case "THIS_CHAT_ONLY": return t("action.statusThisChat");
  }
}

function statusTone(action: MemoryActionFeedback): "danger" | "neutral" | "ok" | "warn" {
  switch (action.status) {
    case "COMMITTED":
    case "COMPLETE":
      return "ok";
    case "THIS_CHAT_ONLY":
      return "neutral";
    case "REJECTED":
      return "danger";
    case "AMBIGUOUS":
    case "CONFIRMATION_REQUIRED":
      return "warn";
  }
}

function statusMessage(action: MemoryActionFeedback): string {
  switch (action.status) {
    case "COMMITTED":
      return action.operation === "SAVE"
        ? t("action.saved")
        : action.operation === "UPDATE"
          ? t("action.updated")
          : t("action.forgotten");
    case "COMPLETE":
      return action.operation === "LIST"
        ? t("action.listComplete")
        : t("action.searchComplete");
    case "AMBIGUOUS":
      return t("action.ambiguousGuidance");
    case "CONFIRMATION_REQUIRED":
      return t("action.resetConfirmation");
    case "REJECTED":
      return t("action.rejected");
    case "THIS_CHAT_ONLY":
      return t("action.thisChatOnly");
  }
}

function Statement({ statement }: Readonly<{ statement?: string }>) {
  if (!statement) return null;
  return (
    <blockquote data-testid="memory-action-statement">“{statement}”</blockquote>
  );
}

function MemoryResultItem({
  action,
  candidate,
  index,
  item
}: Readonly<{
  candidate?: boolean;
  action?: ReactNode;
  index: number;
  item: MemoryActionResultItem;
}>) {
  return (
    <li className="v2-memory-action-result" data-testid={candidate ? "memory-action-candidate" : "memory-action-item"}>
      <p>{item.statement}</p>
      <div className="v2-memory-action-result-meta">
        <span>{provenanceLabel(item)}</span>
        <span aria-hidden="true">·</span>
        <span>{memoryCategoryLabel(item.category)}</span>
        <span aria-hidden="true">·</span>
        <span>{formatDate(item.createdAt)}</span>
      </div>
      <span className="sr-only">
        {formatMemoryUiCopy(candidate ? "action.matchIndex" : "action.memoryIndex", {
          index: index + 1
        })}
      </span>
      {action}
    </li>
  );
}

function ResultItems({
  items,
  operation
}: Readonly<{
  items: readonly MemoryActionResultItem[];
  operation: "LIST" | "SEARCH";
}>) {
  if (items.length === 0) {
    return <p>{operation === "LIST" ? t("manager.empty") : t("manager.noResults")}</p>;
  }
  return (
    <ul aria-label={operation === "LIST" ? t("action.listComplete") : t("action.searchComplete")} className="v2-memory-action-results">
      {items.map((item, index) => (
        <MemoryResultItem index={index} item={item} key={`${item.createdAt}:${index}`} />
      ))}
    </ul>
  );
}

function CandidateItems({
  action,
  candidates,
  completedRef,
  onChoose,
  pendingRef
}: Readonly<{
  action: "FORGET" | "UPDATE";
  candidates: readonly MemoryActionResultItem[];
  completedRef: string | null;
  onChoose(item: MemoryActionResultItem): void;
  pendingRef: string | null;
}>) {
  return (
    <>
      <p className="v2-memory-action-guidance">{t("action.ambiguousNoAction")}</p>
      <ul aria-label={t("action.matchesHeading")} className="v2-memory-action-results">
        {candidates.map((item, index) => (
          <MemoryResultItem
            action={(
              <UiV2Button
                busy={pendingRef === item.memoryRef}
                disabled={pendingRef !== null || completedRef !== null}
                onClick={() => onChoose(item)}
                tone={action === "FORGET" ? "destructive" : "primary"}
                type="button"
              >
                {t(action === "FORGET" ? "action.forgetCandidate" : "action.updateCandidate")}
              </UiV2Button>
            )}
            candidate
            index={index}
            item={item}
            key={item.memoryRef}
          />
        ))}
      </ul>
    </>
  );
}

function actionIdentity(action: MemoryActionFeedback): string {
  return JSON.stringify(action);
}

function MemoryActionConfirmationContent({
  action,
  onOpenMemorySettings
}: Readonly<{
  action: MemoryActionFeedback;
  onOpenMemorySettings?(): void;
}>) {
  const headingId = useId();
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(action.statement ?? "");
  const [pendingRef, setPendingRef] = useState<string | null>(null);
  const [completedRef, setCompletedRef] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function mutate(
    memoryRef: string,
    operation: "FORGET" | "UPDATE",
    replacement?: string
  ): Promise<void> {
    setPendingRef(memoryRef);
    setError(null);
    setNotice(null);
    try {
      const response = await submitMemorySourceAction(
        operation === "UPDATE" ? "CORRECT" : "FORGET",
        memoryRef,
        replacement
      );
      if (response.status !== "COMMITTED") throw new Error("memory_response_invalid");
      setCompletedRef(memoryRef);
      setEditing(false);
      setNotice(t(operation === "UPDATE" ? "action.updated" : "action.forgotten"));
    } catch {
      setError(t("action.mutationError"));
    } finally {
      setPendingRef(null);
    }
  }

  function submitEdit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const replacement = statement.trim();
    if (!action.memoryRef || !replacement ||
      replacement.length > MEMORY_STATEMENT_MAX_LENGTH) {
      setError(formatMemoryUiCopy("action.correctionLength", {
        count: MEMORY_STATEMENT_MAX_LENGTH.toLocaleString(MEMORY_UI_LOCALE)
      }));
      return;
    }
    void mutate(action.memoryRef, "UPDATE", replacement);
  }

  const committedEditable = action.status === "COMMITTED" &&
    (action.operation === "SAVE" || action.operation === "UPDATE") &&
    Boolean(action.memoryRef && action.statement);
  // A committed save/update/forget is a one-line notice under the process
  // line ("Memory saved." · statement · "⋯"), like ChatGPT's "Memory updated";
  // lists, searches and choices keep a card built from the same rows.
  const committedNotice = action.status === "COMMITTED" &&
    (action.operation === "SAVE" || action.operation === "UPDATE" || action.operation === "FORGET");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuId = `${headingId}-menu`;

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

  const editForm = committedEditable && editing ? (
    <form className="v2-memory-source-correction" onSubmit={submitEdit}>
      <label htmlFor={`${headingId}-statement`}>{t("action.correctMemory")}</label>
      <textarea
        id={`${headingId}-statement`}
        maxLength={MEMORY_STATEMENT_MAX_LENGTH}
        onChange={(event) => setStatement(event.target.value)}
        rows={3}
        value={statement}
      />
      <div className="v2-memory-action-buttons">
        <UiV2Button
          busy={pendingRef === action.memoryRef}
          disabled={pendingRef !== null}
          tone="primary"
          type="submit"
        >
          {t("action.saveCorrection")}
        </UiV2Button>
        <UiV2Button
          disabled={pendingRef !== null}
          onClick={() => setEditing(false)}
          type="button"
        >
          {t("manager.cancel")}
        </UiV2Button>
      </div>
    </form>
  ) : null;

  if (committedNotice) {
    const menuActions: UiV2MenuAction[] = [
      ...(committedEditable && completedRef === null ? [
        {
          icon: "edit" as const,
          label: t("manager.edit"),
          onSelect: () => {
            setStatement(action.statement ?? "");
            setError(null);
            setEditing(true);
          }
        },
        {
          icon: "trash" as const,
          label: t("manager.forget"),
          onSelect: () => void mutate(action.memoryRef!, "FORGET"),
          tone: "destructive" as const
        }
      ] : []),
      ...(onOpenMemorySettings ? [{
        icon: "memory" as const,
        label: t("action.manage"),
        onSelect: onOpenMemorySettings,
        separatorBefore: true
      }] : [])
    ];
    const showMenu = !editing && menuActions.length > 0 && action.operation !== "FORGET";
    return (
      <section
        aria-labelledby={headingId}
        className="v2-memory-notice"
        data-testid="memory-action-confirmation"
        role="region"
      >
        <div className="v2-memory-notice-line">
          <UiV2Icon name="check" />
          <p aria-live="polite" id={headingId} role="status">{statusMessage(action)}</p>
          {action.statement && action.operation !== "FORGET" ? (
            <blockquote data-testid="memory-action-statement">“{action.statement}”</blockquote>
          ) : null}
          {showMenu ? (
            <span className="v2-memory-source-menu-wrap">
              <UiV2IconButton
                ref={menuButtonRef}
                aria-controls={menuOpen ? menuId : undefined}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                data-testid="memory-action-menu"
                disabled={pendingRef !== null}
                icon="more"
                label={t("source.actions")}
                tooltip={t("source.actions")}
                onClick={() => setMenuOpen((open) => !open)}
              />
              {menuOpen ? (
                <UiV2MenuSurface
                  ref={menuRef}
                  className="v2-memory-source-menu"
                  id={menuId}
                  label={t("source.actions")}
                  onKeyDown={(event) => moveMenuFocusV2(event, menuRef.current, () => closeMenu({ restoreFocus: true }))}
                >
                  <UiV2MenuActions actions={menuActions} onClose={() => closeMenu()} />
                </UiV2MenuSurface>
              ) : null}
            </span>
          ) : null}
        </div>
        {editForm}
        {notice ? <p aria-live="polite" role="status">{notice}</p> : null}
        {error ? <p aria-live="assertive" role="alert">{error}</p> : null}
      </section>
    );
  }

  return (
    <section
      aria-labelledby={headingId}
      className="v2-memory-action-confirmation"
      data-testid="memory-action-confirmation"
      role="region"
    >
      <UiV2Icon name="check" />
      <div>
        <div className="v2-memory-action-heading">
          <p
            aria-live="polite"
            className={action.status === "REJECTED" ? "v2-memory-action-error" : undefined}
            id={headingId}
            role="status"
          >
            {statusMessage(action)}
          </p>
          <UiV2Chip tone={statusTone(action)}>{statusLabel(action)}</UiV2Chip>
        </div>
        {action.status === "COMPLETE" && (action.operation === "LIST" || action.operation === "SEARCH") ? (
          <ResultItems items={action.items ?? []} operation={action.operation} />
        ) : action.status === "AMBIGUOUS" ? (
          <CandidateItems
            action={action.operation === "FORGET" ? "FORGET" : "UPDATE"}
            candidates={action.candidates ?? []}
            completedRef={completedRef}
            onChoose={(item) => void mutate(
              item.memoryRef,
              action.operation === "FORGET" ? "FORGET" : "UPDATE",
              action.operation === "UPDATE" ? action.statement : undefined
            )}
            pendingRef={pendingRef}
          />
        ) : (
          <Statement statement={action.status === "REJECTED" ? undefined : action.statement} />
        )}
        {action.status === "CONFIRMATION_REQUIRED" && action.operation === "RESET" &&
          onOpenMemorySettings ? (
            <div className="v2-memory-action-buttons">
              <UiV2Button onClick={onOpenMemorySettings} tone="primary" type="button">
                {t("action.reviewReset")}
              </UiV2Button>
            </div>
          ) : null}
        {notice ? <p aria-live="polite" role="status">{notice}</p> : null}
        {error ? <p aria-live="assertive" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}

export function MemoryActionConfirmationV2(props: Readonly<{
  action: MemoryActionFeedback;
  onOpenMemorySettings?(): void;
}>) {
  return (
    <MemoryActionConfirmationContent
      {...props}
      key={actionIdentity(props.action)}
    />
  );
}
