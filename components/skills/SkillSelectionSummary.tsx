import { UiV2IconButton } from "@/components/ui-v2";
import { resolveEffectiveSkillIds, SKILL_MAX_PINNED } from "@/lib/contracts/skills";

export type SelectedSkillName = Readonly<{ id: string; name: string; mode?: "pinned" | "available"; instructionApproxTokens?: number; promptCharacterCount?: number }>;

export function SkillSelectionSummary({ includedSkills, manualSkills, onRemove, modelContextWindow, estimates = [], availableCount, availableCountPartial = false }: Readonly<{
  includedSkills: readonly SelectedSkillName[];
  manualSkills: readonly SelectedSkillName[];
  onRemove(id: string): void;
  modelContextWindow?: number;
  estimates?: readonly Pick<SelectedSkillName, "id" | "instructionApproxTokens">[];
  availableCount?: number;
  availableCountPartial?: boolean;
}>) {
  const unique = (skills: readonly SelectedSkillName[]) => skills.filter((skill, index) => skills.findIndex(entry => entry.id === skill.id) === index);
  const assistant = unique(includedSkills.filter(skill => skill.mode !== "available"));
  const selectedManually = unique(manualSkills);
  const ids = resolveEffectiveSkillIds(assistant.map(({ id }) => id), selectedManually.map(({ id }) => id));
  const tokens = (skill: SelectedSkillName) => skill.instructionApproxTokens ?? estimates.find(item => item.id === skill.id)?.instructionApproxTokens;
  const manual = selectedManually.filter(skill => !assistant.some(entry => entry.id === skill.id));
  const budget = (skills: readonly SelectedSkillName[]) => ({
    total: skills.reduce((sum, skill) => sum + (tokens(skill) ?? 0), 0),
    complete: skills.every(skill => tokens(skill) !== undefined),
    hasEstimate: skills.some(skill => tokens(skill) !== undefined) || skills.length === 0
  });
  const assistantBudget = budget(assistant);
  const manualBudget = budget(manual);
  const overall = budget([...assistant, ...manual]);
  const label = (value: typeof overall) => value.hasEstimate
    ? `${value.complete ? "≈" : "At least ≈"}${value.total.toLocaleString()}` : "unavailable";
  const percentage = overall.hasEstimate && modelContextWindow && modelContextWindow > 0 ? overall.total / modelContextWindow * 100 : null;
  if (!ids.length && availableCount === undefined) return null;
  if (!ids.length) return <section aria-label="Selected Skills" className="v2-skill-selection">
    <p>{availableCountPartial ? "At least " : ""}{availableCount} Skills enabled for Auto</p>
  </section>;
  return (
    <section aria-label="Selected Skills" className="v2-skill-selection">
      <p className="v2-skill-selection-total">{ids.length} always included · {overall.hasEstimate ? `${label(overall)} instruction tokens` : "Instruction estimate unavailable"}{percentage !== null ? ` · ${overall.complete ? "" : "at least "}${percentage.toLocaleString(undefined, { maximumFractionDigits: 1 })}% of model window` : ""}</p>
      {assistant.length || !overall.complete ? <p className="v2-skill-selection-breakdown">Assistant: {label(assistantBudget)} · Yours: {label(manualBudget)}{overall.complete ? "" : " · Some estimates are unavailable."}</p> : null}
      {availableCount !== undefined ? <p>{availableCountPartial ? "At least " : ""}{availableCount} skills available on demand</p> : null}
      {percentage !== null && percentage > 25 ? <p role="status">Pinned instructions use more than 25% of the model window. Less conversation history may fit.</p> : null}
      {ids.length >= SKILL_MAX_PINNED ? (
        <p role={ids.length > SKILL_MAX_PINNED ? "alert" : "status"}>
          {ids.length > SKILL_MAX_PINNED
            ? `Choose at most ${SKILL_MAX_PINNED} pinned Skills. Unpin a Skill or change the Assistant before sending.`
            : "Skill limit reached. Unpin a Skill to add another."}
        </p>
      ) : null}
      {assistant.length ? <div>
        <strong>Always from Assistant</strong>
        <ol className="v2-skill-selection-list">{assistant.map((skill) => <li key={skill.id}>
          <span>{ids.indexOf(skill.id) + 1}. {skill.name}</span><small>Always</small>
        </li>)}</ol>
      </div> : null}
      {selectedManually.length ? <div>
        {assistant.length ? <strong>Always use</strong> : null}
        <ol className="v2-skill-selection-list">{selectedManually.map((skill) => <li key={skill.id}>
          <span>{ids.indexOf(skill.id) + 1}. {skill.name}</span>
          <UiV2IconButton
            className="v2-skill-selection-remove"
            icon="close"
            label={`Remove manual ${skill.name}`}
            tooltip="Stop always including this Skill"
            onClick={() => onRemove(skill.id)}
          />
        </li>)}</ol>
      </div> : null}
    </section>
  );
}
