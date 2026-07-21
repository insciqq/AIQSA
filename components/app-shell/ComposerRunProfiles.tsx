import {
  findActiveRunProfile,
  resolveRunProfiles,
  type RunProfileId
} from "@/components/app-shell/runProfiles";
import type { Catalog } from "@/components/app-shell/types";
import { useId } from "react";

export function ComposerRunProfiles({
  catalog,
  disabled,
  onSelect,
  reasoningEffort,
  reasoningMode,
  selectedModelId,
  selectedProvider,
  variant = "standard"
}: {
  catalog: Catalog | null;
  disabled: boolean;
  onSelect(profileId: RunProfileId): void;
  reasoningEffort: string;
  reasoningMode: string;
  selectedModelId: string;
  selectedProvider: string;
  variant?: "compact-footer" | "standard";
}) {
  const descriptionPrefix = useId();
  const profiles = resolveRunProfiles(catalog);
  if (!profiles.some((profile) => profile.available)) {
    return null;
  }

  const activeProfile = findActiveRunProfile(profiles, {
    modelId: selectedModelId,
    provider: selectedProvider,
    reasoningEffort,
    reasoningMode
  });
  const compactFooter = variant === "compact-footer";

  return (
    <div
      className={
        compactFooter
          ? "flex w-max min-w-0 items-center gap-1"
          : "mb-2 flex min-w-0 flex-wrap items-center gap-1.5"
      }
      data-testid={compactFooter ? "composer-compact-run-profiles" : "composer-run-profiles"}
    >
      <span className={compactFooter ? "sr-only" : "shrink-0 text-[11px] font-medium text-content-muted"}>
        Profile
      </span>
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Run profile">
        {profiles.map((profile) => {
          const active = activeProfile?.id === profile.id;
          const descriptionId = `${descriptionPrefix}-${profile.id}-description`;
          const unavailable = profile.unavailableReason;

          return (
            <span key={profile.id} className="contents">
              <button
                className={[
                  compactFooter
                    ? "h-touch min-w-11 rounded-control px-1.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-65"
                    : "h-control-sm rounded-control px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-65 [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
                  active
                    ? "bg-surface-selected text-accent-cyan"
                    : "bg-surface-thread text-content-secondary hover:bg-surface-hover hover:text-content-primary"
                ].join(" ")}
                type="button"
                aria-label={`Use ${profile.label} run profile`}
                aria-describedby={descriptionId}
                aria-pressed={active}
                disabled={disabled || !profile.available}
                title={`${profile.label}: ${profile.configurationLabel}. ${profile.description}${
                  unavailable ? `. ${unavailable}` : ""
                }`}
                onClick={() => onSelect(profile.id)}
              >
                {profile.label}
              </button>
              <span className="sr-only" id={descriptionId}>
                {profile.configurationLabel}. {profile.description}.
                {unavailable ? ` ${unavailable}` : ""}
              </span>
            </span>
          );
        })}
      </div>
      <span
        className={compactFooter ? "sr-only" : "shrink-0 text-[11px] text-content-muted"}
        aria-live="polite"
      >
        {activeProfile ? null : "Custom"}
      </span>
    </div>
  );
}
