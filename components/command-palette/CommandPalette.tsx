"use client";

import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { isImeCompositionEvent } from "@/components/keyboard";
import { Boxes, Check, Command, FileText, MessageSquare, Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  filterCommandItems,
  moveCommandSelection,
  type CommandItem,
  type CommandKind,
  type CommandSelectionDirection
} from "./commandItems";

const kindLabels: Record<CommandKind, { group: string; item: string }> = {
  action: { group: "Actions", item: "Action" },
  chat: { group: "Chats", item: "Chat" },
  model: { group: "Models", item: "Model" },
  prompt: { group: "Prompts", item: "Prompt" },
  search: { group: "Search strategies", item: "Search" }
};

function CommandKindIcon({ kind }: { kind: CommandKind }) {
  const className = "size-3.5";

  if (kind === "action") {
    return <Command className={className} aria-hidden="true" />;
  }
  if (kind === "chat") {
    return <MessageSquare className={className} aria-hidden="true" />;
  }
  if (kind === "model") {
    return <Boxes className={className} aria-hidden="true" />;
  }
  if (kind === "prompt") {
    return <FileText className={className} aria-hidden="true" />;
  }
  return <Search className={className} aria-hidden="true" />;
}

export function CommandPalette({
  items,
  onClose,
  onRun
}: {
  items: CommandItem[];
  onClose(): void;
  onRun(item: CommandItem): void;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose });
  const filteredItems = useMemo(() => filterCommandItems(items, query), [items, query]);
  const boundedSelectedIndex = Math.min(selectedIndex, Math.max(filteredItems.length - 1, 0));
  const selectedItem = filteredItems[boundedSelectedIndex];
  const groupedItems = useMemo(() => {
    const groups: Array<{ items: Array<{ index: number; item: CommandItem }>; kind: CommandKind }> = [];

    filteredItems.forEach((item, index) => {
      const existingGroup = groups.find((group) => group.kind === item.kind);
      if (existingGroup) {
        existingGroup.items.push({ index, item });
      } else {
        groups.push({ items: [{ index, item }], kind: item.kind });
      }
    });

    return groups;
  }, [filteredItems]);

  useEffect(() => {
    document.getElementById(`command-option-${boundedSelectedIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [boundedSelectedIndex, filteredItems.length]);

  function selectByKeyboard(direction: CommandSelectionDirection): number {
    const nextIndex = moveCommandSelection(boundedSelectedIndex, filteredItems.length, direction);
    setSelectedIndex(nextIndex);
    return nextIndex;
  }

  function handleNavigationKey(key: string): number | null {
    if (key === "ArrowDown") {
      return selectByKeyboard("down");
    }
    if (key === "ArrowUp") {
      return selectByKeyboard("up");
    }
    if (key === "Home") {
      return selectByKeyboard("first");
    }
    if (key === "End") {
      return selectByKeyboard("last");
    }

    return null;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/60 pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[max(.5rem,env(safe-area-inset-top))] sm:items-start sm:pb-[max(1rem,env(safe-area-inset-bottom))] sm:pl-[max(1rem,env(safe-area-inset-left))] sm:pr-[max(1rem,env(safe-area-inset-right))] sm:pt-[min(12vh,6rem)] [@media(max-height:32rem)]:!items-start [@media(max-height:32rem)]:!pb-[max(.5rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!pt-[max(.5rem,env(safe-area-inset-top))]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="pop-enter flex max-h-[calc(100dvh-max(.5rem,env(safe-area-inset-top)))] w-full max-w-2xl flex-col overflow-hidden rounded-t-panel border border-b-0 border-trace-subtle bg-overlay-surface pb-[env(safe-area-inset-bottom)] text-ink shadow-overlay sm:max-h-[min(36rem,calc(100dvh-8rem))] sm:rounded-panel sm:border sm:pb-0 [@media(max-height:32rem)]:!max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!rounded-panel [@media(max-height:32rem)]:!border [@media(max-height:32rem)]:!pb-0"
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="flex shrink-0 items-center gap-2 border-b border-trace-subtle px-3">
          <Search className="size-4 text-ink-muted" aria-hidden="true" />
          <input
            className="h-14 min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted"
            aria-label="Command search"
            aria-activedescendant={selectedItem ? `command-option-${boundedSelectedIndex}` : undefined}
            aria-autocomplete="list"
            aria-controls="command-palette-options"
            aria-expanded="true"
            placeholder="Search commands, chats, models, and more"
            role="combobox"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (isImeCompositionEvent(event)) {
                event.stopPropagation();
                return;
              }

              if (handleNavigationKey(event.key) !== null) {
                event.preventDefault();
                return;
              }

              if (event.key === "Enter" && selectedItem) {
                event.preventDefault();
                onRun(selectedItem);
              }
            }}
          />
          <button
            className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 sm:size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
            type="button"
            aria-label="Close command palette"
            title="Close command palette"
            onClick={onClose}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2"
          id="command-palette-options"
          role="listbox"
          aria-label="Commands"
        >
          {filteredItems.length === 0 ? (
            <div className="px-4 py-10 text-center" role="status">
              <p className="text-sm font-medium text-ink">No matching commands</p>
              <p className="mt-1 text-xs text-ink-muted">Try a chat, model, provider, prompt, search, or action name.</p>
            </div>
          ) : (
            groupedItems.map((group) => {
              const headingId = `command-group-${group.kind}`;

              return (
                <div
                  className="pb-2 last:pb-0"
                  key={group.kind}
                  role="group"
                  aria-labelledby={headingId}
                >
                  <div
                    className="flex items-center justify-between px-3 pb-1 pt-2 text-metadata font-medium text-ink-muted first:pt-1"
                    id={headingId}
                  >
                    <span>{kindLabels[group.kind].group}</span>
                    <span className="tabular-nums" aria-hidden="true">
                      {group.items.length}
                    </span>
                  </div>
                  {group.items.map(({ index, item }) => (
                    <button
                      className={[
                        "flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-proof/55 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch",
                        index === boundedSelectedIndex
                          ? "bg-control-selected text-ink"
                          : "text-ink-secondary hover:bg-control-hover hover:text-ink"
                      ].join(" ")}
                      id={`command-option-${index}`}
                      key={item.id}
                      type="button"
                      role="option"
                      aria-current={item.current ? "true" : undefined}
                      aria-selected={index === boundedSelectedIndex}
                      aria-posinset={index + 1}
                      aria-setsize={filteredItems.length}
                      tabIndex={-1}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => onRun(item)}
                    >
                      <span className="flex min-w-0 items-start gap-3">
                        <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-control bg-control-surface text-ink-muted">
                          <CommandKindIcon kind={item.kind} />
                        </span>
                        <span className="min-w-0">
                          <span
                            className="block break-words text-sm leading-5 text-ink [overflow-wrap:anywhere]"
                            title={item.label}
                          >
                            {item.label}
                          </span>
                          <span
                            className="mt-0.5 block break-words text-xs leading-4 text-ink-muted [overflow-wrap:anywhere]"
                            title={item.subtitle}
                          >
                            {kindLabels[item.kind].item} · {item.subtitle}
                          </span>
                        </span>
                      </span>
                      {item.current ? (
                        <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-xs font-medium text-proof">
                          <Check className="size-3.5" aria-hidden="true" />
                          Current
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
