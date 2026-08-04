import {
  findActiveRunProfile,
  resolveRunProfiles,
  type RunProfileId
} from "@/components/app-shell/runProfiles";
import type { Catalog } from "@/components/app-shell/types";
import { Check } from "lucide-react";
import { useId } from "react";

export function ComposerRunProfiles({
  catalog,
  disabled,
  onSelect,
  reasoningEffort,
  reasoningMode,
  selectedModelId,
  selectedProvider,
  testId = "composer-run-profiles"
}: {
  catalog: Catalog | null;
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
      <div
        className="overflow-hidden rounded-panel border border-trace-subtle bg-control-surface/35"
        role="group"
        aria-label="Run profile"
      >
        {profiles.map((profile, index) => {
          const active = activeProfile?.id === profile.id;
          const descriptionId = `${descriptionPrefix}-${profile.id}-description`;
          const availabilityId = `${descriptionPrefix}-${profile.id}-availability`;
          const unavailable = profile.unavailableReason;
          const stateLabel = active ? "Selected" : profile.available ? "Available" : "Unavailable";

          return (
            <button
              className={[
                "grid min-h-[4.5rem] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 text-left outline-none transition-colors focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus sm:px-4",
                index > 0 ? "border-t border-trace-subtle" : "",
                active
                  ? "bg-control-selected"
                  : profile.available
                    ? "hover:bg-control-hover"
                    : "cursor-not-allowed bg-answer-paper/35"
              ].join(" ")}
              type="button"
              aria-label={`Use ${profile.label} run profile`}
              aria-describedby={`${availabilityId} ${descriptionId}`}
              aria-pressed={active}
              disabled={disabled || !profile.available}
              key={profile.id}
              title={`${profile.label}: ${profile.configurationLabel}. ${profile.description}${
                unavailable ? `. ${unavailable}` : ""
              }`}
              onClick={() => onSelect(profile.id)}
            >
              <span className="min-w-0">
                <span className="block text-sm font-semibold text-ink">{profile.label}</span>
                <span className="mt-0.5 block text-xs leading-5 text-ink-secondary">
                  {profile.description}
                </span>
                {profile.available ? (
                  <span className="mt-1 block break-words font-mono text-metadata text-ink-muted [overflow-wrap:anywhere]">
                    {profile.configurationLabel}
                  </span>
                ) : null}
              </span>
              <span
                className={[
                  "inline-flex shrink-0 items-center gap-1.5 text-xs font-semibold",
                  active ? "text-proof" : profile.available ? "text-positive" : "text-ink-muted"
                ].join(" ")}
                data-run-profile-availability={profile.available ? "available" : "unavailable"}
                id={availabilityId}
              >
                {active ? <Check className="size-3.5" aria-hidden="true" /> : null}
                {stateLabel}
              </span>
              <span className="sr-only" id={descriptionId}>
                {profile.configurationLabel}. {profile.description}.
                {unavailable ? ` ${unavailable}` : ""}
              </span>
            </button>
          );
        })}
      </div>
      {unavailableProfiles.length > 0 ? (
        <p
          className="mt-2 text-xs text-ink-muted"
          data-run-profile-availability="unavailable"
          data-testid="run-profile-unavailable-reason"
        >
          {unavailableCopy}
        </p>
      ) : null}
    </div>
  );
}
