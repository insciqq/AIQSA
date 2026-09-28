"use client";

import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { UiV2Icon, UiV2MenuItem, UiV2MenuSeparator } from "@/components/ui-v2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { assistantBylineV2 } from "@/features/composer-v2/AssistantPickerV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import type { ShellComposerAssistant, ShellComposerView } from "@/components/app-shell/powerAppShellV2Contracts";
import type { AssistantRowKey } from "@/lib/contracts/assistants";
import type { CatalogModel } from "@/components/app-shell/types";
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { ASSISTANT_SEND_GATE_HINT } from "./AssistantBindingNoticeV2";
import { WIDTH_TOLERANCE_PX } from "./AssistantStripV2";

export type HeaderAssistantSelectorActionsV2 = Pick<
  ShellComposerView["assistant"],
  | "canSaveChatSetup"
  | "continueWithout"
  | "copyLink"
  | "current"
  | "editById"
  | "openPicker"
  | "pending"
  | "remove"
  | "restore"
  | "saveChatSetup"
  | "setPickerOpen"
>;

type BoundAssistant = Extract<ShellComposerAssistant, { state: "bound" }>;

const ROW_LABELS: Readonly<Record<AssistantRowKey, string>> = {
  controls: "parameters",
  knowledge: "Knowledge",
  model: "model",
  search: "Search",
  skills: "Skills",
  tools: "MCP"
};

function listText(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The selector's name for a binding that blocks sending, or null; a bound Assistant's name follows it. */
export function blockedAssistantLabelV2(current: ShellComposerAssistant): string | null {
  if (current.state !== "bound") {
    return current.state === "deleted"
      ? "Assistant deleted"
      : current.reason === "archived" ? "Assistant archived" : "Assistant unavailable";
  }
  if (current.availability.ok) return null;
  return current.availability.reason === "archived" ? "Assistant archived" : "Assistant unavailable";
}

/**
 * The selector's shorter text for a binding that blocks sending, where its
 * whole label does not fit: the state word alone (the avatar or the icon
 * beside it stands for the Assistant, and the accessible name stays complete).
 */
function blockedAssistantWordV2(label: string): string {
  const state = label.replace(/^Assistant /u, "");
  return `${state.charAt(0).toUpperCase()}${state.slice(1)}`;
}

/**
 * The selector's forms, widest first: its label (the chosen Assistant's name,
 * or a blocking binding's whole label), a blocking binding's state word, then
 * the avatar or icon alone.
 */
export type HeaderAssistantFitV2 = "icon" | "label" | "word";

/** A chosen Assistant's name is never shortened below about this many characters. */
const NAME_MIN_CHARACTERS = 6;

/**
 * The widest form of the selector whose label fits `room`, the width the
 * header leaves the selector while the chat title is at its narrowest and the
 * model name is whole. `chrome` is everything but the label (padding, border,
 * avatar, chevron and gaps); `minimum` is the narrowest a label may be shown.
 */
export function headerAssistantFitV2(input: Readonly<{
  chrome: number;
  labels: readonly Readonly<{ fit: Exclude<HeaderAssistantFitV2, "icon">; minimum: number }>[];
  room: number;
}>): HeaderAssistantFitV2 {
  const fitting = input.labels.find((label) => input.chrome + label.minimum <= input.room + WIDTH_TOLERANCE_PX);
  return fitting?.fit ?? "icon";
}

/** A text's whole width up to its own cap, whether or not it is shown or shortened now. */
function naturalTextWidth(element: Element): number {
  const cap = parseFloat(getComputedStyle(element).maxWidth);
  return Math.min(element.scrollWidth, Number.isFinite(cap) ? cap : Number.POSITIVE_INFINITY);
}

function boxWidth(element: Element | null): number {
  return element?.getBoundingClientRect().width ?? 0;
}

/**
 * Measures the header around the selector. The title yields first, down to
 * its minimum width, and the model name last; the other groups keep their
 * width. Nothing measured depends on the form shown, so switching forms never
 * changes the answer. Null without a laid-out header.
 */
function measureHeaderAssistantFit(button: HTMLElement): HeaderAssistantFitV2 | null {
  const island = button.parentElement;
  const header = island?.closest<HTMLElement>(".v2-live-header");
  if (!island || !header) return null;
  const headerStyle = getComputedStyle(header);
  const content = header.clientWidth - (parseFloat(headerStyle.paddingLeft) || 0) - (parseFloat(headerStyle.paddingRight) || 0);
  if (content <= 0) return null;
  const groups = [...header.children].filter((group) => (
    group.getClientRects().length > 0 && getComputedStyle(group).position !== "absolute"
  ));
  let used = (parseFloat(headerStyle.columnGap) || 0) * Math.max(0, groups.length - 1);
  for (const group of groups) {
    if (group === island) continue;
    used += group.classList.contains("v2-live-title")
      ? parseFloat(getComputedStyle(group).minWidth) || 0
      : boxWidth(group);
  }
  const islandGap = parseFloat(getComputedStyle(island).columnGap) || 0;
  for (const item of island.children) {
    if (item === button || item.getClientRects().length === 0) continue;
    const name = item.querySelector(".v2-live-model-name");
    used += boxWidth(item) + islandGap + (name ? Math.max(0, naturalTextWidth(name) - boxWidth(name)) : 0);
  }

  // The icon form keeps the same padding and border, so the label forms'
  // chrome reads the same from any form.
  const style = getComputedStyle(button);
  const chrome = [style.borderLeftWidth, style.borderRightWidth, style.paddingLeft, style.paddingRight]
    .reduce((sum, value) => sum + (parseFloat(value) || 0), 0) +
    boxWidth(button.firstElementChild) + boxWidth(button.querySelector(".v2-live-assistant-chevron")) +
    (parseFloat(style.columnGap) || 0) * 2;
  const labels = [...button.querySelectorAll<HTMLElement>("[data-label]")].map((label) => {
    const natural = naturalTextWidth(label);
    const characters = [...(label.textContent ?? "")].length;
    // Only a chosen Assistant's name may shorten; a state never does.
    const minimum = label.dataset.shorten === undefined || characters <= NAME_MIN_CHARACTERS
      ? natural
      : (natural / characters) * NAME_MIN_CHARACTERS;
    return { fit: label.dataset.label as Exclude<HeaderAssistantFitV2, "icon">, minimum };
  });
  return headerAssistantFitV2({ chrome, labels, room: content - used });
}

/** Keeps the selector's form current as the header, its groups and its texts change size. */
function useHeaderAssistantFit(buttonRef: RefObject<HTMLButtonElement | null>, labelsKey: string | null): HeaderAssistantFitV2 {
  const [fit, setFit] = useState<HeaderAssistantFitV2>("label");
  useLayoutEffect(() => {
    const button = buttonRef.current;
    if (labelsKey === null || !button) return;
    const measure = () => {
      const next = measureHeaderAssistantFit(button);
      if (next) setFit(next);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    const header = button.closest(".v2-live-header");
    for (const element of [
      header,
      ...(header?.children ?? []),
      ...(button.parentElement?.children ?? []),
      ...button.querySelectorAll("[data-label]")
    ]) {
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [buttonRef, labelsKey]);
  return fit;
}

/** The reason line under "Save chat setup to Assistant". */
export function saveChatSetupReasonV2(current: BoundAssistant, canSave: boolean): string {
  if (canSave) return `${listText(current.changedRows.map((row) => ROW_LABELS[row]))} changed for this chat`;
  if (current.scope === "composer" && current.changedRows.length > 0) return "Available after the first message";
  return "Nothing changed for this chat";
}

export type HeaderModelProvenanceV2 = Readonly<{
  /** The model is the Assistant's: the button carries the provenance dot. */
  fromAssistant: boolean;
  /**
   * The Assistant fixes the model: the button shows a lock and opens the
   * picker in its fixed state, for the Parameters row.
   */
  locked: boolean;
  /** A fixed model while the Assistant blocks sending: the button stays disabled. */
  blocked?: boolean;
  /** The button's tooltip. */
  title: string;
}>;

/**
 * Where the header model comes from (PRD 10.6): the Assistant's model shows
 * the dot, a fixed one also the lock; a model changed for this chat names the
 * model the Assistant starts with, in the composer's words, in the tooltip only.
 */
export function headerModelProvenanceV2(
  current: ShellComposerAssistant | null,
  modelName: string,
  models: readonly CatalogModel[]
): HeaderModelProvenanceV2 {
  const fallback = { fromAssistant: false, locked: false, title: "Choose model" };
  if (current?.state !== "bound") return fallback;
  const row = current.rows.model;
  const assistantModelId = row.assistantValue.mode === "model" ? row.assistantValue.modelId : null;
  const assistantModel = assistantModelId
    ? models.find((model) => model.modelId === assistantModelId)?.displayName ?? null
    : null;
  if (row.policy === "fixed") {
    // While the Assistant blocks sending the button explains the gate, not
    // the model, so a consumer never learns which dependency is missing.
    return current.blockReason
      ? { blocked: true, fromAssistant: true, locked: true, title: ASSISTANT_SEND_GATE_HINT }
      : { fromAssistant: true, locked: true, title: `${modelName} · fixed by ${current.name}` };
  }
  switch (row.origin) {
    case "assistant":
      return { fromAssistant: true, locked: false, title: `${modelName} · recommended by ${current.name}` };
    case "chat":
      return {
        fromAssistant: false,
        locked: false,
        title: assistantModel
          ? `Changed for this chat · ${current.name} starts with ${assistantModel}`
          : "Changed for this chat"
      };
    case "fallback":
      return {
        fromAssistant: false,
        locked: false,
        title: current.project
          ? `${current.name}'s model isn't available in this Project; using the Project default`
          : `${current.name}'s model isn't available to you; using your default`
      };
    default:
      return fallback;
  }
}

/**
 * The chat header's Assistant selector (PRD 10.5-10.7), after the model
 * picker. Without an Assistant it is a quiet icon that opens the picker; with
 * one it shows the avatar and name and opens the Assistant menu. A binding
 * that blocks sending reads as such ("Assistant archived") with the error
 * outline. Where the header lacks room it shows the widest form that fits
 * (a blocking binding's state word, then the avatar or icon alone); on phones
 * it is the avatar or icon only, inside the model island. The button element
 * stays the same across states so the picker returns focus to it; an action
 * of the blocked menu that makes the chat usable hands focus on to the
 * message field, and one that fails leaves it on the selector.
 */
export function HeaderAssistantSelectorV2({
  assistant,
  focusComposer,
  triggerRef
}: Readonly<{
  assistant: HeaderAssistantSelectorActionsV2;
  /** Focuses the composer's message field. */
  focusComposer?: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  const { closeForAction, menuRef, triggerRef: dismissalTriggerRef } = useMenuDismissalV2({
    onClose: closeMenu,
    open: menuOpen
  });
  const current = assistant.current;
  const blockedLabel = current ? blockedAssistantLabelV2(current) : null;
  const bound = current?.state === "bound" ? current : null;
  // A Project's Assistant is managed in Project settings; its entry link
  // would open a personal chat.
  const owned = Boolean(bound?.owned && !bound.project);
  const headText = !bound
    ? blockedLabel
    : `${bound.name} · ${assistantBylineV2({
      owned: bound.owned,
      ownerDisplayName: bound.ownerDisplayName,
      projectName: bound.project ? bound.projectName ?? null : undefined
    })}`;
  const label = !current
    ? "Choose an Assistant"
    : blockedLabel
      ? bound ? `${blockedLabel}: ${bound.name}` : blockedLabel
      : `Assistant: ${bound!.name}`;
  const labelsKey = !current ? null : blockedLabel ?? bound!.name;
  const fit = useHeaderAssistantFit(triggerRef, labelsKey);
  // Set by a blocked menu's way out; once the chat is usable, focus left on
  // the selector (or dropped to the page) moves to the message field.
  const leavingBlockRef = useRef(false);
  const focusComposerRef = useRef(focusComposer);
  useLayoutEffect(() => {
    focusComposerRef.current = focusComposer;
  });
  useEffect(() => {
    if (blockedLabel || !leavingBlockRef.current) return;
    leavingBlockRef.current = false;
    const active = document.activeElement;
    if (active && active !== document.body && active !== triggerRef.current) return;
    window.requestAnimationFrame(() => focusComposerRef.current?.());
  }, [blockedLabel, triggerRef]);
  const setTrigger = (element: HTMLButtonElement | null) => {
    triggerRef.current = element;
    dismissalTriggerRef.current = element;
  };
  const runAction = (action: () => void) => {
    closeForAction();
    action();
  };
  /** Restore, Choose another… or Continue without the Assistant. */
  const leaveBlock = (action: () => void) => {
    leavingBlockRef.current = true;
    runAction(action);
  };
  const openPicker = () => (blockedLabel ? leaveBlock : runAction)(() => assistant.setPickerOpen(true));

  return (
    <>
      <button
        ref={setTrigger}
        aria-busy={assistant.pending || undefined}
        aria-expanded={menuOpen || assistant.openPicker}
        aria-haspopup={current ? "menu" : "dialog"}
        aria-label={label}
        className={current ? "v2-live-assistant v2-focusable" : "v2-live-assistant v2-icon-button v2-focusable"}
        data-fit={current ? fit : undefined}
        data-state={!current ? "empty" : blockedLabel ? "blocked" : "chosen"}
        data-testid="header-assistant-selector"
        data-tooltip={current ? undefined : "Choose an Assistant"}
        type="button"
        onClick={() => {
          if (!current) assistant.setPickerOpen(true);
          else setMenuOpen((open) => !open);
        }}
      >
        {bound ? (
          <AssistantAvatarV2 className="v2-live-assistant-avatar" recipe={bound.avatar} size={20} />
        ) : (
          <UiV2Icon name="assistant" />
        )}
        {current ? (
          <>
            {/* Every form stays measurable; CSS shows the one `data-fit` names. */}
            {blockedLabel ? (
              <>
                <span className="v2-live-assistant-name" data-label="label">{blockedLabel}</span>
                <span className="v2-live-assistant-name" data-label="word">{blockedAssistantWordV2(blockedLabel)}</span>
              </>
            ) : (
              <span className="v2-live-assistant-name" data-label="label" data-shorten="">{bound!.name}</span>
            )}
            <UiV2Icon className="v2-live-assistant-chevron" name="chevron-down" />
          </>
        ) : null}
      </button>
      {menuOpen && current ? (
        <UiV2ResponsiveMenu
          align="start"
          anchorRef={triggerRef}
          className="v2-live-assistant-menu"
          label="Assistant"
          menuRef={menuRef}
          onClose={closeMenu}
        >
          <div className="v2-live-assistant-menu-head" data-testid="header-assistant-menu-head" role="presentation">
            {bound ? <AssistantAvatarV2 recipe={bound.avatar} size={20} /> : <UiV2Icon name="assistant" />}
            <span>{headText}</span>
          </div>
          <UiV2MenuItem disabled={assistant.pending} icon="regenerate" onClick={openPicker}>
            {blockedLabel ? "Choose another…" : "Change…"}
          </UiV2MenuItem>
          {owned && bound ? (
            <UiV2MenuItem icon="edit" onClick={() => runAction(() => assistant.editById(bound.id))}>
              Edit Assistant
            </UiV2MenuItem>
          ) : null}
          {owned && bound && !bound.availability.ok && bound.availability.reason === "archived" && assistant.restore ? (
            <UiV2MenuItem
              disabled={assistant.pending}
              icon="archive"
              onClick={() => leaveBlock(() => assistant.restore?.(bound.id))}
            >
              Restore
            </UiV2MenuItem>
          ) : null}
          {owned && bound && !blockedLabel ? (
            <UiV2MenuItem
              disabled={assistant.pending || !assistant.canSaveChatSetup}
              icon="download"
              sub={saveChatSetupReasonV2(bound, assistant.canSaveChatSetup)}
              onClick={() => runAction(assistant.saveChatSetup)}
            >
              Save chat setup to Assistant
            </UiV2MenuItem>
          ) : null}
          {bound && !bound.project && !blockedLabel ? (
            <UiV2MenuItem icon="link" onClick={() => runAction(() => assistant.copyLink(bound.id))}>
              Copy link
            </UiV2MenuItem>
          ) : null}
          <UiV2MenuSeparator />
          {blockedLabel ? (
            <UiV2MenuItem disabled={assistant.pending} icon="close" onClick={() => leaveBlock(assistant.continueWithout)}>
              Continue without the Assistant
            </UiV2MenuItem>
          ) : (
            <UiV2MenuItem
              disabled={assistant.pending}
              icon="close"
              sub="applies to the next messages"
              onClick={() => runAction(assistant.remove)}
            >
              Remove for this chat
            </UiV2MenuItem>
          )}
        </UiV2ResponsiveMenu>
      ) : null}
    </>
  );
}
