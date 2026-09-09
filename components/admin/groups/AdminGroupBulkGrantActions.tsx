import { UiV2Button } from "@/components/ui-v2";

/** Section actions share wording and wrap with the saved-selection count on narrow pages. */
export function AdminGroupBulkGrantActions({
  disabled,
  groupName,
  onClear,
  onGrant,
  resourceLabel,
  selected,
  total
}: Readonly<{
  disabled: boolean;
  groupName: string;
  onClear(): void;
  onGrant(): void;
  resourceLabel: string;
  selected: number;
  total: number;
}>) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-xs text-ink-muted" role="status">
        {selected} of {total} {resourceLabel} granted{total ? selected === 0 ? " · None" : selected === total ? " · All" : " · Partial" : ""}
      </span>
      <div className="flex flex-wrap gap-2">
        <UiV2Button
          aria-label={`Grant all current ${resourceLabel} to ${groupName}`}
          disabled={disabled || selected === total}
          onClick={onGrant}
          tone="ghost"
          type="button"
        >Grant all</UiV2Button>
        <UiV2Button
          aria-label={`Clear current ${resourceLabel} for ${groupName}`}
          disabled={disabled || selected === 0}
          onClick={onClear}
          tone="ghost"
          type="button"
        >Clear</UiV2Button>
      </div>
    </div>
  );
}
