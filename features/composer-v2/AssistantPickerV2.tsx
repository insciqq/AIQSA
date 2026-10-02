"use client";

import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { useMobileLayoutV2 } from "@/components/ui-v2/ResponsiveMenuV2";
import { UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { touchInputPrimaryV2 } from "@/components/ui-v2/touchInputV2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject
} from "react";
import { createPortal } from "react-dom";
import "./assistant-picker.css";

const VIEWPORT_GUTTER_PX = 8;
const ANCHOR_GAP_PX = 6;
const POPOVER_WIDTH_PX = 384;

export type AssistantPickerSectionV2 = Readonly<{
  items: readonly AssistantSummary[];
  /** Null for the flat list of a Project chat. */
  label: "Featured" | "Pinned" | "Recent" | "Shared" | "Yours" | null;
}>;

/**
 * Picker sections in order Pinned, Recent, Featured, Yours, Shared; each
 * Assistant appears once, in the first section it qualifies for, and empty
 * sections are left out. Recent keeps the list response's newest-first order.
 * A Project chat lists the Project's Assistants without sections.
 */
export function assistantPickerSectionsV2(
  assistants: readonly AssistantSummary[],
  input: Readonly<{ projectScoped: boolean; query: string; recentIds: readonly string[] }>
): AssistantPickerSectionV2[] {
  const query = input.query.trim().toLocaleLowerCase();
  const visible = assistants.filter((assistant) => (
    !assistant.archived &&
    (!query ||
      assistant.name.toLocaleLowerCase().includes(query) ||
      assistant.description.toLocaleLowerCase().includes(query) ||
      assistant.ownerDisplayName.toLocaleLowerCase().includes(query))
  ));
  if (input.projectScoped) return visible.length > 0 ? [{ items: visible, label: null }] : [];
  const seen = new Set<string>();
  const take = (candidates: readonly AssistantSummary[]) => candidates.filter((assistant) => {
    if (seen.has(assistant.id)) return false;
    seen.add(assistant.id);
    return true;
  });
  const byId = new Map(visible.map((assistant) => [assistant.id, assistant]));
  const recent = input.recentIds.flatMap((id) => {
    const assistant = byId.get(id);
    return assistant ? [assistant] : [];
  });
  const sections: AssistantPickerSectionV2[] = [
    { items: take(visible.filter((assistant) => assistant.pinned)), label: "Pinned" },
    { items: take(recent), label: "Recent" },
    { items: take(visible.filter((assistant) => assistant.featured)), label: "Featured" },
    { items: take(visible.filter((assistant) => assistant.owned)), label: "Yours" },
    { items: take(visible), label: "Shared" }
  ];
  return sections.filter((section) => section.items.length > 0);
}

/**
 * Who an Assistant is by, wherever it is named: "by you", "by {owner}", or a
 * Project's Assistant's `Project “{name}”` (`Project` while its name is
 * unknown), never "by Project". `projectName` is present only for a
 * Project's Assistant.
 */
export function assistantBylineV2(input: Readonly<{
  owned: boolean;
  ownerDisplayName: string;
  projectName?: string | null;
}>): string {
  if (input.projectName !== undefined) {
    const name = input.projectName?.trim();
    return name ? `Project “${name}”` : "Project";
  }
  return `by ${input.owned ? "you" : input.ownerDisplayName}`;
}

function rowButtons(dialog: HTMLElement | null): HTMLButtonElement[] {
  return [...(dialog?.querySelectorAll<HTMLButtonElement>("[data-picker-row]:not(:disabled)") ?? [])];
}

/**
 * The Assistant picker (PRD 10.5): a dialog anchored under the header's
 * Assistant selector on desktop and a bottom sheet on phones and short touch
 * screens. It opens with the caret in its search field, or on itself when
 * touch is the primary input, and a tap anywhere in the search band puts the
 * caret in the field. It keeps focus inside, closes on Escape or an outside
 * press, and returns focus to its opener, or to the selector when the opener
 * is gone.
 */
export function AssistantPickerV2({
  anchorRef,
  assistants,
  currentAssistantId,
  loading,
  onBrowse,
  onClose,
  onSelect,
  projectScoped,
  recentIds
}: Readonly<{
  /** The header selector: the desktop anchor and the fallback focus target. */
  anchorRef: RefObject<HTMLElement | null>;
  assistants: readonly AssistantSummary[];
  currentAssistantId: string | null;
  loading: boolean;
  /** "Browse all in Studio", or the Project's settings inside a Project. */
  onBrowse(): void;
  onClose(): void;
  onSelect(assistantId: string): void;
  projectScoped: boolean;
  recentIds: readonly string[];
}>) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  // A bottom sheet on phones and on short touch screens (a phone on its side),
  // where an anchored popover under the header would show only a couple of rows.
  const mobile = useMobileLayoutV2();
  const { dialogRef, onDialogKeyDown, portalReady } = useModalLayerV2({ onClose });

  const place = useCallback(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (mobile) {
      dialog.removeAttribute("style");
      return;
    }
    const bounds = anchorRef.current?.getBoundingClientRect();
    const anchored = Boolean(bounds && bounds.width > 0);
    const width = Math.min(POPOVER_WIDTH_PX, window.innerWidth - VIEWPORT_GUTTER_PX * 2);
    const top = anchored ? bounds!.bottom + ANCHOR_GAP_PX : VIEWPORT_GUTTER_PX * 7;
    const left = anchored
      ? Math.min(Math.max(VIEWPORT_GUTTER_PX, bounds!.left), window.innerWidth - width - VIEWPORT_GUTTER_PX)
      : (window.innerWidth - width) / 2;
    Object.assign(dialog.style, {
      left: `${left}px`,
      maxHeight: `${Math.max(160, window.innerHeight - top - VIEWPORT_GUTTER_PX)}px`,
      top: `${top}px`,
      width: `${width}px`
    });
  }, [anchorRef, dialogRef, mobile]);

  useLayoutEffect(() => {
    if (!portalReady) return;
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [place, portalReady]);

  useLayoutEffect(() => {
    if (!portalReady) return;
    if (touchInputPrimaryV2()) dialogRef.current?.focus();
    else searchRef.current?.focus();
  }, [dialogRef, portalReady]);

  // Declared after the modal layer, so this runs after its focus restore: an
  // opener that left the page (a menu item) hands focus to the selector.
  useLayoutEffect(() => () => {
    const anchor = anchorRef.current;
    queueMicrotask(() => {
      const active = document.activeElement;
      if ((!active || active === document.body) && anchor?.isConnected && !anchor.closest("[inert]")) {
        anchor.focus();
      }
    });
  }, [anchorRef]);

  const sections = useMemo(
    () => assistantPickerSectionsV2(assistants, { projectScoped, query, recentIds }),
    [assistants, projectScoped, query, recentIds]
  );

  const moveBetweenRows = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = rowButtons(dialogRef.current);
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0 && event.target !== searchRef.current && event.target !== dialogRef.current) return;
    event.preventDefault();
    if (index < 0) {
      rows[event.key === "ArrowDown" ? 0 : rows.length - 1]?.focus();
      return;
    }
    const next = index + (event.key === "ArrowDown" ? 1 : -1);
    if (next < 0) searchRef.current?.focus();
    else rows[Math.min(next, rows.length - 1)]?.focus();
  };

  if (!portalReady) return null;

  return createPortal(
    <div
      className="v2-assistant-popover-layer"
      data-layout={mobile ? "sheet" : "popover"}
      data-testid="assistant-picker-backdrop"
    >
      <button
        aria-label="Close Assistant picker"
        className="v2-assistant-popover-scrim"
        tabIndex={-1}
        type="button"
        onClick={onClose}
      />
      <section
        aria-label="Choose an Assistant"
        aria-modal="true"
        className="v2-assistant-popover"
        data-testid="assistant-picker"
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
        onKeyDown={(event) => {
          moveBetweenRows(event);
          onDialogKeyDown(event);
        }}
      >
        {mobile ? <div aria-hidden="true" className="v2-assistant-popover-handle" /> : null}
        <header
          className="v2-assistant-popover-search"
          onMouseDown={(event) => {
            // The band around the field (its icon and padding) focuses the
            // field instead of taking focus away from it.
            if ((event.target as Element).closest("button, input")) return;
            event.preventDefault();
            searchRef.current?.focus();
          }}
        >
          <UiV2Icon name="search" />
          <input
            aria-label="Search Assistants"
            placeholder="Search Assistants…"
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <UiV2IconButton icon="close" label="Close Assistant picker" onClick={onClose} />
        </header>

        <div className="v2-assistant-popover-list" data-testid="assistant-picker-list">
          {loading && assistants.length === 0 ? (
            <p className="v2-assistant-popover-empty" role="status">Loading Assistants…</p>
          ) : sections.length === 0 ? (
            <p className="v2-assistant-popover-empty" data-testid="assistant-picker-empty">
              {query.trim()
                ? "No Assistants match this search."
                : projectScoped ? "This Project has no Assistants yet." : "No Assistants yet."}
            </p>
          ) : sections.map((section) => (
            <section
              aria-label={section.label ?? "Project Assistants"}
              className="v2-assistant-popover-section"
              key={section.label ?? "project"}
            >
              {section.label ? <h3>{section.label}</h3> : null}
              <ul>
                {section.items.map((assistant) => {
                  const current = assistant.id === currentAssistantId;
                  const unavailable = !assistant.availability.ok;
                  return (
                    <li key={assistant.id}>
                      <button
                        aria-current={current || undefined}
                        className="v2-assistant-popover-row v2-focusable"
                        data-picker-row=""
                        data-testid={`assistant-picker-row-${assistant.id}`}
                        disabled={unavailable}
                        type="button"
                        onClick={() => onSelect(assistant.id)}
                      >
                        <AssistantAvatarV2 recipe={assistant.avatar} size={24} />
                        <span className="v2-assistant-popover-row-copy">
                          <strong>{assistant.name}</strong>
                          <small>
                            {assistantBylineV2({
                              owned: assistant.owned,
                              ownerDisplayName: assistant.ownerDisplayName,
                              projectName: assistant.scope.kind === "project" ? assistant.scope.projectName : undefined
                            })}
                          </small>
                        </span>
                        {unavailable ? (
                          <span className="v2-assistant-popover-mark">
                            <UiV2Icon name="alert" />
                            {assistant.owned ? "Needs attention" : "Not available to you"}
                          </span>
                        ) : current ? (
                          <UiV2Icon className="v2-assistant-popover-current" name="check" />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        <footer className="v2-assistant-popover-footer" data-testid="assistant-picker-actions">
          <button className="v2-focusable" type="button" onClick={onBrowse}>
            {projectScoped ? "Manage in Project settings" : "Browse all in Studio"}
            <UiV2Icon name="chevron-right" />
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
