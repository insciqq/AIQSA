import { SKILL_BUNDLE_MAX_BYTES, SKILL_FRONTMATTER_MAX_BYTES } from "./skills";

/** Personal Skill store wire format. Package bytes travel outside model tool context. */
export const SKILLS_MCP_TRANSFER_MAX_BYTES = 34 * 1_024 * 1_024;
// Portable SKILL.md rendering may add title metadata or normalize YAML. The
// canonical bundle still has the existing storage limit after parsing.
export const SKILLS_MCP_PACKAGE_MAX_BYTES = SKILL_BUNDLE_MAX_BYTES + 4 * SKILL_FRONTMATTER_MAX_BYTES;
export const SKILLS_MCP_TOOL_MAX_BYTES = 256 * 1_024;
// A full page repeats metadata as structuredContent and JSON text. This also
// covers JSON escaping of 100 maximum-length Unicode descriptions and manifests.
export const SKILLS_MCP_TOOL_RESPONSE_MAX_BYTES = 2 * 1_024 * 1_024;
export const SKILLS_MCP_LIST_MAX = 100;

export type SkillStoreEntry = {
  id: string;
  version: number;
  name: string;
  description: string;
  bundleDigest: string;
  fileCount: number;
  bundleByteSize: number;
  archived: boolean;
  enabled: boolean;
  updatedAt: string;
};
export type SkillStoreManifestFile = {
  path: string;
  byteSize: number;
  checksum: string;
  executable: boolean;
};
export type SkillStoreDetail = SkillStoreEntry & {
  files: SkillStoreManifestFile[];
};
export type SkillStoreDownload = SkillStoreDetail & {
  archive: { path: string; sha256: string; byteSize: number };
};
export type SkillStoreWriteRequest = {
  operation: "create" | "update";
  operationKey: string;
  skillId?: string;
  expectedVersion?: number;
  files: Array<{ path: string; contentBase64: string; executable: boolean }>;
};
export type SkillStoreMutationResult = {
  outcome: "created" | "updated" | "unchanged" | "deleted";
  skillId: string;
  version: number;
  bundleDigest: string | null;
  libraryPath: "/?library=skills";
};
