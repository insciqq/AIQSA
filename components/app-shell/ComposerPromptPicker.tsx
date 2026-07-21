import { useComposerPickerSession } from "@/components/app-shell/composerPicker";
import type { PromptPreset } from "@/components/app-shell/types";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

const promptPickerScrollMargins = { bottom: 56, top: 8 };

export function ComposerPromptPicker({
  currentPrompt,
  disabled,
  icon,
  onChange,
  prompts,
  selectedPromptId
}: {
  currentPrompt: PromptPreset | null;
  disabled: boolean;
  icon: ReactNode;
  onChange(promptId: string): void;
  prompts: PromptPreset[];
  selectedPromptId: string | null;
}) {
  const [query, setQuery] = useState("");
  const selected = prompts.find((prompt) => prompt.id === selectedPromptId) ?? currentPrompt ?? prompts[0] ?? null;
  const filteredPrompts = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) {
      return prompts;
    }

    return prompts.filter((prompt) =>
      [prompt.name, prompt.systemPrompt, prompt.developerPrompt ?? ""]
        .join(" ")
        .toLocaleLowerCase()
        .includes(normalizedQuery)
    );
  }, [prompts, query]);
  const selectedIndex = filteredPrompts.findIndex((prompt) => prompt.id === selected?.id);
  const {
    boundaryProps,
    boundaryRef,
    close,
    dialogProps,
    dialogRef,
    getItemProps,
    handleSearchKeyDown,
    navigableIndex,
    open,
    resultsRef,
    searchRef,
    setActiveIndex,
    toggle,
    triggerProps,
    triggerRef
  } = useComposerPickerSession({
    dialogId: "prompt-picker-dialog",
    disabled,
    initialFocus: "search",
    itemFocusPreventScroll: true,
    items: filteredPrompts,
    onClose: () => setQuery(""),
    onSelect: (prompt) => onChange(prompt.id),
    scrollMargins: promptPickerScrollMargins,
    selectedIndex
  });

  return (
    <div {...boundaryProps} ref={boundaryRef} className="relative min-w-0">
      <button
        {...triggerProps}
        ref={triggerRef}
        className="flex h-touch w-full items-center justify-between gap-2 rounded-control border border-separator-subtle bg-surface-thread px-3 text-left text-xs text-content-primary outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:text-content-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
        type="button"
        aria-label="Prompt preset"
        aria-describedby="prompt-picker-current-value"
        disabled={disabled}
        title={selected?.name ?? "Prompt"}
        onClick={toggle}
      >
        <span className="flex min-w-0 items-center gap-2">
          {icon}
          <span className="min-w-0">
            <span className="block text-[11px] text-content-muted">Prompt</span>
            <span className="block truncate text-sm font-medium" id="prompt-picker-current-value">
              {selected?.name ?? "Prompt"}
            </span>
          </span>
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
      </button>
      {open ? (
        <div
          {...dialogProps}
          ref={dialogRef}
          className="pop-enter absolute left-0 top-12 z-50 flex max-h-[min(18rem,calc(100dvh-8rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-panel border border-separator-subtle bg-surface-overlay p-3 shadow-overlay max-sm:fixed max-sm:inset-x-2 max-sm:bottom-2 max-sm:top-auto max-sm:w-auto max-sm:max-h-[min(70dvh,32rem)] max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] [@media(max-height:32rem)]:fixed [@media(max-height:32rem)]:!bottom-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!left-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!right-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!top-auto [@media(max-height:32rem)]:!max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!w-auto"
          data-testid="prompt-picker-options"
          aria-label="Choose a prompt preset"
        >
          <div className="mb-2 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-content-primary">Choose a prompt preset</h3>
              <p className="mt-0.5 text-xs text-content-muted">Changes apply to the next message.</p>
            </div>
            <button
              className="grid size-11 shrink-0 place-items-center rounded-control text-content-muted outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 lg:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
              type="button"
              aria-label="Close prompt picker"
              onClick={close}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </div>
          <div className="mb-2 flex min-h-touch items-center gap-2 rounded-control border border-separator-subtle bg-surface-thread px-3 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch">
            <Search className="size-4 shrink-0 text-content-muted" aria-hidden="true" />
            <input
              ref={searchRef}
              className="min-w-0 flex-1 bg-transparent text-sm text-content-primary outline-none placeholder:text-content-muted"
              type="search"
              aria-label="Search prompt presets"
              placeholder="Search prompts"
              value={query}
              onChange={(event) => {
                setActiveIndex(0);
                setQuery(event.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
          <p className="sr-only" aria-live="polite">
            {filteredPrompts[navigableIndex]
              ? `${filteredPrompts[navigableIndex].name}, ${navigableIndex + 1} of ${filteredPrompts.length}`
              : "No matching prompt presets"}
          </p>
          <div
            ref={resultsRef}
            className="min-h-0 flex-1 space-y-1 overflow-y-auto overscroll-contain pb-14 pr-1"
            id="prompt-picker-results"
            role="group"
            aria-label="Prompt presets"
          >
            {filteredPrompts.length === 0 ? (
              <div className="rounded-control bg-surface-thread px-4 py-6 text-center" role="status">
                <p className="text-sm font-medium text-content-primary">No prompts match “{query.trim()}”.</p>
                <p className="mt-1 text-xs text-content-muted">Try a preset name or wording from its instructions.</p>
              </div>
            ) : null}
            {filteredPrompts.map((prompt, index) => {
              const active = prompt.id === selected?.id;
              const preview = prompt.systemPrompt.trim() || prompt.developerPrompt?.trim() || "No prompt instructions";

              return (
                <button
                  key={prompt.id}
                  {...getItemProps(index)}
                  className={[
                    "flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2.5 text-left text-xs outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan/55",
                    active ? "bg-surface-selected text-content-primary" : "text-content-secondary"
                  ].join(" ")}
                  data-option-value={prompt.id}
                  id={`prompt-picker-option-${index}`}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  title={`${prompt.name}\n${preview}`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-sm font-semibold leading-5 text-content-primary [overflow-wrap:anywhere]">
                      {prompt.name}
                    </span>
                    <span className="mt-0.5 block overflow-hidden text-xs leading-5 text-content-muted [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]">
                      {preview}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1 text-xs">
                    {active ? <span className="text-accent-cyan">Current</span> : null}
                    {prompt.isDefault ? <span className="text-content-muted">Default</span> : null}
                    {active ? <Check className="size-4 text-accent-cyan" aria-hidden="true" /> : null}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
