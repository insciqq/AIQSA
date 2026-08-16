import { textMessageContent } from "../../domain/content";
import type { ProviderConversationMessage } from "../providers/types";
import type { SkillRunMaterialization } from "./runMaterialization";

export const SKILL_CONTEXT_PREVIEW_PLACEHOLDER =
  "[selected Skill instructions omitted]";

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function renderSelectedSkillContext(
  skills: readonly SkillRunMaterialization[]
): string {
  return [
    "<selected_skills>",
    ...skills.flatMap((skill) => [
      `  <skill name="${escapeXml(skill.name)}">`,
      escapeXml(skill.instructions),
      "  </skill>"
    ]),
    "</selected_skills>"
  ].join("\n");
}

export function withSelectedSkillContext(
  messages: readonly ProviderConversationMessage[],
  skills: readonly SkillRunMaterialization[]
): ProviderConversationMessage[] {
  if (skills.length === 0 || messages.length === 0) return [...messages];
  const current = messages.at(-1)!;
  const context: ProviderConversationMessage = {
    content: textMessageContent(renderSelectedSkillContext(skills)),
    id: `skill-context:${current.id}`,
    purpose: "skill_context",
    role: "user"
  };
  return [...messages.slice(0, -1), context, current];
}
