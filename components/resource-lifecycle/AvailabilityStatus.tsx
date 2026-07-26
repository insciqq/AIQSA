export const enableActionTone =
  "border border-proof/25 bg-proof/[0.08] text-proof hover:border-proof/40 hover:bg-proof/[0.14]";

export function availabilityStatusClass(enabled: boolean): string {
  return enabled
    ? "border-positive/25 bg-positive/10 text-positive"
    : "border-trace-strong bg-control-surface text-ink";
}

export function AvailabilityStatus({ enabled }: Readonly<{ enabled: boolean }>) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-pill border px-2 py-0.5 text-[11px] font-medium ${availabilityStatusClass(enabled)}`}
      data-resource-availability={enabled ? "enabled" : "disabled"}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {enabled ? "Enabled" : "Disabled"}
    </span>
  );
}
