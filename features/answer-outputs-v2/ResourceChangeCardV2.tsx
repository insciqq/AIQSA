"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { UiV2Button, UiV2Icon, type UiV2IconName } from "@/components/ui-v2";
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
  type SkillDeleteProposalCard
} from "@/lib/contracts/resourceChanges";
import { SKILL_LIBRARY_PATH } from "@/lib/contracts/skillSaves";
import { formatAssistantEntryPath } from "@/lib/domain/chatRoute";
import type { WorkspaceSecretKind } from "@/lib/contracts/workspaceSecrets";
import { deleteSecretVersion, readSecretState, ResourceChangeApiError } from "./resourceChangeApi";

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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const quoted = (names: readonly string[]) => names.map((name) => `“${name}”`).join(", ");

function CardLinkV2({ href, icon, children }: Readonly<{ href: string; icon: UiV2IconName; children: ReactNode }>) {
  return (
    <Link className="v2-resource-change-card-link v2-focusable" href={href}>
      <UiV2Icon name={icon} />
      <span>{children}</span>
    </Link>
  );
}

/**
 * "Start a chat" with an Assistant. The shell reads `/assistant/<id>` only on
 * load and on history traversal, so a framework link from inside a chat would
 * change the address and keep showing that chat: a plain click goes through
 * the shell's navigation instead. Modified clicks keep the link's own
 * behavior, and without a shell handler the browser loads the entry page.
 */
function StartAssistantChatLinkV2({ assistantId, onStart }: Readonly<{ assistantId: string; onStart?: (assistantId: string) => void }>) {
  return (
    <a className="v2-resource-change-card-link v2-focusable" href={formatAssistantEntryPath(assistantId)}
      onClick={(event) => {
        if (!onStart || event.defaultPrevented || event.button !== 0 ||
          event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onStart(assistantId);
      }}>
      <UiV2Icon name="chat" />
      <span>Start a chat</span>
    </a>
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

function CardV2({ actions, children, confirm, error, heading, headingRef, icon, name, resource, state, status }: Readonly<{
  actions?: ReactNode;
  children?: ReactNode;
  confirm?: ReactNode;
  error: string | null;
  heading: string;
  headingRef: RefObject<HTMLParagraphElement | null>;
  icon: UiV2IconName;
  name: string;
  resource: ResourceChangeCard["resource"];
  state: string;
  status: string | null;
}>) {
  const headingId = useId();
  return (
    <li className="v2-resource-change-card" data-resource={resource} data-state={state} data-testid="resource-change-card" aria-labelledby={headingId}>
      <span className="v2-resource-change-card-tile" aria-hidden="true"><UiV2Icon name={icon} /></span>
      <div className="v2-resource-change-card-copy">
        <p className="v2-resource-change-card-heading" id={headingId} ref={headingRef} tabIndex={-1}>{heading}</p>
        <strong title={name}>{name}</strong>
        {children}
      </div>
      {actions ? <div className="v2-resource-change-card-actions">{actions}</div> : null}
      {confirm}
      {status ? <p className="v2-resource-change-card-status" role="status">{status}</p> : null}
      {error ? <p className="v2-resource-change-card-error" role="alert">{error}</p> : null}
    </li>
  );
}

/** Local card state: the user's outcome on this page, the resource as read now, a request in flight and its error. */
function useCardState(card: ResourceChangeCard) {
  const key = resourceChangeCardKey(card);
  const headingRef = useRef<HTMLParagraphElement>(null);
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

  const kind = `${SECRET_KINDS[card.kind]}${card.envNames.length ? ` · ${card.envNames.join(", ")}` : ""}`;
  const link = <CardLinkV2 href={SECRETS_LIBRARY_PATH} icon="key">Open Secrets</CardLinkV2>;
  if (card.action === "updated") {
    return (
      <CardV2 actions={link} error={null} heading={card.previousName && !card.valueReplaced ? "Secret renamed" : "Secret updated"}
        headingRef={state.headingRef} icon="key" name={card.name} resource="secret" state="done" status={null}>
        <small>{kind}</small>
        {card.previousName ? <small>Renamed from “{card.previousName}”.</small> : null}
        {card.valueReplaced ? <small>The value was replaced; earlier values are not kept.</small> : null}
      </CardV2>
    );
  }
  if (card.action === "created") {
    const gone = remote === "missing" || remote === "changed";
    return (
      <CardV2 error={state.error} heading={outcome?.heading ?? "Secret saved"} headingRef={state.headingRef} icon="key" name={card.name}
        resource="secret" state={outcome ? "done" : remote} status={outcome?.message ?? (remote === "missing" ? "This secret no longer exists."
          : remote === "changed" ? "Undo is not available: the secret changed after this, and that change is kept." : null)}
        actions={outcome ? null : <>
          {gone ? null : (
            <UiV2Button busy={state.busy} disabled={state.busy} icon="history" type="button" aria-label={`Undo saving ${card.name}`}
              onClick={() => remove(true)}>Undo</UiV2Button>
          )}
          {link}
        </>}>
        <small>{kind}</small>
      </CardV2>
    );
  }
  const asking = !outcome && remote !== "missing" && remote !== "changed";
  return (
    <CardV2 actions={asking || outcome ? null : link} error={state.error}
      heading={outcome?.heading ?? (remote === "missing" ? "Secret already deleted" : remote === "changed" ? "Secret not deleted" : "Delete secret?")}
      headingRef={state.headingRef}
      icon="key" name={card.name} resource="secret" state={outcome ? "done" : asking ? "asking" : remote}
      status={outcome?.message ?? (remote === "changed" ? "The secret changed after this proposal, so nothing was deleted. Review it in Studio › Secrets." : null)}
      confirm={asking ? (
        <ConfirmV2 busy={state.busy} confirmLabel="Delete secret" keepLabel="Keep secret" label={`Delete ${card.name}`}
          text={`Delete “${card.name}”? Chats and the Workspace stop receiving it. This cannot be undone.`}
          onConfirm={() => remove(false)} onKeep={() => state.finish({ heading: "Secret kept", message: null })} />
      ) : null}>
      <small>{kind}</small>
    </CardV2>
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
    ...card.scheduledTasks.length ? [`Pinned by scheduled tasks ${quoted(card.scheduledTasks.map((task) => task.title))}; their next runs fail until they are changed.`] : []
  ];
  return (
    <CardV2 actions={asking ? null : <CardLinkV2 href={SKILL_LIBRARY_PATH} icon="library">Open library</CardLinkV2>} error={state.error}
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

function AssistantCardV2({ card, live, onStartAssistantChat }: Readonly<{
  card: AssistantChangeCard;
  live: boolean;
  onStartAssistantChat?: (assistantId: string) => void;
}>) {
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

  const open = <CardLinkV2 href={assistantLibraryPath(card.assistantId)} icon="assistant">Open in Studio</CardLinkV2>;
  const remoteStatus = remote === "missing" ? "This Assistant no longer exists."
    : remote === "archived" ? "The Assistant is archived; restore it in Studio › Assistants first."
      : remote === "changed" ? card.action === "created"
        ? "Undo is not available: the Assistant changed after this, and that change is kept."
        : "The Assistant changed after this proposal, so nothing was done. Review it in Studio › Assistants." : null;
  const settled = remote === "missing" || remote === "archived" || remote === "changed";

  if (card.action === "updated") {
    return (
      <CardV2 actions={open} error={null} heading="Assistant updated" headingRef={state.headingRef} icon="assistant" name={card.name}
        resource="assistant" state="done" status={null}>
        <ul className="v2-resource-change-card-changes" aria-label={`Changes to ${card.name}`}>
          {card.changes.map((change) => (
            <li key={change.field}>
              <strong>{ASSISTANT_FIELDS[change.field]}</strong>{change.summary ? `: ${change.summary}` : " changed"}
              {change.field === "instructions" && card.instructionsDiff ? <DiffV2 diff={card.instructionsDiff} label={`Changes in the instructions of ${card.name}`} /> : null}
            </li>
          ))}
        </ul>
      </CardV2>
    );
  }
  if (card.action === "created") {
    return (
      <CardV2 error={state.error} heading={outcome?.heading ?? "Assistant created"} headingRef={state.headingRef} icon="assistant" name={card.name}
        resource="assistant" state={outcome ? "done" : remote} status={outcome?.message ?? remoteStatus}
        actions={<>
          {outcome || settled ? null : (
            <UiV2Button busy={state.busy} disabled={state.busy} icon="history" type="button" aria-label={`Undo creating ${card.name}`}
              onClick={() => act(() => setAssistantArchived(card.assistantId, card.definitionVersion, true),
                { heading: "Assistant archived", message: "Undone: the Assistant is archived. You can restore it in Studio › Assistants." }, "Undo failed. Try again.")}>
              Undo
            </UiV2Button>
          )}
          {outcome || remote === "missing" ? null : <StartAssistantChatLinkV2 assistantId={card.assistantId} onStart={onStartAssistantChat} />}
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
      icon="share" name={card.name} resource="assistant" state={outcome ? "done" : asking ? "asking" : remote} status={outcome?.message ?? remoteStatus}
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
      ) : null}>
      <small>{audience?.kind === "group" ? `To ${audience.groupName}` : "For everyone"}</small>
    </CardV2>
  );
}

function ResourceChangeCardV2({ card, live, onStartAssistantChat }: Readonly<{
  card: ResourceChangeCard;
  live: boolean;
  onStartAssistantChat?: (assistantId: string) => void;
}>) {
  switch (card.resource) {
    case "secret": return <SecretCardV2 card={card} live={live} />;
    case "skill": return <SkillDeleteCardV2 card={card} live={live} />;
    case "assistant": return <AssistantCardV2 card={card} live={live} onStartAssistantChat={onStartAssistantChat} />;
  }
}

/**
 * Changes the answer made to the user's own secrets and Assistants, and its
 * proposals to delete or publish one: a change already happened and offers
 * Undo where AIQSA can reverse it; a proposal asks inline, and only the
 * user's click performs it through the Studio routes, guarded by the version
 * the card names. `live`: the answer is still running. `onStartAssistantChat`
 * opens a new chat with an Assistant through the shell's navigation.
 */
export function ResourceChangeCardsV2({ cards, live = false, onStartAssistantChat }: Readonly<{
  cards: readonly ResourceChangeCard[];
  live?: boolean;
  onStartAssistantChat?: (assistantId: string) => void;
}>) {
  if (cards.length === 0) return null;
  return (
    <section className="v2-resource-change-cards" aria-label="Changes to your resources">
      <ul>{cards.map((card) => <ResourceChangeCardV2 key={resourceChangeCardKey(card)} card={card} live={live} onStartAssistantChat={onStartAssistantChat} />)}</ul>
    </section>
  );
}
