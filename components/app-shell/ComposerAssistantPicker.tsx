import { AssistantAvatar } from "@/components/assistants/AssistantAvatar";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import { useMemo, useState } from "react";

type PickerGroup = {
  items: AssistantSummary[];
  label: string;
};

function fingerprintLine(assistant: AssistantSummary): string {
  if (!assistant.availability.ok) {
    return "Required access unavailable";
  }
  const parts = [
    assistant.fingerprint.modelLabel,
    assistant.fingerprint.searchOptionCount > 0
      ? assistant.fingerprint.searchOptionCount === 1
        ? "Search"
        : `${assistant.fingerprint.searchOptionCount} Search`
      : null,
    assistant.fingerprint.mcpServerCount > 0
      ? `${assistant.fingerprint.mcpServerCount} MCP`
      : null
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "No extra capabilities";
}

/**
 * The searchable quick picker: pinned first, bounded browser-local recents,
 * then shared/yours. Rows never expose technical ids, and unavailable items
 * stay visible with a privacy-neutral reason.
 */
export function ComposerAssistantPicker({
  assistants,
  loading,
  onClose,
  onCreateFromCurrentSetup,
  onOpenLibrary,
  onRemoveAssistant,
  onSelect,
  recentIds,
  selectedAssistantId
}: {
  assistants: AssistantSummary[];
  loading: boolean;
  onClose(): void;
  onCreateFromCurrentSetup(): void;
  onOpenLibrary(): void;
  onRemoveAssistant: (() => void) | null;
  onSelect(assistantId: string): void;
  recentIds: string[];
  selectedAssistantId: string | null;
}) {
  const [query, setQuery] = useState("");
  const dialogRef = useDialogFocus<HTMLDivElement>({
    active: true,
    containFocus: true,
    onClose,
    restoreFocus: () => null
  });

  const groups = useMemo<PickerGroup[]>(() => {
    const normalizedQuery = query.trim().toLowerCase();
    const usable = assistants.filter(
      (assistant) =>
        !assistant.archived &&
        (!normalizedQuery ||
          assistant.name.toLowerCase().includes(normalizedQuery) ||
          assistant.description.toLowerCase().includes(normalizedQuery))
    );
    const seen = new Set<string>();
    const take = (predicate: (assistant: AssistantSummary) => boolean) =>
      usable.filter((assistant) => {
        if (seen.has(assistant.id) || !predicate(assistant)) return false;
        seen.add(assistant.id);
        return true;
      });

    const pinned = take((assistant) => assistant.pinned);
    const recentSet = new Set(recentIds);
    const recent = take((assistant) => recentSet.has(assistant.id));
    const yours = take((assistant) => assistant.owned);
    const shared = take(() => true);

    return [
      { items: pinned, label: "Pinned" },
      { items: recent, label: "Recent" },
      { items: yours, label: "Yours" },
      { items: shared, label: "Shared" }
    ].filter((group) => group.items.length > 0);
  }, [assistants, query, recentIds]);

  const empty = groups.length === 0;

  return (
    <>
      <div
        className="fixed inset-0 z-[60] bg-scrim/55"
        data-testid="assistant-picker-backdrop"
        role="presentation"
        onMouseDown={onClose}
      />
      <div
        ref={dialogRef}
        className="pop-enter fixed inset-x-0 bottom-0 z-[70] flex max-h-[calc(100dvh_-_max(.5rem,env(safe-area-inset-top)))] flex-col overflow-hidden rounded-t-panel border-t border-trace-subtle bg-overlay-surface pb-[env(safe-area-inset-bottom)] shadow-overlay sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[min(34rem,calc(100dvh_-_2rem))] sm:w-[min(26rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-panel sm:border"
        data-testid="assistant-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Use an assistant"
      >
        <div className="shrink-0 border-b border-trace-subtle p-3">
          <label className="block">
            <span className="sr-only">Search assistants</span>
            <input
              autoFocus
              className="h-touch w-full rounded-control border border-control-boundary bg-answer-paper px-3 text-sm text-ink outline-none placeholder:text-ink-muted focus-visible:ring-2 focus-visible:ring-focus sm:h-control"
              placeholder="Search assistants…"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2" data-testid="assistant-picker-list">
          {loading && assistants.length === 0 ? (
            <p className="px-2 py-3 text-sm text-ink-muted">Loading assistants…</p>
          ) : empty ? (
            <p className="px-2 py-3 text-sm text-ink-muted" data-testid="assistant-picker-empty">
              {query.trim()
                ? "No assistants match this search."
                : "No assistants yet. Create one from the Library."}
            </p>
          ) : (
            groups.map((group) => (
              <section aria-label={group.label} className="mb-1" key={group.label}>
                <h3 className="px-2 pb-1 pt-2 text-metadata font-semibold uppercase tracking-[0.08em] text-ink-muted">
                  {group.label}
                </h3>
                <ul className="grid gap-0.5">
                  {group.items.map((assistant) => {
                    const unavailable = !assistant.availability.ok;
                    const current = assistant.id === selectedAssistantId;
                    return (
                      <li key={assistant.id}>
                        <button
                          className={`flex w-full min-w-0 items-center gap-2.5 rounded-control px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus ${
                            current
                              ? "bg-control-selected"
                              : "hover:bg-control-hover"
                          } disabled:cursor-not-allowed disabled:opacity-65`}
                          data-testid={`assistant-picker-row-${assistant.id}`}
                          disabled={unavailable}
                          type="button"
                          onClick={() => onSelect(assistant.id)}
                        >
                          <AssistantAvatar recipe={assistant.avatar} size={24} />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-ink">
                              {assistant.name}
                              {current ? (
                                <span className="ml-2 text-metadata font-normal text-ink-muted">Current</span>
                              ) : null}
                            </span>
                            <span
                              className={`block truncate text-metadata ${
                                unavailable ? "text-caution" : "text-ink-muted"
                              }`}
                            >
                              {fingerprintLine(assistant)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <div className="shrink-0 border-t border-trace-subtle p-2">
          <button
            className="flex min-h-touch w-full items-center rounded-control px-2 text-left text-sm text-ink-secondary hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            type="button"
            onClick={onCreateFromCurrentSetup}
          >
            Create from current setup
          </button>
          <button
            className="flex min-h-touch w-full items-center rounded-control px-2 text-left text-sm text-ink-secondary hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
            type="button"
            onClick={onOpenLibrary}
          >
            Manage assistants
          </button>
          {onRemoveAssistant ? (
            <button
              className="flex min-h-touch w-full items-center rounded-control px-2 text-left text-sm text-ink-secondary hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
              data-testid="assistant-picker-remove"
              type="button"
              onClick={onRemoveAssistant}
            >
              Remove assistant
            </button>
          ) : null}
        </div>
      </div>
    </>
  );
}
