"use client";

import type {
  AssistantSharingDraft,
  AssistantSharingFailure,
  AssistantSharingSheetView
} from "@/components/assistants/libraryViewContracts";
import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2Switch } from "@/components/ui-v2";
import { UiV2Sheet } from "@/components/ui-v2/SheetV2";
import type { AssistantDetail } from "@/lib/contracts/assistants";
import { ASSISTANT_FEATURED_LIMIT } from "@/lib/contracts/assistantListing";
import { formatAssistantEntryPath } from "@/lib/domain/chatRoute";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  assistantListingStatusCopy,
  assistantSharingAccessItems,
  assistantSharingConsequences,
  assistantSharingFailureText,
  assistantSharingGroups,
  LISTING_RESEND_TEXT,
  memberCountText,
  sharingFailureGives
} from "./assistantSharingCopy";
import { recordSharingOpener, restoreSharingFocus } from "./sharingFocusReturn";
import "../assistants.css";
import "./assistant-sharing.css";

const DESCRIPTION = "Who can start chats with this Assistant. Changes apply to future chats.";

function otherProjectsText(count: number, afterNamed: boolean): string {
  return `${count}${afterNamed ? " other" : ""} ${count === 1 ? "Project" : "Projects"} you can't open`;
}

function Section({ children, title }: Readonly<{ children: ReactNode; title: string }>) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="v2-assistant-sharing-section">
      <h3 id={id}>{title}</h3>
      {children}
    </section>
  );
}

/** Failures at one control; `audience` names who a blocking Skill must reach. */
function Failures({ audience, failures, id }: Readonly<{
  audience: string;
  failures: readonly AssistantSharingFailure[];
  id: string;
}>) {
  if (failures.length === 0) return null;
  return (
    <div className="v2-assistant-sharing-error" id={id}>
      {failures.map((failure, index) => (
        <p key={`${failure.code}:${index}`}>{assistantSharingFailureText(failure, audience)}</p>
      ))}
    </div>
  );
}

function FeaturedRow({ draft, failures, featuredCount, onChange }: Readonly<{
  draft: AssistantSharingDraft;
  failures: readonly AssistantSharingFailure[];
  featuredCount: number;
  onChange(update: Partial<AssistantSharingDraft>): void;
}>) {
  const textId = useId();
  const positionId = useId();
  const errorId = useId();
  const lastIndex = Math.min(featuredCount, ASSISTANT_FEATURED_LIMIT - 1);
  const order = Math.min(draft.featuredOrder, lastIndex);
  const full = !draft.featured && featuredCount >= ASSISTANT_FEATURED_LIMIT;
  // Move buttons stay focusable at the ends so focus never drops to the page.
  const move = (next: number) => {
    if (next >= 0 && next <= lastIndex && next !== order) onChange({ featuredOrder: next });
  };
  // Two rows at every width: Featured with its switch, then the position with its moves.
  return (
    <div className="v2-assistant-sharing-featured">
      <div className="v2-assistant-sharing-featured-row">
        <p id={textId}>
          <strong>Featured</strong>{" "}
          <span>
            {full
              ? `Shown on every empty chat. Featured holds up to ${ASSISTANT_FEATURED_LIMIT} Assistants.`
              : "Shown on every empty chat."}
          </span>
        </p>
        <UiV2Switch
          aria-describedby={failures.length > 0 ? `${textId} ${errorId}` : textId}
          checked={draft.featured}
          disabled={full}
          label="Featured"
          onChange={(featured) => onChange({ featured, featuredOrder: order })}
        />
      </div>
      {draft.featured ? (
        <div className="v2-assistant-sharing-featured-row">
          <p id={positionId}>{`Position ${order + 1} of ${featuredCount + 1}`}</p>
          <span className="v2-assistant-sharing-featured-controls">
            <UiV2IconButton
              aria-describedby={positionId}
              aria-disabled={order === 0 || undefined}
              icon="arrow-up"
              label="Move up in Featured"
              onClick={() => move(order - 1)}
            />
            <UiV2IconButton
              aria-describedby={positionId}
              aria-disabled={order >= lastIndex || undefined}
              className="v2-assistant-sharing-move-down"
              icon="arrow-up"
              label="Move down in Featured"
              onClick={() => move(order + 1)}
            />
          </span>
        </div>
      ) : null}
      <Failures audience="everyone" failures={failures} id={errorId} />
    </div>
  );
}

function SharingForm({ detail, lastAction, view }: Readonly<{
  detail: AssistantDetail;
  lastAction: "save" | "withdraw" | null;
  view: AssistantSharingSheetView;
}>) {
  const { draft, isAdministrator, listing } = view;
  const radioName = useId();
  const everyoneLabelId = useId();
  const everyoneNoteId = useId();
  const statusId = useId();
  const groupsLabelId = useId();
  const noGroupsId = useId();
  const everyoneErrorId = useId();
  const groupsErrorId = useId();
  const summaryRef = useRef<HTMLParagraphElement>(null);
  const everyoneRef = useRef<HTMLInputElement>(null);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => {
    if (!copyStatus) return;
    const timer = window.setTimeout(() => setCopyStatus(""), 4000);
    return () => window.clearTimeout(timer);
  }, [copyStatus]);

  const failures = view.failures;
  // A failed Withdraw is reported at its option only; failures otherwise come from Save.
  const showSummary = lastAction !== "withdraw" && failures.length > 0;
  // After a failed save, the summary takes focus; after Withdraw, the option it belonged to.
  useEffect(() => {
    if (showSummary) summaryRef.current?.focus();
  }, [showSummary, failures]);
  const withdrawingRef = useRef(view.withdrawing);
  useEffect(() => {
    const finished = withdrawingRef.current && !view.withdrawing;
    withdrawingRef.current = view.withdrawing;
    // Withdraw disappears with the request it withdrew; the option keeps focus in the sheet.
    if (finished && lastAction === "withdraw") everyoneRef.current?.focus();
  }, [lastAction, view.withdrawing]);

  const locked = view.saving || view.withdrawing || detail.archived;
  const groups = assistantSharingGroups(view.groups, detail);
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const request = listing?.request ?? null;
  const openRequest = request?.state === "pending" && !request.outdated;
  const everyoneAvailable = isAdministrator ||
    Boolean(listing && (listing.listed || listing.canRequest || openRequest));
  const status = isAdministrator ? null : assistantListingStatusCopy(listing);
  // Listed for everyone, the option is no longer a request; it reads as one
  // again once the listing is gone and a new request is needed.
  const listed = !isAdministrator && Boolean(listing?.listed);
  const everyoneDescriptionId = listed ? statusId : everyoneNoteId;
  // Once the option is chosen, the hint under it says what Save does instead.
  const resend = status?.resend && draft.audience !== "everyone" ? LISTING_RESEND_TEXT : null;
  const willRequest = !isAdministrator && draft.audience === "everyone" && Boolean(listing?.canRequest) && !listing?.listed;
  const everyoneFailures = failures.filter((failure) => failure.target.kind === "everyone");
  const featuredFailures = failures.filter((failure) => failure.target.kind === "featured");
  const consequences = assistantSharingConsequences(detail, draft, groupNames);
  // A failure to give access held back every removal, which the draft still names.
  const removalsHeld = consequences.length > 0 && failures.some((failure) => sharingFailureGives(failure, draft));
  const noGroupChosen = draft.audience === "groups" && draft.groupIds.length === 0;
  const access = assistantSharingAccessItems(detail, view.names);
  const path = formatAssistantEntryPath(detail.id);
  const link = typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
  const projects = detail.projects ?? { otherProjectCount: 0, projects: [] };

  const toggleGroup = (groupId: string, checked: boolean) => view.onChange({
    groupIds: checked
      ? [...draft.groupIds.filter((id) => id !== groupId), groupId]
      : draft.groupIds.filter((id) => id !== groupId)
  });

  return (
    <div className="v2-assistant-sharing">
      {showSummary ? (
        <p className="v2-assistant-sharing-summary" ref={summaryRef} role="alert" tabIndex={-1}>
          {removalsHeld
            ? "Not everything was saved. The changes marked below were not applied; nothing was removed."
            : "Not everything was saved. The changes marked below were not applied; the rest is saved."}
        </p>
      ) : null}
      {view.error ? <p className="v2-assistant-sharing-summary" role="alert">{view.error}</p> : null}
      {detail.archived ? (
        <p className="v2-assistant-sharing-summary" data-tone="neutral">
          This Assistant is archived. Restore it to change who can use it.
        </p>
      ) : null}

      <fieldset className="v2-assistant-sharing-section" disabled={locked}>
        <legend>Who can use it</legend>
        <label className="v2-assistant-sharing-option">
          <input
            checked={draft.audience === "owner"}
            name={radioName}
            type="radio"
            onChange={() => view.onChange({ audience: "owner" })}
          />
          <span><strong>Only me</strong></span>
        </label>

        <label className="v2-assistant-sharing-option">
          <input
            aria-describedby={groups.length === 0 ? noGroupsId : undefined}
            aria-labelledby={groupsLabelId}
            checked={draft.audience === "groups"}
            disabled={groups.length === 0}
            name={radioName}
            type="radio"
            onChange={() => view.onChange({ audience: "groups" })}
          />
          <span>
            <strong id={groupsLabelId}>Selected groups</strong>
            {groups.length === 0 ? <small id={noGroupsId}>You aren&apos;t a member of any group.</small> : null}
          </span>
        </label>
        {groups.length > 0 ? (
          <fieldset
            aria-describedby={noGroupChosen ? groupsErrorId : undefined}
            className="v2-assistant-sharing-nested"
            disabled={draft.audience !== "groups"}
          >
            <legend className="sr-only">Groups</legend>
            {groups.map((group) => (
              <GroupOption
                checked={draft.groupIds.includes(group.id)}
                failures={failures.filter((failure) => failure.target.kind === "group" && failure.target.groupId === group.id)}
                group={group}
                key={group.id}
                onToggle={(checked) => toggleGroup(group.id, checked)}
              />
            ))}
            {noGroupChosen ? (
              <p className="v2-assistant-sharing-error" id={groupsErrorId}>Choose at least one group, or choose Only me.</p>
            ) : null}
          </fieldset>
        ) : null}

        <label className="v2-assistant-sharing-option">
          <input
            aria-describedby={everyoneFailures.length > 0 ? `${everyoneDescriptionId} ${everyoneErrorId}` : everyoneDescriptionId}
            aria-invalid={everyoneFailures.length > 0 || undefined}
            aria-labelledby={everyoneLabelId}
            checked={draft.audience === "everyone"}
            disabled={!everyoneAvailable}
            name={radioName}
            ref={everyoneRef}
            type="radio"
            onChange={() => view.onChange({ audience: "everyone" })}
          />
          <span>
            <strong id={everyoneLabelId}>
              {isAdministrator || listed ? "Everyone in this installation" : "Request listing for everyone"}
            </strong>
            {listed ? null : (
              <small id={everyoneNoteId}>
                {isAdministrator
                  ? "You are an administrator: listed right away."
                  : "An administrator reviews the Assistant, including its instructions, before it is listed."}
              </small>
            )}
          </span>
        </label>
        <div className="v2-assistant-sharing-nested">
          {status ? (
            <div className="v2-assistant-sharing-status">
              <p id={statusId}>
                <strong data-tone={status.tone}>{status.label}</strong>
                {` · ${status.text}`}
                {resend && !status.note ? ` ${resend}` : ""}
              </p>
              {listing?.canWithdraw ? (
                <UiV2Button
                  busy={view.withdrawing}
                  disabled={view.saving}
                  onClick={view.onWithdrawRequest}
                >
                  Withdraw request
                </UiV2Button>
              ) : null}
              {status.note ? <p className="v2-assistant-sharing-note">Reviewer&apos;s note: {status.note}</p> : null}
              {resend && status.note ? <p className="v2-assistant-sharing-resend">{resend}</p> : null}
            </div>
          ) : null}
          {willRequest ? <p className="v2-assistant-sharing-request-hint">Save sends the request to an administrator.</p> : null}
          <Failures audience="everyone" failures={everyoneFailures} id={everyoneErrorId} />
          {isAdministrator && draft.audience === "everyone" ? (
            <FeaturedRow
              draft={draft}
              failures={featuredFailures}
              featuredCount={view.featuredCount}
              onChange={view.onChange}
            />
          ) : null}
        </div>
        <div aria-live="polite">
          {consequences.length > 0 ? (
            <ul className="v2-assistant-sharing-consequences">
              {consequences.map((line) => <li key={line}>{line}</li>)}
            </ul>
          ) : null}
        </div>
      </fieldset>

      <Section title="People you share with need access to">
        <div className="v2-assistant-sharing-access">
          {access.length > 0 ? (
            <ul className="v2-assistant-sharing-chips">
              {access.map((item) => (
                <li key={item.key}><UiV2Icon name={item.icon} /><span>{item.label}</span></li>
              ))}
            </ul>
          ) : <p>Nothing beyond the Assistant itself.</p>}
          <p className="v2-assistant-sharing-caption">
            {access.length > 0
              ? "Those without access will see the Assistant as unavailable. Adjustable rows fall back to their own defaults."
              : "Adjustable rows fall back to their own defaults."}
          </p>
        </div>
      </Section>

      <Section title="Link">
        <div className="v2-assistant-sharing-link">
          <input aria-label="Assistant link" readOnly type="text" value={link} onFocus={(event) => event.currentTarget.select()} />
          <UiV2Button
            icon="link"
            onClick={() => void view.onCopyLink().then((copied) =>
              setCopyStatus(copied ? "Assistant link copied." : "Could not copy the Assistant link."))}
          >
            Copy link
          </UiV2Button>
        </div>
        <p className="v2-assistant-sharing-caption">
          Opens a new chat with this Assistant for people who can use it; others land on their own new chat.
        </p>
        <p className="v2-assistants-copy-status" role="status">{copyStatus}</p>
      </Section>

      <Section title="Projects using this Assistant">
        {projects.projects.length + projects.otherProjectCount > 0 ? (
          <ul className="v2-assistant-sharing-projects">
            {projects.projects.map((project) => <li key={project.id}>{project.name}</li>)}
            {projects.otherProjectCount > 0 ? (
              <li className="v2-assistant-sharing-projects-rest">{otherProjectsText(projects.otherProjectCount, projects.projects.length > 0)}</li>
            ) : null}
          </ul>
        ) : <p className="v2-assistant-sharing-empty">No Projects use this Assistant.</p>}
        <p className="v2-assistant-sharing-caption">Project managers refresh dependencies from the Project.</p>
      </Section>
    </div>
  );
}

function GroupOption({ checked, failures, group, onToggle }: Readonly<{
  checked: boolean;
  failures: readonly AssistantSharingFailure[];
  group: { id: string; memberCount: number | null; name: string };
  onToggle(checked: boolean): void;
}>) {
  const nameId = useId();
  const countId = useId();
  const errorId = useId();
  const described = [group.memberCount !== null ? countId : null, failures.length > 0 ? errorId : null].filter(Boolean);
  return (
    <div className="v2-assistant-sharing-group" data-failed={failures.length > 0 || undefined}>
      <label>
        <input
          aria-describedby={described.length > 0 ? described.join(" ") : undefined}
          aria-invalid={failures.length > 0 || undefined}
          aria-labelledby={nameId}
          checked={checked}
          type="checkbox"
          onChange={(event) => onToggle(event.currentTarget.checked)}
        />
        <strong id={nameId}>{group.name}</strong>
        {group.memberCount !== null ? <span id={countId}>{memberCountText(group.memberCount)}</span> : null}
      </label>
      <Failures audience={group.name} failures={failures} id={errorId} />
    </div>
  );
}

/**
 * The Sharing sheet of an owned Assistant (PRD 10.4): who can use it, what
 * the people it is shared with need access to, the listing request, Featured
 * for administrators, the link and the Projects that use it. A wide side
 * sheet, full screen on phones in both orientations. Save applies the
 * draft as one action and keeps what could not be applied at its control;
 * closing with unsaved changes asks first. However it closes, focus returns
 * to the control that opened it, or to its nearest neighbour when Save
 * replaced that control.
 */
export function AssistantSharingSheetV2({
  initialConfirmingDiscard = false,
  view
}: Readonly<{
  /** Opens with the discard confirmation shown (gallery fixtures). */
  initialConfirmingDiscard?: boolean;
  view: AssistantSharingSheetView;
}>) {
  const [confirmingDiscard, setConfirmingDiscard] = useState(initialConfirmingDiscard);
  // Recorded in the first render, before the sheet takes focus from the opener.
  const [opener] = useState(() => recordSharingOpener(typeof document === "undefined" ? null : document.activeElement));
  useEffect(() => () => {
    // After the modal layer's own restoration, which runs in a microtask.
    window.setTimeout(() => restoreSharingFocus(opener), 0);
  }, [opener]);
  const [lastAction, setLastAction] = useState<"save" | "withdraw" | null>(null);
  const busy = view.saving || view.withdrawing;
  const detail = view.detail;
  const requestClose = () => {
    if (busy) return;
    if (view.dirty) setConfirmingDiscard(true);
    else view.onClose();
  };
  const canSave = view.state === "ready" && detail !== null && view.dirty && !busy && !detail.archived &&
    !(view.draft.audience === "groups" && view.draft.groupIds.length === 0);

  let body: ReactNode;
  if (view.state === "error" && !detail) {
    body = (
      <div className="v2-assistants-sheet-message" role="alert">
        <p>{view.error ?? "Sharing did not load. Nothing was changed."}</p>
        <UiV2Button icon="regenerate" onClick={view.onRetry}>Retry</UiV2Button>
      </div>
    );
  } else if (!detail) {
    body = (
      <div aria-label="Loading sharing" className="v2-assistants-sheet-loading" role="status">
        <span aria-hidden="true" className="v2-assistants-skeleton-line" />
        <span aria-hidden="true" className="v2-assistants-skeleton-line" />
        <span aria-hidden="true" className="v2-assistants-skeleton-line" />
        <span className="sr-only">Loading…</span>
      </div>
    );
  } else {
    body = (
      <SharingForm
        detail={detail}
        lastAction={lastAction}
        view={{
          ...view,
          onWithdrawRequest() {
            setLastAction("withdraw");
            view.onWithdrawRequest();
          }
        }}
      />
    );
  }

  return (
    <>
      <UiV2Sheet
        closeBlocked={busy}
        description={DESCRIPTION}
        footer={(
          <>
            <UiV2Button disabled={busy} onClick={requestClose}>Cancel</UiV2Button>
            <UiV2Button
              busy={view.saving}
              disabled={!canSave}
              tone="primary"
              onClick={() => {
                setLastAction("save");
                void view.onSave();
              }}
            >
              Save
            </UiV2Button>
          </>
        )}
        open
        phoneFullScreen
        testId="assistant-sharing-sheet"
        title={view.name ? `Sharing · ${view.name}` : "Sharing"}
        width="wide"
        onClose={requestClose}
      >
        {body}
      </UiV2Sheet>
      {confirmingDiscard ? (
        <DiscardChangesConfirmationDialog
          copy={{
            body: "Who can use the Assistant stays as it was last saved.",
            cancelLabel: "Keep editing",
            confirmLabel: "Discard changes",
            dialogLabel: "Unsaved sharing changes",
            title: "Discard sharing changes?"
          }}
          label="sharing"
          portal
          onCancel={() => setConfirmingDiscard(false)}
          onConfirm={() => {
            setConfirmingDiscard(false);
            view.onClose();
          }}
        />
      ) : null}
    </>
  );
}
