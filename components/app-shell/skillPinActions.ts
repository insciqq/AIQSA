import { loadSkillDetail } from "./skillLibraryStore";
import { useComposerControlStore, type ComposerSkillSelection } from "./composerControlStore";
import { resolveEffectiveSkillIds, SKILL_MAX_PINNED } from "@/lib/contracts/skills";

/** A historical load is an invitation to select, never evidence of current access. */
export async function pinSkillForNextTurn(input: Readonly<{
  skillId: string;
  isCurrentScope(): boolean;
  projectSkills?: readonly (ComposerSkillSelection & { available: boolean })[];
}>): Promise<void> {
  if (!input.isCurrentScope()) return;
  let selected: ComposerSkillSelection;
  if (input.projectSkills) {
    const skill = input.projectSkills.find(skill => skill.id === input.skillId && skill.available);
    if (!skill) throw new Error("This Skill is no longer available in this Project.");
    selected = skill;
  } else {
    let skill;
    try { skill = await loadSkillDetail(input.skillId); }
    catch { throw new Error("This Skill is no longer available. Open Skills to review your selection."); }
    if (skill.archived) throw new Error("This Skill is archived. Restore it before pinning.");
    selected = { id: skill.id, name: skill.name, description: skill.description,
      promptCharacterCount: skill.instructionCharacterCount, instructionApproxTokens: skill.instructionApproxTokens };
  }
  if (!input.isCurrentScope()) return;
  const controls = useComposerControlStore.getState();
  const pinnedIds = resolveEffectiveSkillIds(
    (controls.selectedAssistant?.includedSkills ?? []).filter(skill => skill.mode !== "available").map(skill => skill.id),
    controls.selectedSkills.map(skill => skill.id)
  );
  if (pinnedIds.includes(selected.id)) return;
  if (pinnedIds.length >= SKILL_MAX_PINNED) throw new Error(`Up to ${SKILL_MAX_PINNED} Skills can be pinned. Remove one before pinning this Skill.`);
  controls.setSelectedSkills([...controls.selectedSkills, selected]);
}
