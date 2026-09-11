"use client";

import { useState } from "react";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import { UiV2Button, UiV2IconButton } from "@/components/ui-v2";
import { resolveEffectiveSkillIds, SKILL_MAX_SELECTED } from "@/lib/contracts/skills";
import { SkillSelectionSummary, type SelectedSkillName } from "./SkillSelectionSummary";

/** Receives only the currently authorized Project catalog; never reads a personal library. */
export function ProjectSkillPicker({ resources, includedSkills, selectedSkills, state, onClose, onRetry, onSelectionChange, restoreFocus }: Readonly<{
  resources: readonly Readonly<{ id: string; name: string; description: string; available: boolean }>[];
  includedSkills: readonly SelectedSkillName[];
  selectedSkills: readonly SelectedSkillName[];
  state: "loading" | "error" | "unavailable" | "ready";
  onClose(): void;
  onRetry(): void;
  onSelectionChange(ids: readonly string[]): void;
  restoreFocus?(): HTMLElement | null;
}>) {
  const ref = useDialogFocus<HTMLDivElement>({ onClose, restoreFocus });
  const [query, setQuery] = useState("");
  const manualIds = selectedSkills.map(({ id }) => id);
  const includedIds = new Set(includedSkills.map(({ id }) => id));
  const effectiveIds = resolveEffectiveSkillIds([...includedIds], manualIds);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visible = resources.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(normalizedQuery));
  return <div className="v2-skill-dialog-scrim" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div ref={ref} aria-label="Project Skills" aria-modal="true" className="v2-skill-dialog" role="dialog">
      <header className="v2-skill-dialog-header">
        <div><strong>Choose Project Skills</strong><span>Skills shared with this Project.</span></div>
        <UiV2IconButton icon="close" label="Close Skills" onClick={onClose} />
      </header>
      <div className="v2-project-skill-picker">
        <SkillSelectionSummary includedSkills={state === "ready" ? includedSkills : []}
          manualSkills={selectedSkills} onRemove={(id) => onSelectionChange(manualIds.filter((value) => value !== id))} />
        {state === "loading" ? <p role="status">Loading Project Skills…</p>
          : state === "error" ? <div role="alert"><p>Project Skills could not be loaded.</p><UiV2Button onClick={onRetry}>Try again</UiV2Button></div>
          : state === "unavailable" ? <p role="alert">This Project is no longer available.</p>
          : <>
            <label className="v2-resource-search"><span>Search Skills</span><input aria-label="Search Project Skills"
              type="search" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
            {!visible.length ? <p>{normalizedQuery ? "No matching Skills." : "No Skills have been shared with this Project."}</p>
              : <ul className="v2-skill-list" aria-label="Available Project Skills">{visible.map((skill) => {
                const selected = manualIds.includes(skill.id);
                const included = includedIds.has(skill.id);
                const atLimit = !effectiveIds.includes(skill.id) && effectiveIds.length >= SKILL_MAX_SELECTED;
                return <li className="v2-skill-row" key={skill.id}>
                  <div className="v2-skill-row-open"><strong>{skill.name}</strong><span>{skill.description}</span>
                    {!skill.available ? <small>Unavailable</small> : null}</div>
                  <UiV2Button aria-label={`${included ? "Included" : selected ? "Remove" : "Use"} ${skill.name}`}
                    aria-pressed={included || selected} disabled={included || !skill.available || atLimit}
                    onClick={() => onSelectionChange(selected ? manualIds.filter((id) => id !== skill.id) : [...manualIds, skill.id])}>
                    {included ? "Included" : selected ? "Remove" : "Use"}
                  </UiV2Button>
                </li>;
              })}</ul>}
          </>}
      </div>
    </div>
  </div>;
}
