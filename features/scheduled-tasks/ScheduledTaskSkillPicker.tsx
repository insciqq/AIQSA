"use client";

import { useEffect, useId, useState } from "react";
import { SCHEDULED_TASK_MAX_PINNED_SKILLS, type ScheduledTaskPinnedSkill } from "@/lib/contracts/scheduledTasks";
import { listScheduledTaskSkillOptions, type ScheduledTaskSkillOption } from "./scheduledTasksApi";

type SkillOptions =
  | Readonly<{ state: "loading" }>
  | Readonly<{ state: "error" }>
  | Readonly<{ state: "ready"; skills: readonly ScheduledTaskSkillOption[] }>;

export type ScheduledTaskSkillPickerProps = Readonly<{
  disabled: boolean;
  error?: string;
  /** Reads the Skills the owner may pin; the server checks every pin again on save and before each run. */
  loadOptions?: () => Promise<readonly ScheduledTaskSkillOption[]>;
  onChange(pinned: ScheduledTaskPinnedSkill[]): void;
  pinned: readonly ScheduledTaskPinnedSkill[];
  workspaceEnabled: boolean;
}>;

function skillLabel(skill: Pick<ScheduledTaskPinnedSkill, "name">): string {
  return skill.name ?? "Unavailable Skill";
}

function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  return quoted.length === 1 ? quoted[0]! : `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

/**
 * The task's pinned Skills: each run loads exactly these at their current
 * version. Lists the pins (a code badge for Skills with scripts, a mark for
 * one that is no longer available, a remove button each) and a native select
 * of the owner's own and shared Skills to add, which works the same on every
 * screen size.
 */
export function ScheduledTaskSkillPicker({
  disabled, error, loadOptions = listScheduledTaskSkillOptions, onChange, pinned, workspaceEnabled
}: ScheduledTaskSkillPickerProps) {
  const ids = { label: useId(), hint: useId(), select: useId(), error: useId(), scripts: useId(), status: useId() };
  const [options, setOptions] = useState<SkillOptions>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    loadOptions().then(
      (skills) => { if (active) setOptions({ state: "ready", skills }); },
      () => { if (active) setOptions({ state: "error" }); }
    );
    return () => { active = false; };
  }, [loadOptions, attempt]);

  const pinnedIds = new Set(pinned.map((skill) => skill.id));
  const addable = options.state === "ready" ? options.skills.filter((skill) => !pinnedIds.has(skill.id)) : [];
  const full = pinned.length >= SCHEDULED_TASK_MAX_PINNED_SKILLS;
  const scripts = workspaceEnabled ? [] : pinned.filter((skill) => skill.hasExecutables && skill.name !== null);
  const placeholder = full ? `Up to ${SCHEDULED_TASK_MAX_PINNED_SKILLS} Skills`
    : options.state === "loading" ? "Loading Skills…"
      : options.state === "error" ? "Skills could not be loaded"
        : addable.length === 0 ? "No other Skills to add" : "Add a Skill…";
  const add = (skillId: string) => {
    const skill = addable.find((entry) => entry.id === skillId);
    if (!skill || full) return;
    onChange([...pinned, { available: true, hasExecutables: skill.hasExecutables, id: skill.id, name: skill.name }]);
  };
  const describedBy = [ids.hint, scripts.length > 0 && ids.scripts, error && ids.error].filter(Boolean).join(" ");

  return (
    <div className="v2-scheduled-control v2-scheduled-skills" role="group" aria-labelledby={ids.label} data-testid="scheduled-task-skills">
      <span id={ids.label} className="v2-scheduled-label">Pinned Skills</span>
      <p className="v2-scheduled-hint" id={ids.hint}>
        Every run loads these Skills at their current version, besides those chosen automatically.
      </p>
      {pinned.length > 0 ? (
        <ul className="v2-scheduled-skill-list" aria-label="Pinned Skills">
          {pinned.map((skill) => (
            <li key={skill.id} className="v2-scheduled-skill" data-unavailable={!skill.available || undefined}>
              <span className="v2-scheduled-skill-name">{skillLabel(skill)}</span>
              {skill.hasExecutables ? <span className="v2-scheduled-skill-badge" title="This Skill has scripts">code</span> : null}
              {!skill.available ? <span className="v2-scheduled-skill-state">No longer available</span> : null}
              <button
                type="button"
                className="v2-scheduled-skill-remove v2-focusable"
                disabled={disabled}
                aria-label={`Remove ${skillLabel(skill)}`}
                onClick={() => onChange(pinned.filter((entry) => entry.id !== skill.id))}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <label htmlFor={ids.select} className="sr-only">Add a Skill</label>
      <select
        id={ids.select}
        className="v2-scheduled-field w-full min-w-0 rounded-lg border border-trace bg-answer-paper px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus disabled:opacity-60"
        value=""
        disabled={disabled || full || addable.length === 0}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy || undefined}
        onChange={(event) => add(event.target.value)}
      >
        <option value="">{placeholder}</option>
        {addable.map((skill) => (
          <option key={skill.id} value={skill.id}>
            {skill.name}{skill.hasExecutables ? " · code" : ""}{skill.owned ? "" : ` · ${skill.ownerDisplayName}`}
          </option>
        ))}
      </select>
      {options.state === "error" ? (
        <p className="v2-scheduled-hint" id={ids.status} role="status">
          Skills could not be loaded.{" "}
          <button type="button" className="v2-scheduled-run-chat v2-focusable" disabled={disabled}
            onClick={() => { setOptions({ state: "loading" }); setAttempt((value) => value + 1); }}>
            Try again
          </button>
        </p>
      ) : null}
      {scripts.length > 0 ? (
        <p className="v2-scheduled-hint" id={ids.scripts} data-testid="scheduled-task-skill-scripts">
          {quotedList(scripts.map((skill) => skill.name!))} {scripts.length === 1 ? "has" : "have"} scripts, which run only
          with Workspace on. Without it, runs follow the instructions only.
        </p>
      ) : null}
      {error ? <p className="v2-scheduled-field-error" id={ids.error} role="alert">{error}</p> : null}
    </div>
  );
}
