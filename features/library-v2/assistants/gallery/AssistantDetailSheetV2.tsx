"use client";

import {
  assistantCardState,
  type AssistantDetailSheetView,
  type AssistantGalleryView,
  type LibraryNotice
} from "@/components/assistants/libraryViewContracts";
import { UiV2Button, UiV2Icon, type UiV2IconName } from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import { assistantCardStatusText } from "@/features/library-v2/assistantAvailabilityCopy";
import type { AssistantDetail, AssistantRowKey, AssistantSummary } from "@/lib/contracts/assistants";
import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { AssistantActionsMenuV2 } from "./AssistantActionsMenuV2";
import { AssistantGalleryNoticeV2 } from "./AssistantGalleryV2";
import {
  assistantCategoryLabel,
  assistantDetailMeta,
  assistantDetailRows,
  assistantInstructionsFirstLine,
  assistantInstructionsPreview,
  assistantListingStatusText,
  assistantProjectsText
} from "./assistantDetailCopy";
import "../assistants.css";

/** The one neutral text for an Assistant the viewer cannot open, missing or not. */
export const ASSISTANT_NOT_AVAILABLE_TEXT = "This Assistant isn't available to you.";

const rowIcons: Readonly<Record<AssistantRowKey, UiV2IconName>> = {
  controls: "sliders",
  knowledge: "book",
  model: "layers",
  search: "globe",
  skills: "wand",
  tools: "plug"
};

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function Section({ children, title }: Readonly<{ children: ReactNode; title: string }>) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="v2-assistants-detail-section">
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/**
 * The Sharing section's audience line, from the same detail fields as the
 * header: the owner reads every audience, any other viewer (a Project member
 * included) only how the Assistant reaches them.
 */
function sharingAudience(detail: Pick<AssistantDetail, "audience" | "owned" | "scope">): string | null {
  if (detail.owned) {
    const parts = [
      detail.audience?.everyone ? "Everyone in this installation" : null,
      detail.audience?.groupNames.length ? `Groups: ${detail.audience.groupNames.join(", ")}` : null
    ].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : "Only you";
  }
  const scope = detail.scope;
  if (scope.kind === "installation") return "Everyone in this installation";
  if (scope.kind === "group") return `Shared with ${scope.groupNames.join(", ")}`;
  if (scope.kind === "project") return `Project “${scope.projectName}”`;
  return null;
}

function InstructionsSection({ detail, initialOpen }: Readonly<{ detail: AssistantDetail; initialOpen: boolean }>) {
  const [open, setOpen] = useState(initialOpen);
  const previewId = useId();
  // Rendered once per open sheet, in the browser's time zone.
  const preview = useMemo(
    () => assistantInstructionsPreview(detail.content, { now: new Date(), timeZone: browserTimeZone() }),
    [detail.content]
  );
  return (
    <Section title="Instructions">
      <div className="v2-assistants-instructions">
        <div>
          {/* The full text below replaces the cut first line while it is open. */}
          {open ? null : <p className="v2-assistants-instructions-line">{assistantInstructionsFirstLine(preview)}</p>}
          <p className="v2-assistants-instructions-note">
            {detail.owned
              ? "Visible to everyone who can use the Assistant. Only you can edit."
              : "Visible to everyone who can use the Assistant. Only its owner can edit."}
          </p>
        </div>
        <UiV2Button aria-controls={previewId} aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          {open ? "Hide" : "View"}
        </UiV2Button>
      </div>
      <pre
        aria-label="Instructions preview"
        className="v2-assistants-instructions-preview"
        hidden={!open}
        id={previewId}
        tabIndex={open ? 0 : -1}
      >
        {open ? preview : null}
      </pre>
    </Section>
  );
}

function DetailBody({
  busy,
  detail,
  gallery,
  initialPreviewOpen,
  listed,
  names,
  onCopied,
  onStartWithStarter,
  summary
}: Readonly<{
  busy: boolean;
  detail: AssistantDetail;
  gallery: AssistantGalleryView;
  initialPreviewOpen: boolean;
  /** In the viewer's list: pin and duplicate work; a Project member's read has neither. */
  listed: boolean;
  names: AssistantDetailSheetView["names"];
  onCopied(copied: boolean): void;
  onStartWithStarter(starter: string): void;
  summary: AssistantSummary | null;
}>) {
  const { content } = detail;
  const state = assistantCardState(detail);
  const startable = state.kind === "ready";
  const status = assistantCardStatusText(state, detail.availability);
  const category = assistantCategoryLabel(content);
  const rows = assistantDetailRows(detail, names, summary?.fingerprint.modelLabel ?? null);
  const audience = sharingAudience(detail);
  const listing = detail.owned ? assistantListingStatusText(detail) : null;
  const projects = detail.owned ? assistantProjectsText(detail) : null;
  const meta = assistantDetailMeta(detail);
  return (
    <div className="v2-assistants-detail" data-testid="assistant-detail">
      <div className="v2-assistants-detail-head">
        <AssistantAvatarV2 className="v2-assistants-avatar" recipe={content.avatar} size={64} />
        <div>
          {content.description ? <p className="v2-assistants-detail-description">{content.description}</p> : null}
          <p className="v2-assistants-detail-meta">
            {meta.map((segment, index) => (
              <Fragment key={index}>
                {index > 0 ? " " : null}
                {/* The dot stays with the segment before it, so a line never starts with one. */}
                <span>{index < meta.length - 1 ? `${segment}\u00a0·` : segment}</span>
              </Fragment>
            ))}
          </p>
          {category || detail.featured ? (
            <p className="v2-assistants-pills">
              {category ? <span className="v2-assistants-pill">{category}</span> : null}
              {detail.featured ? (
                <span className="v2-assistants-pill" data-tone="featured"><UiV2Icon name="star" />Featured</span>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
      <div className="v2-assistants-detail-actions">
        {detail.archived && detail.owned ? (
          <UiV2Button disabled={busy} icon="regenerate" tone="primary" onClick={() => gallery.onArchiveToggle(detail.id, false)}>
            Restore
          </UiV2Button>
        ) : (
          <UiV2Button
            disabled={busy || !startable}
            icon="chat"
            tone="primary"
            onClick={() => void gallery.onStartChat(detail.id)}
          >
            Start chat
          </UiV2Button>
        )}
        {listed && !detail.archived ? (
          <UiV2Button
            aria-pressed={detail.pinned}
            disabled={busy}
            icon={detail.pinned ? "pin-fill" : "pin"}
            onClick={() => gallery.onPinToggle(detail.id, !detail.pinned)}
          >
            {detail.pinned ? "Unpin" : "Pin"}
          </UiV2Button>
        ) : null}
        {detail.owned ? (
          <UiV2Button disabled={busy} icon="edit" onClick={() => gallery.onEdit(detail.id)}>Edit</UiV2Button>
        ) : null}
        <AssistantActionsMenuV2
          assistant={{ archived: detail.archived, id: detail.id, name: content.name, owned: detail.owned }}
          canDuplicate={listed}
          disabled={busy}
          gallery={gallery}
          includeEdit={false}
          onCopied={onCopied}
        />
      </div>
      {status ? (
        <p className="v2-assistants-card-status" data-tone={state.kind === "archived" ? "neutral" : "warn"}>{status}</p>
      ) : null}
      {content.starterPrompts.length > 0 ? (
        <Section title="Conversation starters">
          <div className="v2-assistants-starters">
            {content.starterPrompts.map((starter, index) => (
              <button
                className="v2-assistants-starter v2-focusable"
                disabled={busy || !startable}
                key={`${index}:${starter}`}
                type="button"
                onClick={() => onStartWithStarter(starter)}
              >
                {starter}
              </button>
            ))}
          </div>
        </Section>
      ) : null}
      <Section title="Setup">
        <table className="v2-assistants-setup">
          <tbody>
            {rows.map((row) => (
              <tr data-deviation={Boolean(row.deviation) || undefined} data-row={row.key} key={row.key}>
                <th scope="row">
                  <UiV2Icon name={rowIcons[row.key]} />
                  <span>{row.label}</span>
                </th>
                <td className="v2-assistants-setup-value">
                  <span>{row.value}</span>
                  {row.deviation ? <span className="v2-assistants-setup-deviation">{row.deviation}</span> : null}
                </td>
                <td className="v2-assistants-setup-policy" data-policy={row.policy}>
                  <UiV2Icon name={row.policy === "fixed" ? "lock" : "edit"} />
                  <span>{row.policy === "fixed" ? "Fixed" : "Adjustable"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Section>
      <InstructionsSection detail={detail} initialOpen={initialPreviewOpen} />
      <Section title="Sharing">
        <div className="v2-assistants-sharing">
          {audience ? (
            <p className="v2-assistants-sharing-audience">
              {audience}
              {detail.owned && typeof detail.featuredOrder === "number" ? ` · Featured #${detail.featuredOrder + 1}` : ""}
            </p>
          ) : null}
          {listing ? <p>{listing}</p> : null}
          {projects ? <p>{projects}</p> : null}
          <div className="v2-assistants-sharing-actions">
            <UiV2Button icon="link" onClick={() => void gallery.onCopyLink(detail.id).then(onCopied)}>Copy link</UiV2Button>
            {detail.owned ? (
              <UiV2Button disabled={busy} icon="share" onClick={() => gallery.onShare(detail.id)}>Manage sharing…</UiV2Button>
            ) : null}
          </div>
        </div>
      </Section>
      {detail.owned && typeof detail.recentChatCount === "number" ? (
        <Section title="Usage">
          <p className="v2-assistants-usage">
            {detail.recentChatCount === 1 ? "1 chat" : `${detail.recentChatCount} chats`} in the last 30 days
          </p>
        </Section>
      ) : null}
    </div>
  );
}

/**
 * The detail sheet over the gallery (PRD 10.2): a wide side sheet, full
 * screen on phones in both orientations. It opens from a card, a
 * deep link or a menu, and returns focus to its opener on close.
 */
export function AssistantDetailSheetV2({
  busy,
  gallery,
  initialPreviewOpen = false,
  notice,
  onDismissNotice,
  onStartWithStarter,
  sheet
}: Readonly<{
  busy: boolean;
  gallery: AssistantGalleryView;
  /** Opens with the instructions preview shown. */
  initialPreviewOpen?: boolean;
  notice: LibraryNotice | null;
  onDismissNotice(): void;
  onStartWithStarter(assistantId: string, starter: string): void;
  sheet: AssistantDetailSheetView;
}>) {
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(""), 4000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);
  const onCopied = (copied: boolean) => setCopyStatus(copied ? "Assistant link copied." : "Could not copy the Assistant link.");
  const { detail, summary } = sheet;
  const title = sheet.state === "unavailable" ? "Assistant" : detail?.content.name ?? summary?.name ?? "Assistant";
  let body;
  if (sheet.state === "unavailable") {
    body = (
      <div className="v2-assistants-sheet-message" data-state="unavailable">
        <p role="status">{ASSISTANT_NOT_AVAILABLE_TEXT}</p>
        <UiV2Button onClick={sheet.onClose}>Back to Assistants</UiV2Button>
      </div>
    );
  } else if (sheet.state === "error" && !detail) {
    body = (
      <div className="v2-assistants-sheet-message" role="alert">
        <p>{sheet.error ?? "The Assistant did not load. Nothing was changed."}</p>
        <UiV2Button icon="regenerate" onClick={sheet.onRetry}>Retry</UiV2Button>
      </div>
    );
  } else if (!detail) {
    body = (
      <div aria-label="Loading the Assistant" className="v2-assistants-sheet-loading" role="status">
        {summary ? (
          <div className="v2-assistants-detail-head">
            <AssistantAvatarV2 className="v2-assistants-avatar" recipe={summary.avatar} size={64} />
            <div>
              {summary.description ? <p className="v2-assistants-detail-description">{summary.description}</p> : null}
            </div>
          </div>
        ) : null}
        <span aria-hidden="true" className="v2-assistants-skeleton-line" />
        <span aria-hidden="true" className="v2-assistants-skeleton-line" />
        <span aria-hidden="true" className="v2-assistants-skeleton-line" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  } else {
    body = (
      <DetailBody
        busy={busy}
        detail={detail}
        gallery={gallery}
        initialPreviewOpen={initialPreviewOpen}
        listed={summary !== null}
        names={sheet.names}
        summary={summary}
        onCopied={onCopied}
        onStartWithStarter={(starter) => onStartWithStarter(detail.id, starter)}
      />
    );
  }
  return (
    <UiV2Sheet open phoneFullScreen testId="assistant-detail-sheet" title={title} width="wide" onClose={sheet.onClose}>
      {notice ? <AssistantGalleryNoticeV2 notice={notice} onDismiss={onDismissNotice} /> : null}
      {body}
      <p className="v2-assistants-copy-status" role="status">{copyStatus}</p>
    </UiV2Sheet>
  );
}
