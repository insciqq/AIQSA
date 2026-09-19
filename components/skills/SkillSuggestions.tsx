"use client";

import { useEffect, useRef, useState } from "react";
import { shellFetch } from "@/components/app-shell/shellApi";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import type { SkillSuggestionRequest, SkillSuggestionResponse } from "@/lib/contracts/skillSuggestions";

export type SkillSuggestionsProps = Readonly<{
  request: SkillSuggestionRequest;
  excludedIds: readonly string[];
  atLimit: boolean;
  onUse(id: string, signal: AbortSignal): Promise<void>;
}>;

async function suggest(input: SkillSuggestionRequest): Promise<SkillSuggestionResponse> {
  const response = await shellFetch("/api/me/skills/suggestions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error("skill_suggestions_unavailable");
  const value: unknown = await response.json();
  if (!value || typeof value !== "object" || !("status" in value) || !("skills" in value) ||
    !["ready", "disabled", "unavailable"].includes(String(value.status)) || !Array.isArray(value.skills) ||
    !value.skills.every(s => s && typeof s === "object" && typeof s.id === "string" &&
      typeof s.name === "string" && typeof s.description === "string")) throw new Error("skill_suggestions_unavailable");
  return value as SkillSuggestionResponse;
}

/** Mounted only by the picker-open action. The draft is a snapshot, so typing
 * never dispatches a provider request. Reopening reuses the server nonce. */
export function SkillSuggestions({ request, excludedIds, atLimit, onUse }: SkillSuggestionsProps) {
  const [result, setResult] = useState<SkillSuggestionResponse | null>(null);
  const [dismissed, setDismissed] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const pending = useRef<Promise<SkillSuggestionResponse> | null>(null);
  const selectionAbort = useRef<AbortController | null>(null);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    selectionAbort.current = controller;
    // Keep the bounded optional read alive through StrictMode and closing.
    // Its receipt settles once; an unmounted picker cannot apply its result.
    pending.current ??= suggest(request);
    void pending.current.then(value => { if (active) setResult(value); }, () => {
      if (active) setResult({ status: "unavailable", skills: [] });
    });
    return () => { active = false; controller.abort(); };
  }, [request]);

  function focusSearch() {
    root.current?.closest('[role="dialog"]')?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
  }
  const visible = result?.skills.filter(skill => !excludedIds.includes(skill.id) && !dismissed.includes(skill.id)) ?? [];
  if (result?.status === "disabled" || result?.status === "ready" && !visible.length) return null;
  return <section ref={root} className="v2-skill-suggestions" aria-label="Suggested Skills">
    {!result ? <p role="status">Checking for helpful Skills…</p>
      : result.status === "unavailable" ? <p role="status">Suggestions unavailable. You can choose a Skill below.</p>
      : <>
        <strong>Suggested for this message</strong>
        <ul>{visible.map(skill => <li key={skill.id}>
          <div><strong>{skill.name}</strong><p>{skill.description}</p></div>
          <div className="v2-skill-suggestion-actions">
            <UiV2Button disabled={atLimit || busy !== null} aria-label={`Use suggested ${skill.name}`} onClick={async () => {
              const signal = selectionAbort.current?.signal;
              if (!signal || signal.aborted) return;
              const search = root.current?.closest('[role="dialog"]')?.querySelector<HTMLInputElement>('input[type="search"]');
              setBusy(skill.id); setError(false);
              try { await onUse(skill.id, signal); if (!signal.aborted) search?.focus(); }
              catch { if (!signal.aborted) setError(true); }
              finally { if (!signal.aborted) setBusy(null); }
            }}>{busy === skill.id ? "Adding…" : "Use"}</UiV2Button>
            <UiV2IconButton icon="close" label={`Dismiss suggestion ${skill.name}`} onClick={() => {
              focusSearch(); setDismissed(previous => [...previous, skill.id]);
            }} />
          </div>
        </li>)}</ul>
        {error ? <p role="status">This Skill could not be added. You can choose another below.</p> : null}
      </>}
  </section>;
}
