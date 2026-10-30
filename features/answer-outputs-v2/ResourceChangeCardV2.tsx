"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { UiV2Button, UiV2Icon, UiV2IconButton, type UiV2IconName } from "@/components/ui-v2";
import { deleteSkill, loadSkillDetail, SkillRequestError } from "@/components/app-shell/skillLibraryStore";
import {
  deleteAssistant,
  fetchAssistantDetail,
  publishAssistant,
  requestAssistantListing,
  setAssistantArchived,
  type AssistantApiResult
} from "@/components/assistants/assistantsApi";
import {
  SECRETS_LIBRARY_PATH,
  assistantLibraryPath,
  resourceChangeCardKey,
  type AssistantChangeCard,
  type AssistantChangeField,
  type ResourceChangeCard,
  type ResourceChangeDiff,
  type SecretChangeCard,
  type SkillDeleteProposalCard,
  type SubagentChangeCard,
  type SubagentChangeField,
  type SubagentDefaultChange
} from "@/lib/contracts/resourceChanges";
import { SUBAGENTS_LIBRARY_PATH, type SubagentDefaultUndoOutcome, type SubagentDefaultUndoRequest } from "@/lib/contracts/subagentDefinitions";
import {
  SubagentApiError,
  deleteSubagentDefinition,
  getSubagentDefinition,
  readSubagentDefault,
  restoreSubagentRevision,
  undoSubagentDefaultChange
} from "@/features/library-v2/subagents/subagentsApi";
import { SKILL_LIBRARY_PATH } from "@/lib/contracts/skillSaves";
import { formatAssistantEntryPath } from "@/lib/domain/chatRoute";
import type { WorkspaceSecretKind } from "@/lib/contracts/workspaceSecrets";
import { deleteSecretVersion, readSecretState, ResourceChangeApiError } from "./resourceChangeApi";
import { shellLinkClick } from "./shellLinkClick";

/** What the resource is now, as a settled answer reads it; unknown until read (or while the answer runs). */
type Remote = "unknown" | "current" | "changed" | "missing" | "archived";
type Outcome = Readonly<{ heading: string; message: string | null }>;

/**
 * What the user did in a card on this page: the card a settling answer
 * mounts again, or the same card in another branch, keeps saying it. Each
 * proposal is its own card, so a later proposal of the same change asks
 * again. Nothing records a declined proposal, so a reload asks again while
 * the resource is as the proposal saw it.
 */
const outcomes = new Map<string, Outcome>();

const SECRET_KINDS: Readonly<Record<WorkspaceSecretKind, string>> = {
  browser_session: "Browser session", env: "Environment", file: "File", ssh_key: "SSH key", text: "Text"
};

const ASSISTANT_FIELDS: Readonly<Record<AssistantChangeField, string>> = {
  description: "Description", instructions: "Instructions", mcp_tools: "MCP tools", model: "Model", name: "Name", skills: "Skills",
  starter_prompts: "Starter prompts", web_search: "Web search"
};

const SUBAGENT_FIELDS: Readonly<Record<SubagentChangeField, string>> = {
  default: "Default", description: "Description", effort: "Reasoning effort", instructions: "Instructions", model: "Model", name: "Name", tools: "Tools"
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const quoted = (names: readonly string[]) => names.map((name) => `“${name}”`).join(", ");

/** How the chat shell opens what a card links to; see `shellLinkClick`. */
export type ResourceChangeNavigationV2 = Readonly<{
  /** Opens a Studio address (`/?library=...`) in the shell. */
  onOpenLibrary?(href: string): void;
  /** Starts a new chat with an Assistant, as `/assistant/<id>` does. */
  onStartAssistantChat?(assistantId: string): void;
}>;

const NO_NAVIGATION: ResourceChangeNavigationV2 = {};
const CardNavigationContext = createContext<ResourceChangeNavigationV2>(NO_NAVIGATION);

/**
 * A card's verb as an icon link, named and labelled like `UiV2IconButton`:
 * it stays a link, so a modified click keeps the browser's own behavior.
 * Tooltips open leftwards, since the verbs end the card's row.
 */
function IconLinkV2({ href, icon, label, onOpen }: Readonly<{ href: string; icon: UiV2IconName; label: string; onOpen?: () => void }>) {
  return (
    <a className="v2-icon-button v2-focusable" aria-label={label} data-tooltip={label} data-tooltip-side="left" href={href}
      onClick={shellLinkClick(onOpen)}>
      <UiV2Icon name={icon} />
    </a>
  );
}

/** A Studio link: a plain click opens Studio in the shell, so the address and the view agree. */
function CardLinkV2({ href, icon, label }: Readonly<{ href: string; icon: UiV2IconName; label: string }>) {
  const { onOpenLibrary } = useContext(CardNavigationContext);
  return <IconLinkV2 href={href} icon={icon} label={label} onOpen={onOpenLibrary ? () => onOpenLibrary(href) : undefined} />;
}

/** "Start a chat" with an Assistant: a plain click starts it in the shell, as `/assistant/<id>` does. */
function StartAssistantChatLinkV2({ assistantId }: Readonly<{ assistantId: string }>) {
  const { onStartAssistantChat } = useContext(CardNavigationContext);
  return (
    <IconLinkV2 href={formatAssistantEntryPath(assistantId)} icon="chat" label="Start a chat"
      onOpen={onStartAssistantChat ? () => onStartAssistantChat(assistantId) : undefined} />
  );
}

/** Undo as an icon verb; `label` names what it undoes. */
function UndoButtonV2({ busy, label, onClick }: Readonly<{ busy: boolean; label: string; onClick(): void }>) {
  return (
    <UiV2IconButton aria-busy={busy || undefined} disabled={busy} icon="history" label={label} tooltip="Undo" tooltipSide="left"
      onClick={onClick} />
  );
}

function DiffV2({ diff, label }: Readonly<{ diff: ResourceChangeDiff; label: string }>) {
  return (
    <details className="v2-skill-save-changes">
      <summary>Show changes</summary>
      <pre className="v2-skill-save-diff" aria-label={label}>
        {diff.lines.map((line, index) => (
          <span key={index} data-kind={line.kind}>
            {line.kind === "gap" ? "⋯" : `${line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "} ${line.text}`}
            {"\n"}
          </span>
        ))}
        {diff.truncated ? <span data-kind="gap">{"⋯ more changes\n"}</span> : null}
      </pre>
    </details>
  );
}

/** The inline question of a proposal: the target, the consequences and the two verbs. */
function ConfirmV2({ busy, confirmLabel, keepLabel, label, onConfirm, onKeep, text, tone = "destructive" }: Readonly<{
  busy: boolean;
  confirmLabel: string;
  keepLabel: string;
  label: string;
  onConfirm(): void;
  onKeep(): void;
  text: string;
  tone?: "destructive" | "primary";
}>) {
  return (
    <div className="v2-resource-change-card-confirm" role="group" aria-label={label}>
      <p>{text}</p>
      <span>
        <UiV2Button busy={busy} disabled={busy} tone={tone} type="button" onClick={onConfirm}>{confirmLabel}</UiV2Button>
        <UiV2Button disabled={busy} type="button" onClick={onKeep}>{keepLabel}</UiV2Button>
      </span>
    </div>
  );
}

/**
 * One card in the generated-file card's frame: the name, then one quiet line
 * joining the heading (what happened or what is asked) with `meta`; `detail`
 * (what is not needed at a glance, and stays visible in Studio) is that
 * line's tooltip. The verbs are icons beside the text; `children` (what a
 * deletion changes, a diff), the question, the status and the error take
 * rows of their own, which may widen the card while shown.
 */
function CardV2({ actions, children, confirm, detail = null, error, heading, headingRef, icon, meta = null, name, resource, state, status }: Readonly<{
  actions?: ReactNode;
  children?: ReactNode;
  confirm?: ReactNode;
  detail?: string | null;
  error: string | null;
  heading: string;
  headingRef: RefObject<HTMLSpanElement | null>;
  icon: UiV2IconName;
  meta?: string | null;
  name: string;
  resource: ResourceChangeCard["resource"];
  state: string;
  status: string | null;
}>) {
  const headingId = useId();
  const line = meta ? `${heading} · ${meta}` : heading;
  return (
    <li className="v2-resource-change-card" data-resource={resource} data-state={state} data-testid="resource-change-card" aria-labelledby={headingId}>
      <span className="v2-resource-change-card-tile" aria-hidden="true"><UiV2Icon name={icon} /></span>
      <span className="v2-resource-change-card-copy">
        <strong title={name}>{name}</strong>
        <small title={detail ? `${line}\n${detail}` : line}>
          <span className="v2-resource-change-card-heading" id={headingId} ref={headingRef} tabIndex={-1}>{heading}</span>
          {meta ? ` · ${meta}` : null}
        </small>
      </span>
      {actions ? <span className="v2-resource-change-card-actions">{actions}</span> : null}
      {children}
      {confirm}
      {status ? <p className="v2-resource-change-card-status" role="status">{status}</p> : null}
      {error ? <p className="v2-resource-change-card-error" role="alert">{error}</p> : null}
    </li>
  );
}

/** Local card state: the user's outcome on this page, the resource as read now, a request in flight and its error. */
function useCardState(card: ResourceChangeCard) {
  const key = resourceChangeCardKey(card);
  const headingRef = useRef<HTMLSpanElement>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(() => outcomes.get(key) ?? null);
  const [remote, setRemote] = useState<Remote>("unknown");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function finish(next: Outcome) {
    outcomes.set(key, next);
    setOutcome(next);
    // The verbs are gone: focus stays on the card, whose heading says what happened.
    queueMicrotask(() => headingRef.current?.focus());
  }
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, finish, headingRef, outcome, remote, run, setError, setRemote };
}

/**
 * Reads the resource once for a settled answer (`read` is null otherwise); a
 * failed read keeps the verbs, whose own request then decides.
 */
function useRemoteRead(read: ((signal: AbortSignal) => Promise<Remote>) | null, apply: (remote: Remote) => void) {
  useEffect(() => {
    if (!read) return;
    const controller = new AbortController();
    read(controller.signal).then((remote) => { if (!controller.signal.aborted) apply(remote); }).catch(() => undefined);
    return () => controller.abort();
  }, [apply, read]);
}

function SecretCardV2({ card, live }: Readonly<{ card: SecretChangeCard; live: boolean }>) {
  const state = useCardState(card);
  const { outcome, remote } = state;
  const read = useCallback((signal: AbortSignal) => readSecretState(card.secretId, card.versionId, signal), [card.secretId, card.versionId]);
  useRemoteRead(!live && card.action !== "updated" && !outcome ? read : null, state.setRemote);

  function remove(undo: boolean) {
    void state.run(async () => {
      try {
        await deleteSecretVersion(card.secretId, card.versionId);
        state.finish(undo ? { heading: "Secret removed", message: "Undone: the secret is deleted." } : { heading: "Secret deleted", message: null });
      } catch (failure) {
        // The route refuses a revision that is no longer current, or a secret that is gone.
        if (failure instanceof ResourceChangeApiError && failure.code === "workspace_secret_conflict") state.setRemote("changed");
        else state.setError(undo ? "Undo failed. Try again." : "The secret could not be deleted. Try again.");
      }
    });
  }

  // "Environment · GITLAB_TOKEN", or "Environment · 2 variables" with the names in the tooltip.
  const [only] = card.envNames;
  const kind = [SECRET_KINDS[card.kind], card.envNames.length > 1 ? plural(card.envNames.length, "variable", "variables") : only]
    .filter(Boolean).join(" · ");
  const names = card.envNames.length > 1 ? card.envNames.join(", ") : null;
  const link = <CardLinkV2 href={SECRETS_LIBRARY_PATH} icon="key" label="Open Secrets" />;
  if (card.action === "updated") {
    const detail = [names, card.previousName ? `Renamed from “${card.previousName}”.` : null,
      card.valueReplaced ? "The value was replaced; earlier values are not kept." : null].filter(Boolean).join("\n");
    return (
      <CardV2 actions={link} detail={detail || null} error={null} heading={card.previousName && !card.valueReplaced ? "Secret renamed" : "Secret updated"}
        headingRef={state.headingRef} icon="key" meta={kind} name={card.name} resource="secret" state="done" status={null} />
    );
  }
  if (card.action === "created") {
    const gone = remote === "missing" || remote === "changed";
    return (
      <CardV2 detail={names} error={state.error} heading={outcome?.heading ?? "Secret saved"} headingRef={state.headingRef} icon="key" meta={kind}
        name={card.name} resource="secret" state={outcome ? "done" : remote} status={outcome?.message ?? (remote === "missing" ? "This secret no longer exists."
          : remote === "changed" ? "Undo is not available: the secret changed after this, and that change is kept." : null)}
        actions={outcome ? null : <>
          {gone ? null : <UndoButtonV2 busy={state.busy} label={`Undo saving ${card.name}`} onClick={() => remove(true)} />}
          {link}
        </>} />
    );
  }
  const asking = !outcome && remote !== "missing" && remote !== "changed";
  return (
    <CardV2 actions={asking || outcome ? null : link} detail={names} error={state.error}
      heading={outcome?.heading ?? (remote === "missing" ? "Secret already deleted" : remote === "changed" ? "Secret not deleted" : "Delete secret?")}
      headingRef={state.headingRef}
      icon="key" meta={kind} name={card.name} resource="secret" state={outcome ? "done" : asking ? "asking" : remote}
      status={outcome?.message ?? (remote === "changed" ? "The secret changed after this proposal, so nothing was deleted. Review it in Studio › Secrets." : null)}
      confirm={asking ? (
        <ConfirmV2 busy={state.busy} confirmLabel="Delete secret" keepLabel="Keep secret" label={`Delete ${card.name}`}
          text={`Delete “${card.name}”? Chats and the Workspace stop receiving it. This cannot be undone.`}
          onConfirm={() => remove(false)} onKeep={() => state.finish({ heading: "Secret kept", message: null })} />
      ) : null} />
  );
}

function SkillDeleteCardV2({ card, live }: Readonly<{ card: SkillDeleteProposalCard; live: boolean }>) {
  const state = useCardState(card);
  const { outcome, remote } = state;
  const read = useCallback((signal: AbortSignal) => loadSkillDetail(card.skillId, signal).then(
    (detail): Remote => detail.version === card.skillVersion ? "current" : "changed",
    (failure: unknown): Remote => {
      if (failure instanceof SkillRequestError && failure.issue.code === "skill_not_available") return "missing";
      throw failure;
    }), [card.skillId, card.skillVersion]);
  useRemoteRead(!live && !outcome ? read : null, state.setRemote);

  function remove() {
    void state.run(async () => {
      try {
        // Guarded by the version the proposal saw: a Skill saved since is not deleted.
        await deleteSkill(card.skillId, card.skillVersion);
        state.finish({ heading: "Skill deleted", message: null });
      } catch (failure) {
        const code = failure instanceof SkillRequestError ? failure.issue.code : null;
        if (code === "skill_not_available") state.setRemote("missing");
        else if (code === "skill_version_conflict") state.setRemote("changed");
        else state.setError("The Skill could not be deleted. Try again.");
      }
    });
  }

  const asking = !outcome && remote !== "missing" && remote !== "changed";
  const consequences = [
    ...card.assistantCount > 0 ? [`Linked by ${plural(card.assistantCount, "Assistant", "Assistants")}, which lose it.`] : [],
    ...card.shared ? ["Shared with colleagues, who lose access."] : [],
    ...card.scheduledTasks.length ? [`Pinned by automations ${quoted(card.scheduledTasks.map((task) => task.title))}; their next runs fail until they are changed.`] : []
  ];
  return (
    <CardV2 actions={asking ? null : <CardLinkV2 href={SKILL_LIBRARY_PATH} icon="wand" label="Open library" />} error={state.error}
      heading={outcome?.heading ?? (remote === "missing" ? "Skill no longer available" : remote === "changed" ? "Skill not deleted" : "Delete Skill?")}
      headingRef={state.headingRef} icon="wand" name={card.name} resource="skill" state={outcome ? "done" : asking ? "asking" : remote}
      status={outcome?.message ?? (remote === "changed" ? "The Skill changed after this proposal, so nothing was deleted. Review it in Studio › Skills." : null)}
      confirm={asking ? (
        <ConfirmV2 busy={state.busy} confirmLabel="Delete Skill" keepLabel="Keep Skill" label={`Delete ${card.name}`}
          text={`Delete “${card.name}” with all its versions? This cannot be undone.`} onConfirm={remove}
          onKeep={() => state.finish({ heading: "Skill kept", message: null })} />
      ) : null}>
      {asking && consequences.length ? (
        <ul className="v2-resource-change-card-consequences" aria-label="What deleting changes">
          {consequences.map((line) => <li key={line}>{line}</li>)}
        </ul>
      ) : null}
    </CardV2>
  );
}

function assistantRemote(result: AssistantApiResult<{ archived: boolean; version?: number }>, version: number): Remote {
  if (!result.ok) {
    if (result.status === 404) return "missing";
    throw new Error(result.code);
  }
  return result.data.archived ? "archived" : result.data.version === version ? "current" : "changed";
}

/** The Studio routes' refusals as a card shows them; null: an unexpected failure. */
function assistantRefusal(result: Extract<AssistantApiResult<unknown>, { ok: false }>): Readonly<{ remote?: Remote; message?: string }> | null {
  if (result.status === 404) return { remote: "missing" };
  switch (result.code) {
    case "assistant_version_conflict": return { remote: "changed" };
    case "assistant_archived": return { remote: "archived" };
    case "assistant_skill_audience_mismatch":
      return { message: `Share ${result.skills?.length ? `these Skills: ${quoted(result.skills)}` : "every linked Skill"} with this audience first, then publish again.` };
    case "assistant_listing_request_not_needed": return { message: "As an administrator, publish it for everyone in Studio › Assistants." };
    case "assistant_already_listed": return { message: "It is already listed for everyone." };
    case "forbidden": return { message: "You can publish only to groups you belong to." };
    default: return null;
  }
}

function AssistantCardV2({ card, live }: Readonly<{ card: AssistantChangeCard; live: boolean }>) {
  const state = useCardState(card);
  const { outcome, remote } = state;
  const reads = card.action !== "updated";
  const read = useCallback(async () => assistantRemote(await fetchAssistantDetail(card.assistantId), card.definitionVersion),
    [card.assistantId, card.definitionVersion]);
  useRemoteRead(!live && reads && !outcome ? read : null, state.setRemote);

  function act(request: () => Promise<AssistantApiResult<unknown>>, done: Outcome, failure: string) {
    void state.run(async () => {
      const result = await request();
      if (result.ok) {
        state.finish(done);
        return;
      }
      const refusal = assistantRefusal(result);
      if (refusal?.remote) state.setRemote(refusal.remote);
      else state.setError(refusal?.message ?? failure);
    });
  }

  const open = <CardLinkV2 href={assistantLibraryPath(card.assistantId)} icon="assistant" label="Open in Studio" />;
  const remoteStatus = remote === "missing" ? "This Assistant no longer exists."
    : remote === "archived" ? "The Assistant is archived; restore it in Studio › Assistants first."
      : remote === "changed" ? card.action === "created"
        ? "Undo is not available: the Assistant changed after this, and that change is kept."
        : "The Assistant changed after this proposal, so nothing was done. Review it in Studio › Assistants." : null;
  const settled = remote === "missing" || remote === "archived" || remote === "changed";

  if (card.action === "updated") {
    // The changed fields at a glance; what each became in the tooltip; the instructions diff behind its own disclosure.
    return (
      <CardV2 actions={open} error={null} heading="Assistant updated" headingRef={state.headingRef} icon="assistant"
        meta={card.changes.map((change) => ASSISTANT_FIELDS[change.field]).join(", ") || null}
        detail={card.changes.map((change) => `${ASSISTANT_FIELDS[change.field]}${change.summary ? `: ${change.summary}` : " changed"}`).join("\n") || null}
        name={card.name} resource="assistant" state="done" status={null}>
        {card.instructionsDiff && card.changes.some((change) => change.field === "instructions")
          ? <DiffV2 diff={card.instructionsDiff} label={`Changes in the instructions of ${card.name}`} /> : null}
      </CardV2>
    );
  }
  if (card.action === "created") {
    return (
      <CardV2 error={state.error} heading={outcome?.heading ?? "Assistant created"} headingRef={state.headingRef} icon="assistant" name={card.name}
        resource="assistant" state={outcome ? "done" : remote} status={outcome?.message ?? remoteStatus}
        actions={<>
          {outcome || settled ? null : (
            <UndoButtonV2 busy={state.busy} label={`Undo creating ${card.name}`}
              onClick={() => act(() => setAssistantArchived(card.assistantId, card.definitionVersion, true),
                { heading: "Assistant archived", message: "Undone: the Assistant is archived. You can restore it in Studio › Assistants." }, "Undo failed. Try again.")} />
          )}
          {outcome || remote === "missing" ? null : <StartAssistantChatLinkV2 assistantId={card.assistantId} />}
          {remote === "missing" ? null : open}
        </>} />
    );
  }
  const asking = !outcome && !settled;
  if (card.action === "delete_proposed") {
    const consequences = card.consequences;
    const lines = consequences ? [
      ...consequences.chatCount > 0 ? [`${plural(consequences.chatCount, "chat uses", "chats use")} it; they stay open and show it as deleted.`] : [],
      ...consequences.everyone ? ["Listed for everyone; colleagues lose it."] : [],
      ...consequences.groupNames.length ? [`Published to ${consequences.groupNames.join(", ")}; their members lose it.`] : [],
      ...consequences.pendingListingRequest ? ["Its listing request is withdrawn."] : []
    ] : [];
    return (
      <CardV2 actions={asking || remote === "missing" ? null : open} error={state.error}
        heading={outcome?.heading ?? (remote === "missing" ? "Assistant already deleted" : settled ? "Assistant not deleted" : "Delete Assistant?")}
        headingRef={state.headingRef}
        icon="assistant" name={card.name} resource="assistant" state={outcome ? "done" : asking ? "asking" : remote}
        status={outcome?.message ?? (remote === "missing" ? null : remoteStatus)}
        confirm={asking ? (
          <ConfirmV2 busy={state.busy} confirmLabel="Delete Assistant" keepLabel="Keep Assistant" label={`Delete ${card.name}`}
            text={`Delete “${card.name}”? This cannot be undone.`}
            onConfirm={() => act(() => deleteAssistant(card.assistantId, card.definitionVersion), { heading: "Assistant deleted", message: null },
              "The Assistant could not be deleted. Try again.")}
            onKeep={() => state.finish({ heading: "Assistant kept", message: null })} />
        ) : null}>
        {asking && lines.length ? (
          <ul className="v2-resource-change-card-consequences" aria-label="What deleting changes">
            {lines.map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : null}
      </CardV2>
    );
  }
  const audience = card.audience;
  const everyone = audience?.kind !== "group";
  return (
    <CardV2 actions={asking || remote === "missing" ? null : open} error={state.error}
      heading={outcome?.heading ?? (settled ? "Not published" : "Publish Assistant?")} headingRef={state.headingRef}
      icon="share" meta={audience?.kind === "group" ? `To ${audience.groupName}` : "For everyone"} name={card.name} resource="assistant" state={outcome ? "done" : asking ? "asking" : remote} status={outcome?.message ?? remoteStatus}
      confirm={asking ? (
        <ConfirmV2 busy={state.busy} confirmLabel={everyone ? "Request listing" : "Publish"} keepLabel="Not now" label={`Publish ${card.name}`} tone="primary"
          text={audience?.kind === "group"
            ? `Publish “${card.name}” to members of ${audience.groupName}? They can use it, and every later change, until you unpublish it.`
            : `List “${card.name}” for everyone? An administrator reviews this version first.`}
          onConfirm={() => audience?.kind === "group"
            ? act(() => publishAssistant(card.assistantId, { expectedVersion: card.definitionVersion, groupId: audience.groupId, scope: "group" }),
              { heading: "Assistant published", message: `Members of ${audience.groupName} can use it now.` }, "Publishing failed. Try again.")
            : act(() => requestAssistantListing(card.assistantId, card.definitionVersion),
              { heading: "Listing requested", message: "An administrator reviews it; Studio › Assistants shows the outcome." }, "The listing request failed. Try again.")}
          onKeep={() => state.finish({ heading: "Not published", message: null })} />
      ) : null} />
  );
}

/** A custom sub-agent's state as the card reads it: still at the card's version, changed since, or gone. */
async function readSubagentRemote(definitionId: string, version: number, signal: AbortSignal): Promise<Remote> {
  try {
    return (await getSubagentDefinition(definitionId, signal)).version === version ? "current" : "changed";
  } catch (failure) {
    if (failure instanceof SubagentApiError && failure.status === 404) return "missing";
    throw failure;
  }
}

/** What the default was before a change, in plain words. */
const defaultBefore = (change: SubagentDefaultChange) => change.previous ? `“${change.previous.name}”` : "the built-in sub-agent";

/** What an Undo did to the default, as the server left it. */
function defaultUndoNote(change: SubagentDefaultChange, outcome: SubagentDefaultUndoOutcome): string {
  if (outcome === "changed") return "The default sub-agent changed after this, and that change is kept.";
  if (outcome === "target_gone") return "The earlier default no longer exists, so new sub-agents use the built-in.";
  return change.previous ? `“${change.previous.name}” is the default again.` : "New sub-agents use the built-in again.";
}

function SubagentCardV2({ card, live }: Readonly<{ card: SubagentChangeCard; live: boolean }>) {
  const state = useCardState(card);
  const { outcome, remote } = state;
  const change = card.defaultChange ?? null;
  // An edit that only moved the default leaves the version alone: the default, not the version, decides its Undo.
  const movedOnly = card.action === "updated" && card.undoRevisionId === null;
  const defaultLeft = change?.isDefault ? card.definitionId : null;
  const read = useCallback((signal: AbortSignal) => movedOnly
    ? readSubagentDefault(signal).then((current): Remote => current === defaultLeft ? "current" : "changed")
    : readSubagentRemote(card.definitionId, card.definitionVersion, signal),
  [card.definitionId, card.definitionVersion, defaultLeft, movedOnly]);
  useRemoteRead(!live && !outcome ? read : null, state.setRemote);

  /** `done` null: the request changed nothing because the resource moved on. */
  function act<T>(request: () => Promise<T>, done: Outcome | ((value: T) => Outcome | null), failure: string) {
    void state.run(async () => {
      try {
        const value = await request();
        const next = typeof done === "function" ? done(value) : done;
        if (next) state.finish(next);
        else state.setRemote("changed");
      } catch (error) {
        // The routes refuse a version that is no longer current, or a sub-agent that is gone.
        const code = error instanceof SubagentApiError ? error.code : null;
        if (code === "subagent_not_found") state.setRemote("missing");
        else if (code === "subagent_definition_conflict") state.setRemote("changed");
        else state.setError(failure);
      }
    });
  }

  const open = <CardLinkV2 href={SUBAGENTS_LIBRARY_PATH} icon="bot" label="Open in Studio" />;
  const settled = remote === "missing" || remote === "changed";
  const remoteStatus = remote === "missing" ? "This sub-agent no longer exists."
    : remote === "changed" ? card.action === "delete_proposed"
      ? "The sub-agent changed after this proposal, so nothing was deleted. Review it in Studio › Sub-agents."
      : movedOnly ? "Undo is not available: the default sub-agent changed after this, and that change is kept."
        : "Undo is not available: the sub-agent changed after this, and that change is kept." : null;

  if (card.action === "created" || card.action === "updated") {
    const created = card.action === "created";
    const undoRevisionId = card.undoRevisionId;
    /** Undo of a change that moved the default, its definition's own change with it, in one request. */
    const undoWithDefault = (moved: SubagentDefaultChange, definition: SubagentDefaultUndoRequest["definition"], heading: string, message: string | null) =>
      act(() => undoSubagentDefaultChange({ ...(definition ? { definition } : {}),
        restore: { expected: defaultLeft, target: moved.previous?.definitionId ?? null } }),
      (result) => movedOnly && result === "changed" ? null
        : { heading, message: [message, defaultUndoNote(moved, result)].filter(Boolean).join(" ") }, "Undo failed. Try again.");
    const undo = created
      ? change ? () => undoWithDefault(change, { expectedVersion: card.definitionVersion, id: card.definitionId, revisionId: null },
        "Sub-agent removed", "Undone: the sub-agent is deleted.")
        : () => act(() => deleteSubagentDefinition(card.definitionId, card.definitionVersion),
          { heading: "Sub-agent removed", message: "Undone: the sub-agent is deleted." }, "Undo failed. Try again.")
      : change ? () => undoWithDefault(change,
        undoRevisionId ? { expectedVersion: card.definitionVersion, id: card.definitionId, revisionId: undoRevisionId } : undefined,
        "Change undone", undoRevisionId ? "The sub-agent is back to its previous version." : null)
        : undoRevisionId ? () => act(() => restoreSubagentRevision(card.definitionId, card.definitionVersion, undoRevisionId),
          { heading: "Change undone", message: "The sub-agent is back to its previous version." }, "Undo failed. Try again.") : null;
    const renamed = card.previousName ? `Renamed from “${card.previousName}”.` : null;
    const moveHeading = change?.isDefault ? "Default sub-agent set" : "Default sub-agent cleared";
    const moveDetail = change && (change.isDefault
      ? `New sub-agents start it from your next message on. Before: ${defaultBefore(change)}.` : "New sub-agents use the built-in from your next message on.");
    return (
      <CardV2 error={state.error} heading={outcome?.heading ?? (created ? "Sub-agent created" : movedOnly ? moveHeading : "Sub-agent updated")} headingRef={state.headingRef}
        icon="bot" name={card.name} resource="subagent" state={outcome ? "done" : remote} status={outcome?.message ?? remoteStatus}
        meta={created ? change ? "now your default" : null
          : movedOnly ? change?.isDefault ? `before: ${defaultBefore(change)}` : "new sub-agents use the built-in"
            : card.changes.map((entry) => SUBAGENT_FIELDS[entry.field]).join(", ") || null}
        detail={created || movedOnly ? moveDetail : [renamed, ...card.changes.filter((entry) => entry.field !== "name")
          .map((entry) => `${SUBAGENT_FIELDS[entry.field]}${entry.summary ? `: ${entry.summary}` : " changed"}`)].filter(Boolean).join("\n") || null}
        actions={<>
          {outcome || settled || !undo ? null
            : <UndoButtonV2 busy={state.busy} label={created ? `Undo creating ${card.name}` : `Undo changes to ${card.name}`} onClick={undo} />}
          {remote === "missing" || (created && outcome) ? null : open}
        </>}>
        {!created && card.instructionsDiff && card.changes.some((entry) => entry.field === "instructions")
          ? <DiffV2 diff={card.instructionsDiff} label={`Changes in the instructions of ${card.name}`} /> : null}
      </CardV2>
    );
  }
  const asking = !outcome && !settled;
  const threads = card.consequences?.threadCount ?? 0;
  return (
    <CardV2 actions={asking || remote === "missing" ? null : open} error={state.error}
      heading={outcome?.heading ?? (remote === "missing" ? "Sub-agent already deleted" : settled ? "Sub-agent not deleted" : "Delete sub-agent?")}
      headingRef={state.headingRef} icon="bot" name={card.name} resource="subagent" state={outcome ? "done" : asking ? "asking" : remote}
      status={outcome?.message ?? (remote === "missing" ? null : remoteStatus)}
      confirm={asking ? (
        <ConfirmV2 busy={state.busy} confirmLabel="Delete sub-agent" keepLabel="Keep sub-agent" label={`Delete ${card.name}`}
          text={`Delete “${card.name}” with all its versions? This cannot be undone.`}
          onConfirm={() => act(() => deleteSubagentDefinition(card.definitionId, card.definitionVersion), { heading: "Sub-agent deleted", message: null },
            "The sub-agent could not be deleted. Try again.")}
          onKeep={() => state.finish({ heading: "Sub-agent kept", message: null })} />
      ) : null}>
      {asking ? (
        <ul className="v2-resource-change-card-consequences" aria-label="What deleting changes">
          <li>The agent can no longer start it.</li>
          {threads > 0 ? <li>{`${plural(threads, "sub-agent", "sub-agents")} in your chats started as it keep their work but cannot be continued.`}</li> : null}
          {card.consequences?.isDefault ? <li>It is your default sub-agent, so new sub-agents go back to the built-in.</li> : null}
        </ul>
      ) : null}
    </CardV2>
  );
}

function ResourceChangeCardV2({ card, live }: Readonly<{ card: ResourceChangeCard; live: boolean }>) {
  switch (card.resource) {
    case "secret": return <SecretCardV2 card={card} live={live} />;
    case "skill": return <SkillDeleteCardV2 card={card} live={live} />;
    case "assistant": return <AssistantCardV2 card={card} live={live} />;
    case "subagent": return <SubagentCardV2 card={card} live={live} />;
  }
}

/**
 * Changes the answer made to the user's own secrets and Assistants, and its
 * proposals to delete or publish one: a change already happened and offers
 * Undo where AIQSA can reverse it; a proposal asks inline, and only the
 * user's click performs it through the Studio routes, guarded by the version
 * the card names. `live`: the answer is still running. `navigation`: how the
 * shell opens the cards' links.
 */
export function ResourceChangeCardsV2({ cards, live = false, navigation = NO_NAVIGATION }: Readonly<{
  cards: readonly ResourceChangeCard[];
  live?: boolean;
  navigation?: ResourceChangeNavigationV2;
}>) {
  if (cards.length === 0) return null;
  return (
    <CardNavigationContext.Provider value={navigation}>
      <section className="v2-resource-change-cards" aria-label="Changes to your resources">
        <ul>{cards.map((card) => <ResourceChangeCardV2 key={resourceChangeCardKey(card)} card={card} live={live} />)}</ul>
      </section>
    </CardNavigationContext.Provider>
  );
}
