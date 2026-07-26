import {
  findActiveRunProfile,
  resolveRunProfiles,
  type RunProfileId
} from "@/components/app-shell/runProfiles";
import type { Catalog } from "@/components/app-shell/types";
import { useId } from "react";

export function ComposerRunProfiles({
  catalog,
  compact = false,
  disabled,
  onSelect,
  reasoningEffort,
  reasoningMode,
  selectedModelId,
  selectedProvider,
  testId = "composer-run-profiles"
}: {
  catalog: Catalog | null;
  compact?: boolean;
  disabled: boolean;
  onSelect(profileId: RunProfileId): void;
  reasoningEffort: string;
  reasoningMode: string;
  selectedModelId: string;
  selectedProvider: string;
  testId?: string;
}) {
  const descriptionPrefix = useId();
  const profiles = resolveRunProfiles(catalog);
  if (profiles.length === 0) {
    return null;
  }

  const activeProfile = findActiveRunProfile(profiles, {
    modelId: selectedModelId,
    provider: selectedProvider,
    reasoningEffort,
    reasoningMode
  });
  const unavailableProfiles = profiles.filter((profile) => !profile.available);
  const unavailableCopy = unavailableProfiles.some(
    (profile) => profile.unavailableReason?.includes("administrator configuration")
  )
    ? "Unavailable profiles need model access or an administrator configuration change."
    : "Unavailable profiles cannot be used with your current model access.";
  return (
    <div data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Run profile">
          {profiles.map((profile) => {
            const active = activeProfile?.id === profile.id;
            const descriptionId = `${descriptionPrefix}-${profile.id}-description`;
            const unavailable = profile.unavailableReason;

            return (
              <span key={profile.id} className="contents">
                <button
                  className={[
                    "h-touch rounded-control text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-65 sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
                    compact ? "px-2" : "px-3",
                    active
                      ? "bg-control-selected text-proof"
                      : "bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"
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
          className="shrink-0 text-[11px] text-ink-muted"
          aria-live="polite"
        >
          {activeProfile ? null : profiles.some((profile) => profile.available) ? "Custom" : "No profile available"}
        </span>
      </div>
      {!compact && unavailableProfiles.length > 0 ? (
        <p className="mt-2 text-xs text-ink-muted" data-testid="run-profile-unavailable-reason">
          {unavailableCopy}
        </p>
      ) : null}
    </div>
  );
}
