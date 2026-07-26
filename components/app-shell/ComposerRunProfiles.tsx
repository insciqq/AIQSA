import {
  findActiveRunProfile,
  resolveRunProfiles,
  type RunProfileId
} from "@/components/app-shell/runProfiles";
import type { Catalog } from "@/components/app-shell/types";
import { useId } from "react";

function ProfileAvailabilityFact({
  available,
  compact,
  id
}: Readonly<{
  available: boolean;
  compact: boolean;
  id: string;
}>) {
  const label = available ? "Available" : "Unavailable";

  if (compact) {
    return (
      <span
        className={`pointer-events-none absolute right-0.5 top-0.5 size-2 rounded-full ${available ? "bg-positive" : "bg-caution"}`}
        data-run-profile-availability={available ? "available" : "unavailable"}
        id={id}
        title={label}
      >
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-semibold leading-none ${
        available
          ? "border-positive/35 bg-positive/[0.12] text-positive"
          : "border-caution/35 bg-caution/10 text-caution"
      }`}
      data-run-profile-availability={available ? "available" : "unavailable"}
      id={id}
    >
      <span aria-hidden="true" className="size-2 rounded-full bg-current" />
      {label}
    </span>
  );
}

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
        <div
          className={compact ? "flex shrink-0 items-center gap-1" : "flex min-w-0 flex-wrap items-center gap-1.5"}
          role="group"
          aria-label="Run profile"
        >
          {profiles.map((profile) => {
            const active = activeProfile?.id === profile.id;
            const descriptionId = `${descriptionPrefix}-${profile.id}-description`;
            const availabilityId = `${descriptionPrefix}-${profile.id}-availability`;
            const unavailable = profile.unavailableReason;

            return (
              <span key={profile.id} className={`relative inline-flex items-center ${compact ? "" : "gap-1.5"}`}>
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
                  aria-describedby={`${availabilityId} ${descriptionId}`}
                  aria-pressed={active}
                  disabled={disabled || !profile.available}
                  title={`${profile.label}: ${profile.configurationLabel}. ${profile.description}${
                    unavailable ? `. ${unavailable}` : ""
                  }`}
                  onClick={() => onSelect(profile.id)}
                >
                  {profile.label}
                </button>
                <ProfileAvailabilityFact
                  available={profile.available}
                  compact={compact}
                  id={availabilityId}
                />
                <span className="sr-only" id={descriptionId}>
                  {profile.configurationLabel}. {profile.description}.
                  {unavailable ? ` ${unavailable}` : ""}
                </span>
              </span>
            );
          })}
        </div>
        {compact ? (
          <span
            className="shrink-0 text-[11px] text-ink-muted"
            aria-live="polite"
          >
            {activeProfile ? null : profiles.some((profile) => profile.available) ? "Custom" : "Unavailable"}
          </span>
        ) : null}
      </div>
      {!compact && unavailableProfiles.length > 0 ? (
        <p className="mt-2 text-xs text-ink-muted" data-testid="run-profile-unavailable-reason">
          {unavailableCopy}
        </p>
      ) : null}
    </div>
  );
}
