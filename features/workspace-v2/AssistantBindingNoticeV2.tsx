"use client";

import { UiV2Button, UiV2Icon } from "@/components/ui-v2";
import type { ShellComposerAssistant } from "@/components/app-shell/powerAppShellV2Contracts";
import type { AssistantAvailabilityReason } from "@/lib/contracts/assistants";
import { useRef, type ReactNode } from "react";
import { useComposerFocusHandoffV2 } from "./AssistantStripV2";

/** The composer's status line while the chat's Assistant blocks sending. */
export const ASSISTANT_SEND_GATE_HINT = "Nothing is sent until you choose.";

/* Server placeholders that stand for a dependency without naming it. */
const UNNAMED_DEPENDENCIES = new Set(["Required MCP tools", "Saved model"]);

const OWNER_REASON_HEADLINES: Readonly<Record<Exclude<AssistantAvailabilityReason, "archived">, string>> = {
  knowledge_access: "The Assistant's Knowledge isn't available.",
  knowledge_not_ready: "The Assistant's Knowledge has no ready documents yet.",
  knowledge_unavailable: "The Assistant's Knowledge can't be checked right now.",
  model_access: "The Assistant's model isn't available.",
  search_access: "The Assistant's Search isn't available.",
  skills_access: "The Assistant's Skills aren't available.",
  tools_access: "The Assistant's MCP tools aren't available."
};

const CONSUMER_HEADLINE = "This Assistant isn't available to you right now.";
const ARCHIVED_BY_OWNER_HEADLINE = "This Assistant was archived by its owner.";

export type AssistantBindingNoticeCopyV2 = Readonly<{
  /** The owner's repair route for this state. */
  action: "restore" | "studio" | null;
  detail: string | null;
  headline: string;
}>;

/**
 * Copy for a chat whose Assistant blocks sending (PRD 5.5, 10.7). Only the
 * owner's projection carries dependency names; a consumer receives the
 * neutral sentence, or that its owner archived the Assistant, so a name they
 * cannot access never appears.
 */
export function assistantBindingNoticeCopyV2(
  current: ShellComposerAssistant | null
): AssistantBindingNoticeCopyV2 | null {
  if (!current) return null;
  if (current.state !== "bound") {
    const headline = current.state === "deleted"
      ? "This Assistant was deleted."
      : current.reason === "archived" ? ARCHIVED_BY_OWNER_HEADLINE : CONSUMER_HEADLINE;
    return { action: null, detail: null, headline };
  }
  const availability = current.availability;
  if (availability.ok) return null;
  if (availability.reason === "archived") {
    return current.owned
      ? { action: "restore", detail: null, headline: "You archived this Assistant." }
      : { action: null, detail: null, headline: ARCHIVED_BY_OWNER_HEADLINE };
  }
  if (!current.owned) return { action: null, detail: null, headline: CONSUMER_HEADLINE };
  const names = (availability.dependencies ?? [])
    .map((dependency) => dependency.name)
    .filter((name) => !UNNAMED_DEPENDENCIES.has(name));
  const headline = names.length === 0
    ? OWNER_REASON_HEADLINES[availability.reason]
    : names.length === 1
      ? `${names[0]} isn't available.`
      : `${names.slice(0, -1).join(", ")} and ${names.at(-1)} aren't available.`;
  return { action: "studio", detail: "Fix the Assistant or continue without it.", headline };
}

type AssistantBindingNoticePropsV2 = Readonly<{
  current: ShellComposerAssistant | null;
  onChooseAnother(): void;
  onContinueWithout(): void;
  /** Absent where Studio is not the owner's repair route (inside a Project). */
  onOpenInStudio?: ((assistantId: string) => void) | null;
  onRestore?: ((assistantId: string) => void) | null;
  pending: boolean;
  /** Focuses the composer's message field. */
  restoreFocus?: () => void;
}>;

const noFocusTarget = () => undefined;

/**
 * The notice above the composer while the chat's Assistant is unavailable,
 * archived or deleted. Sending stays blocked until the user takes one of the
 * offered actions; nothing replaces the Assistant silently.
 */
export function AssistantBindingNoticeV2(props: AssistantBindingNoticePropsV2) {
  const copy = assistantBindingNoticeCopyV2(props.current);
  if (!copy || !props.current) return null;
  return <BindingNoticeV2 {...props} copy={copy} current={props.current} />;
}

/**
 * While an action runs its choices stay focusable and ignore presses, so a
 * failure that keeps the notice leaves focus on the button pressed; an action
 * that makes the chat usable removes the notice and hands focus to the
 * message field.
 */
function BindingNoticeV2({
  copy,
  current,
  onChooseAnother,
  onContinueWithout,
  onOpenInStudio,
  onRestore,
  pending,
  restoreFocus
}: AssistantBindingNoticePropsV2 & Readonly<{ copy: AssistantBindingNoticeCopyV2; current: ShellComposerAssistant }>) {
  const noticeRef = useRef<HTMLDivElement>(null);
  useComposerFocusHandoffV2(noticeRef, true, restoreFocus ?? noFocusTarget);
  const assistantId = current.state === "bound" ? current.id : null;
  const choice = (label: string, action: () => void): ReactNode => (
    <UiV2Button
      aria-disabled={pending || undefined}
      onClick={() => {
        if (!pending) action();
      }}
    >
      {label}
    </UiV2Button>
  );
  const repair = assistantId && copy.action === "studio" && onOpenInStudio
    ? choice("Open in Studio", () => onOpenInStudio(assistantId))
    : assistantId && copy.action === "restore" && onRestore
      ? choice("Restore", () => onRestore(assistantId))
      : null;

  return (
    <div className="v2-assistant-notice" data-testid="assistant-binding-notice" ref={noticeRef}>
      <UiV2Icon name="alert" />
      <p className="v2-assistant-notice-copy" role="status">
        <strong>{copy.headline}</strong>
        {copy.detail ? <small>{copy.detail}</small> : null}
      </p>
      <div className="v2-assistant-notice-actions">
        {repair}
        {choice("Choose another", onChooseAnother)}
        {choice("Continue without the Assistant", onContinueWithout)}
      </div>
    </div>
  );
}
