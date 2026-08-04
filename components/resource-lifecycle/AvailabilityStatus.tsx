export const enableActionTone =
  "border border-proof/25 bg-proof/[0.08] text-proof hover:border-proof/40 hover:bg-proof/[0.14]";

export function availabilityStatusClass(enabled: boolean): string {
  return enabled
    ? "border-positive/35 bg-positive/[0.12] text-ink"
    : "border-trace-strong bg-control-surface text-ink";
}

export function availabilityRowClass(enabled: boolean): string {
  return enabled
    ? "border-l-2 border-l-positive/55 bg-positive/5"
    : "border-l-2 border-l-trace-strong bg-control-surface";
}

export function AvailabilityStatus({
  disabledLabel = "Disabled",
  enabled,
  enabledLabel = "Enabled"
}: Readonly<{
  disabledLabel?: string;
  enabled: boolean;
  enabledLabel?: string;
}>) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2.5 py-1 text-xs font-semibold leading-none ${availabilityStatusClass(enabled)}`}
      data-resource-availability={enabled ? "enabled" : "disabled"}
    >
      <span aria-hidden="true" className={`size-2 rounded-full ${enabled ? "bg-positive" : "bg-current"}`} />
      {enabled ? enabledLabel : disabledLabel}
    </span>
  );
}
