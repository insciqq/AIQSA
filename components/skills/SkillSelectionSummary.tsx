import { UiV2Button } from "@/components/ui-v2";
import { resolveEffectiveSkillIds, SKILL_MAX_SELECTED } from "@/lib/contracts/skills";

export type SelectedSkillName = Readonly<{ id: string; name: string }>;

export function SkillSelectionSummary({ includedSkills, manualSkills, onRemove }: Readonly<{
  includedSkills: readonly SelectedSkillName[];
  manualSkills: readonly SelectedSkillName[];
  onRemove(id: string): void;
}>) {
  const ids = resolveEffectiveSkillIds(includedSkills.map(({ id }) => id), manualSkills.map(({ id }) => id));
  if (!ids.length) return null;
  return (
    <section aria-label="Selected Skills" className="v2-skill-selection">
      <p>{ids.length} of {SKILL_MAX_SELECTED} Skills selected.</p>
      {ids.length >= SKILL_MAX_SELECTED ? (
        <p role={ids.length > SKILL_MAX_SELECTED ? "alert" : "status"}>
          {ids.length > SKILL_MAX_SELECTED
            ? `Choose at most ${SKILL_MAX_SELECTED} Skills. Remove manual selections or change the Assistant before sending.`
            : "Skill limit reached. Remove a manual selection to add another Skill."}
        </p>
      ) : null}
      {includedSkills.length ? <div>
        <strong>Included by Assistant</strong>
        <ol>{includedSkills.map((skill) => <li key={skill.id}>
          <span>{ids.indexOf(skill.id) + 1}. {skill.name}</span><small>Included</small>
        </li>)}</ol>
      </div> : null}
      {manualSkills.length ? <div>
        <strong>Added manually</strong>
        <ol>{manualSkills.map((skill) => <li key={skill.id}>
          <span>{ids.indexOf(skill.id) + 1}. {skill.name}</span>
          <UiV2Button aria-label={`Remove manual ${skill.name}`} onClick={() => onRemove(skill.id)}>Remove</UiV2Button>
        </li>)}</ol>
      </div> : null}
    </section>
  );
}
