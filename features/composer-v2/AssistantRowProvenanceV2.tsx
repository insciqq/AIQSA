"use client";

import type { ShellComposerAssistant } from "@/components/app-shell/powerAppShellV2Contracts";
import { UiV2Icon, type UiV2IconName } from "@/components/ui-v2";
import type { AssistantRowKey, AssistantRowValues } from "@/lib/contracts/assistants";
import type { ReactNode } from "react";

/** What the composer controls need of the chat's Assistant (`composer.assistant` in the shell). */
export type ComposerV2Assistant = Readonly<{
  current: ShellComposerAssistant | null;
  resetRow(row: AssistantRowKey): void;
}>;

export type BoundComposerAssistantV2 = Extract<ShellComposerAssistant, { state: "bound" }>;

/**
 * The Assistant's part in one row, as every control shows it:
 * - `fixed`: the Assistant's value; the control's options are disabled.
 * - `adjustable`: the Assistant's value, or the user's own after a change for this chat.
 * - `fallback`: the Assistant's value is unavailable to the user; their default (in a
 *   Project chat, the Project's) applies.
 * - `own`: the Assistant leaves the row to the user's defaults (inherit).
 */
export type AssistantRowProvenanceV2 = Readonly<{
  assistantName: string;
  changed: boolean;
  fallbackValue: string;
  /** The fallback value reads as a plural: several dependencies, or a plural row word. */
  fallbackPlural: boolean;
  kind: "adjustable" | "fallback" | "fixed" | "own";
  /** The quiet dot: the effective value is the Assistant's. */
  marker: boolean;
  /** A Project chat: a fallback row uses the Project's default. */
  project?: boolean;
  row: AssistantRowKey;
}>;

const FALLBACK_VALUES: Readonly<Record<AssistantRowKey, string>> = {
  controls: "parameters",
  knowledge: "Knowledge",
  model: "recommended model",
  search: "web search",
  skills: "Skills",
  tools: "MCP servers"
};

/* Row words and the server's unnamed MCP placeholder that take "aren't". */
const PLURAL_FALLBACK_VALUES = new Set(["MCP servers", "Required MCP tools", "Skills", "parameters"]);

export function boundComposerAssistantV2(
  assistant: ComposerV2Assistant | null | undefined
): BoundComposerAssistantV2 | null {
  return assistant?.current?.state === "bound" ? assistant.current : null;
}

function assistantSetsRow(row: AssistantRowKey, value: AssistantRowValues[AssistantRowKey]): boolean {
  if (row === "controls") return Object.keys(value).length > 0;
  return !("mode" in value) || value.mode !== "inherit";
}

export function assistantRowProvenance(
  assistant: BoundComposerAssistantV2 | null,
  row: AssistantRowKey
): AssistantRowProvenanceV2 | null {
  if (!assistant) return null;
  const state = assistant.rows[row];
  const dependencies = state.deviation?.dependencies?.map((dependency) => dependency.name) ?? [];
  const kind: AssistantRowProvenanceV2["kind"] = state.policy === "fixed"
    ? "fixed"
    : state.origin === "fallback"
      ? "fallback"
      : assistantSetsRow(row, state.assistantValue) ? "adjustable" : "own";
  const fallbackValue = dependencies.length > 0 ? dependencies.join(", ") : FALLBACK_VALUES[row];
  return {
    assistantName: assistant.name,
    changed: state.origin === "chat",
    fallbackPlural: dependencies.length > 1 || PLURAL_FALLBACK_VALUES.has(fallbackValue),
    fallbackValue,
    kind,
    marker: state.origin === "assistant",
    ...(assistant.project ? { project: true } : {}),
    row
  };
}

/**
 * The menu's first line; null while the row is the user's own and unchanged.
 * A changed row names the Assistant's value (`assistantValue`, in the chip's
 * words) when the user can see it.
 */
export function assistantRowNoticeText(
  provenance: AssistantRowProvenanceV2 | null,
  assistantValue?: string | null
): string | null {
  if (provenance?.changed) {
    return assistantValue
      ? `Changed for this chat · ${provenance.assistantName} starts with ${assistantValue}`
      : "Changed for this chat";
  }
  switch (provenance?.kind) {
    case "fixed":
      return `Fixed by ${provenance.assistantName}`;
    case "adjustable":
      return `From ${provenance.assistantName} · adjustable for this chat`;
    case "fallback": {
      const unavailable = `${provenance.assistantName}'s ${provenance.fallbackValue} ${provenance.fallbackPlural ? "aren't" : "isn't"}`;
      return provenance.project
        ? `${unavailable} available in this Project; using the Project default`
        : `${unavailable} available to you; using your default`;
    }
    default:
      return null;
  }
}

/**
 * The chip description's text equivalent of the dot and the menu line: the
 * line's leading phrase, so chip and menu never disagree.
 */
export function assistantRowDescription(provenance: AssistantRowProvenanceV2 | null): string {
  if (!provenance) return "";
  if (provenance.changed) return " · Changed for this chat";
  if (provenance.kind === "fallback") return ` · ${assistantRowNoticeText(provenance)}`;
  if (provenance.kind === "fixed") return ` · Fixed by ${provenance.assistantName}`;
  return provenance.kind === "adjustable" ? ` · From ${provenance.assistantName}` : "";
}

/** "Reset to Assistant" is offered for a changed adjustable row and for a changed own row. */
export function assistantRowResettable(provenance: AssistantRowProvenanceV2 | null): boolean {
  return provenance?.kind === "adjustable" || (provenance?.kind === "own" && provenance.changed);
}

const NOTICE_ICONS: Readonly<Record<AssistantRowProvenanceV2["kind"], UiV2IconName>> = {
  adjustable: "edit",
  fallback: "alert",
  fixed: "lock",
  own: "edit"
};

/** The first line of a control that shows the Assistant's part in its row. */
export function AssistantRowNoticeV2({
  action,
  kind,
  text
}: Readonly<{
  action?: ReactNode;
  kind: AssistantRowProvenanceV2["kind"];
  text: string;
}>) {
  return (
    <div className="v2-composer-provenance" data-kind={kind} data-testid="assistant-row-provenance">
      <UiV2Icon name={NOTICE_ICONS[kind]} />
      <span>{text}</span>
      {action}
    </div>
  );
}
