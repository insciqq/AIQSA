import { textMessageContent } from "../../domain/content";
import type { ProviderConversationMessage } from "../providers/types";
import type { SkillRunMaterialization } from "./runMaterialization";
import { escapeSkillXml as escapeXml } from "./runManifest";

export const SKILL_CONTEXT_PREVIEW_PLACEHOLDER =
  "[selected Skill instructions omitted]";

export function renderSelectedSkillContext(
  skills: readonly SkillRunMaterialization[],
  canReadFiles = false
): string {
  return [
    "<selected_skills>",
    ...skills.flatMap((skill) => [
      `  <skill name="${escapeXml(skill.name)}"${skill.alias ? ` alias="${skill.alias}" files="${skill.fileCount ?? 0}"` : ""}${skill.workspacePath ? ` bundle_path="${escapeXml(skill.workspacePath)}"` : ""}>`,
      escapeXml(skill.instructions),
      ...(skill.files?.length ? [`    <files>${escapeXml(skill.files.map((file) => `${file.path} (${file.byteSize} bytes${file.executable ? ", executable" : ""})`).join(", "))}</files>`] : []),
      ...(canReadFiles && (skill.fileCount ?? 0) > 0 ? ["Read bundled files with read_skill_file only when the instructions require them."] : []),
      "  </skill>"
    ]),
    "</selected_skills>"
  ].join("\n");
}

export function withSelectedSkillContext(
  messages: readonly ProviderConversationMessage[],
  skills: readonly SkillRunMaterialization[],
  options: Readonly<{ canReadFiles?: boolean; catalog?: string }> = {}
): ProviderConversationMessage[] {
  if (messages.length === 0) return [...messages];
  const current = messages.at(-1)!;
  const contexts: ProviderConversationMessage[] = [];
  if (skills.length > 0) contexts.push({
    content: textMessageContent(renderSelectedSkillContext(skills, options.canReadFiles)),
    id: `skill-context:${current.id}`,
    purpose: "skill_context",
    role: "user"
  });
  if (options.catalog) contexts.push({
    content: textMessageContent(options.catalog),
    id: `skill-catalog:${current.id}`,
    purpose: "skill_catalog",
    role: "user"
  });
  return [...messages.slice(0, -1), ...contexts, current];
}
