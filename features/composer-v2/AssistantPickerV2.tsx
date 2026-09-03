"use client";

import { AssistantAvatarV2 } from "@/components/ui-v2/AssistantAvatarV2";
import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { assistantUnavailabilityCopy } from "@/features/library-v2/assistantAvailabilityCopy";
import type { AssistantSummary } from "@/lib/contracts/assistants";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

type PickerGroup = Readonly<{
  items: AssistantSummary[];
  label: "Pinned" | "Recent" | "Yours" | "Shared";
}>;

function assistantFingerprint(assistant: AssistantSummary): string {
  const facts = [
    assistant.fingerprint.modelLabel,
    assistant.fingerprint.knowledgeLabel,
    assistant.fingerprint.searchOptionCount > 0
      ? `Search · ${assistant.fingerprint.searchOptionCount}`
      : null,
    assistant.fingerprint.mcpServerCount > 0
      ? `MCP · ${assistant.fingerprint.mcpServerCount}`
      : null
  ].filter((fact): fact is string => Boolean(fact));
  return facts.length > 0 ? facts.join(" · ") : "No additional capabilities";
}

export function AssistantPickerV2({
  assistants,
  loading,
  onClose,
  onCreateFromCurrentSetup,
  onManage,
  onSelect,
  onUnavailableAction,
  recentIds,
  selectedAssistantId
}: Readonly<{
  assistants: readonly AssistantSummary[];
  loading: boolean;
  onClose(): void;
  onCreateFromCurrentSetup(): void;
  onManage(): void;
  onSelect(assistantId: string): void;
  onUnavailableAction?(assistantId: string, action: "mcp-settings" | "open-editor"): void;
  recentIds: string[];
  selectedAssistantId: string | null;
}>) {
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const {
    dialogRef,
    initialFocusRef: closeRef,
    onDialogKeyDown,
    portalReady
  } = useModalLayerV2({ onClose });

  useEffect(() => {
    if (portalReady) searchRef.current?.focus();
  }, [portalReady]);

  const groups = useMemo<PickerGroup[]>(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const visible = assistants.filter((assistant) => (
      !assistant.archived &&
      (!normalizedQuery ||
        assistant.name.toLocaleLowerCase().includes(normalizedQuery) ||
        assistant.description.toLocaleLowerCase().includes(normalizedQuery))
    ));
    const seen = new Set<string>();
    const take = (predicate: (assistant: AssistantSummary) => boolean) => visible.filter((assistant) => {
      if (seen.has(assistant.id) || !predicate(assistant)) return false;
      seen.add(assistant.id);
      return true;
    });
    const recent = new Set(recentIds);
    return [
      { items: take((assistant) => assistant.pinned), label: "Pinned" },
      { items: take((assistant) => recent.has(assistant.id)), label: "Recent" },
      { items: take((assistant) => assistant.owned), label: "Yours" },
      { items: take(() => true), label: "Shared" }
    ].filter((group) => group.items.length > 0) as PickerGroup[];
  }, [assistants, query, recentIds]);

  if (!portalReady) return null;

  return createPortal(
    <div
      className="v2-assistant-picker-scrim"
      data-testid="assistant-picker-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      role="presentation"
    >
      <section
        aria-label="Use an assistant"
        aria-modal="true"
        className="v2-assistant-picker"
        data-testid="assistant-picker"
        onKeyDown={onDialogKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <header className="v2-assistant-picker-header">
          <label>
            <span className="v2-sr-only">Search assistants</span>
            <input
              aria-label="Search assistants"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search assistants…"
              ref={searchRef}
              type="search"
              value={query}
            />
          </label>
          <UiV2IconButton
            icon="close"
            label="Close assistant picker"
            onClick={onClose}
            ref={closeRef}
          />
        </header>

        <div className="v2-assistant-picker-list" data-testid="assistant-picker-list">
          <button
            className="v2-assistant-picker-create v2-focusable"
            type="button"
            onClick={onCreateFromCurrentSetup}
          >
            <UiV2Icon name="plus" />
            <span>
              <strong>Create from current setup</strong>
              <small>Save this chat&apos;s model, tools and knowledge as a new assistant</small>
            </span>
          </button>
          {loading && assistants.length === 0 ? (
            <p role="status">Loading assistants…</p>
          ) : groups.length === 0 ? (
            <p data-testid="assistant-picker-empty">
              {query.trim()
                ? "No assistants match this search."
                : "No assistants yet. Create one from your current setup below."}
            </p>
          ) : groups.map((group) => (
            <section aria-label={group.label} key={group.label}>
              <h3>{group.label}</h3>
              <ul>
                {group.items.map((assistant) => {
                  const current = assistant.id === selectedAssistantId;
                  const unavailable = assistantUnavailabilityCopy(assistant);
                  return (
                    <li className="v2-assistant-picker-item" key={assistant.id}>
                      <button
                        aria-current={current || undefined}
                        className="v2-assistant-picker-row v2-focusable"
                        data-testid={`assistant-picker-row-${assistant.id}`}
                        disabled={!assistant.availability.ok}
                        title={unavailable?.explanation}
                        type="button"
                        onClick={() => onSelect(assistant.id)}
                      >
                        <AssistantAvatarV2 recipe={assistant.avatar} size={24} />
                        <span>
                          <strong>{assistant.name}</strong>
                          <small data-tone={unavailable ? "warn" : undefined}>
                            {unavailable
                              ? `${unavailable.headline}${unavailable.explanation ? `, ${unavailable.explanation.toLocaleLowerCase()}` : ""}`
                              : assistantFingerprint(assistant)}
                          </small>
                        </span>
                        {current ? <UiV2Icon className="v2-assistant-picker-current" name="check" /> : null}
                      </button>
                      {unavailable?.action ? (
                        <UiV2Button
                          className="v2-assistant-picker-fix"
                          onClick={() => onUnavailableAction?.(assistant.id, unavailable.action!.kind)}
                        >
                          {unavailable.action.label}
                        </UiV2Button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>

        <footer className="v2-assistant-picker-actions" data-testid="assistant-picker-actions">
          <p>Use applies to your next message only.</p>
          <button className="v2-focusable" type="button" onClick={onManage}>
            Manage in Library <span aria-hidden="true">›</span>
          </button>
        </footer>
      </section>
    </div>,
    document.body
  );
}
