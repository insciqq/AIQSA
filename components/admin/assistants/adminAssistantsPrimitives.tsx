"use client";

import { UiV2Chip } from "@/components/ui-v2";
import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
import type { KeyboardEvent } from "react";

/** The Assistant's generated avatar, or its initial on a quiet tile when it has none. */
export function AdminAssistantTile({ avatar, name, size }: Readonly<{
  avatar: AssistantAvatarRecipe | null;
  name: string;
  size: 40 | 64;
}>) {
  if (avatar) return <AssistantAvatarV2 className="shrink-0" recipe={avatar} size={size} />;
  return (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center border border-trace-strong bg-control-surface font-semibold text-ink-secondary ${
        size === 64 ? "size-16 rounded-[16px] text-xl" : "size-10 rounded-[10px] text-sm"
      }`}
    >
      {name.trim().slice(0, 1).toLocaleUpperCase() || "·"}
    </span>
  );
}

export type AdminAssistantRequestStatus = "approved" | "outdated" | "pending" | "rejected";

const statusCopy: Record<AdminAssistantRequestStatus, { label: string; tone: "neutral" | "ok" | "warn" }> = {
  approved: { label: "Approved", tone: "ok" },
  outdated: { label: "Outdated", tone: "neutral" },
  pending: { label: "Pending", tone: "warn" },
  rejected: { label: "Rejected", tone: "neutral" }
};

export function RequestStatusChip({ status }: Readonly<{ status: AdminAssistantRequestStatus }>) {
  return <UiV2Chip tone={statusCopy[status].tone}>{statusCopy[status].label}</UiV2Chip>;
}

const featuredOptions = [
  { label: "On", value: true },
  { label: "Off", value: false }
] as const;

/**
 * Featured On/Off for one listed Assistant: the settings segment anatomy with
 * roving focus. Each choice is an immediate write, so a busy row ignores input
 * instead of disabling the buttons, which would drop keyboard focus.
 */
export function FeaturedToggle({ busy, featured, name, onChange }: Readonly<{
  busy: boolean;
  featured: boolean;
  name: string;
  onChange(next: boolean): void;
}>) {
  const choose = (next: boolean) => {
    if (!busy && next !== featured) onChange(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
    (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
    choose(featuredOptions[next]!.value);
  };
  return (
    <div aria-busy={busy || undefined} aria-label={`Featured: ${name}`} className="v2-settings-segment" data-focus-target="featured" role="radiogroup">
      {featuredOptions.map((option, index) => {
        const selected = option.value === featured;
        return (
          <button
            aria-checked={selected}
            className="v2-settings-segment-option v2-focusable"
            data-selected={selected || undefined}
            key={option.label}
            onClick={() => choose(option.value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            role="radio"
            tabIndex={selected ? 0 : -1}
            type="button"
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
