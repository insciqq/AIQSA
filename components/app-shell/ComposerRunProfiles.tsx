import {
  findActiveRunProfile,
  resolveRunProfiles,
  type RunProfileId
} from "@/components/app-shell/runProfiles";
import type { Catalog } from "@/components/app-shell/types";
import { Check } from "lucide-react";
import { useId } from "react";

function CompactProfileAvailabilityFact({
  available,
  id
}: Readonly<{
  available: boolean;
  id: string;
}>) {
  const label = available ? "Available" : "Unavailable";

  return (
    <span
      className="sr-only"
      data-run-profile-availability={available ? "available" : "unavailable"}
      id={id}
    >
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
  const compactState = activeProfile
    ? null
    : profiles.some((profile) => profile.available)
      ? "Custom"
      : "Unavailable";
  const unavailableCopy = unavailableProfiles.some(
    (profile) => profile.unavailableReason?.includes("administrator configuration")
  )
    ? "Unavailable profiles need model access or an administrator configuration change."
    : "Unavailable profiles cannot be used with your current model access.";
  return (
    <div className={compact ? "shrink-0" : undefined} data-testid={testId}>
      {compact ? (
        <div className="inline-flex min-h-touch min-w-0 items-center rounded-control bg-control-surface sm:min-h-control-sm [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch">
          <span
            aria-live="polite"
            className="shrink-0 px-0 text-xs font-semibold text-ink-muted max-[429px]:text-[11px] min-[430px]:px-1"
            data-run-profile-state={compactState?.toLowerCase()}
            data-testid={compactState ? "compact-run-profile-state" : undefined}
          >
            {compactState ?? "Profile"}
          </span>
          <div className="flex shrink-0 items-center" role="group" aria-label="Run profile">
            {profiles.map((profile) => {
              const active = activeProfile?.id === profile.id;
              const descriptionId = `${descriptionPrefix}-${profile.id}-description`;
              const availabilityId = `${descriptionPrefix}-${profile.id}-availability`;
              const unavailable = profile.unavailableReason;

              return (
                <span key={profile.id} className="relative inline-flex items-center">
                  <button
                    className={[
                      "h-touch rounded-control text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-65 sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch",
                      "min-w-touch px-1 sm:min-w-0 [@media(hover:none)]:!min-w-touch [@media(pointer:coarse)]:!min-w-touch",
                      active
                        ? "bg-control-selected text-proof"
                        : "text-ink-secondary hover:bg-control-hover hover:text-ink"
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
                  <CompactProfileAvailabilityFact available={profile.available} id={availabilityId} />
                  <span className="sr-only" id={descriptionId}>
                    {profile.configurationLabel}. {profile.description}.
                    {unavailable ? ` ${unavailable}` : ""}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      ) : (
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
                  "grid min-h-[4.5rem] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3.5 py-3 text-left outline-none transition-colors focus-visible:relative focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-proof/55 sm:px-4",
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
                    <span className="mt-1 block break-words font-mono text-[11px] leading-4 text-ink-muted [overflow-wrap:anywhere]">
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
      )}
      {!compact && unavailableProfiles.length > 0 ? (
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
