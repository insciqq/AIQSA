import { z } from "zod";
import { SKILL_FILE_MAX_BYTES, SKILL_MAX_FILES } from "../../contracts/skills";
import { SKILLS_MCP_LIST_MAX, SKILLS_MCP_PACKAGE_MAX_BYTES } from "../../contracts/skillsMcp";
import { createSkillBundle, parseSkillMarkdown, type SkillBundle } from "../skills/bundle";
import { SkillBundleError } from "../skills/bundleErrors";

export const skillIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/u);
export const operationKeySchema = z.string().min(16).max(128).regex(/^[a-zA-Z0-9_-]+$/u);
export const skillVersionSchema = z.number().int().positive().max(2_147_483_647);
export const listSkillsSchema = z.strictObject({
  query: z.string().trim().max(256).optional(), cursor: skillIdSchema.optional(),
  limit: z.number().int().min(1).max(SKILLS_MCP_LIST_MAX).optional(), includeArchived: z.boolean().optional()
});
export const getSkillSchema = z.strictObject({ skillId: skillIdSchema });
export const downloadSkillSchema = z.strictObject({ skillId: skillIdSchema, version: skillVersionSchema });
export const createSkillSchema = z.strictObject({ operationKey: operationKeySchema, markdown: z.string().max(160_000).optional() });
export const updateSkillSchema = createSkillSchema.extend({ skillId: skillIdSchema, expectedVersion: skillVersionSchema });
export const deleteSkillSchema = z.strictObject({ operationKey: operationKeySchema, skillId: skillIdSchema, expectedVersion: skillVersionSchema });
const transferFileSchema = z.strictObject({
  path: z.string().min(1).max(1_024),
  contentBase64: z.string().max(Math.ceil(SKILL_FILE_MAX_BYTES / 3) * 4), executable: z.boolean()
});
export const transferWriteSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("create"), operationKey: operationKeySchema, files: z.array(transferFileSchema).min(1).max(SKILL_MAX_FILES + 1) }),
  z.strictObject({ operation: z.literal("update"), operationKey: operationKeySchema, skillId: skillIdSchema, expectedVersion: skillVersionSchema,
    files: z.array(transferFileSchema).min(1).max(SKILL_MAX_FILES + 1) })
]);

export function decodeTransferBundle(files: z.infer<typeof transferFileSchema>[]): SkillBundle {
  let total = 0;
  const decoded = files.map((file) => {
    if (file.contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(file.contentBase64)) {
      throw new SkillBundleError({ code: "skill_bundle_invalid" });
    }
    const bytes = Buffer.from(file.contentBase64, "base64");
    total += bytes.length;
    if (bytes.toString("base64") !== file.contentBase64 || total > SKILLS_MCP_PACKAGE_MAX_BYTES) {
      throw new SkillBundleError({ code: "skill_bundle_invalid" });
    }
    return { path: file.path, bytes, executable: file.executable };
  });
  const markdown = decoded.filter((file) => file.path === "SKILL.md");
  if (markdown.length !== 1 || markdown[0]!.executable) throw new SkillBundleError({ code: "skill_markdown_required" });
  return createSkillBundle(parseSkillMarkdown(markdown[0]!.bytes, "skill"), decoded.filter((file) => file !== markdown[0]));
}
