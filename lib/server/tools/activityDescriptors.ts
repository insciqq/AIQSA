import { WORKSPACE_MCP_TOOL_ALLOWLIST } from "@/lib/domain/workspace";
import type { ThreadToolActivityOrigin } from "@/lib/contracts/chats";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { plainWorkspaceActivityText } from "../workspace/activityText";
import { decodeFrozenSkillManifest } from "../skills/runManifest";
import { isSkillToolName, READ_SKILL_FILE_TOOL_NAME } from "./skill";
import { skillTarPath } from "../../domain/skillBundlePaths";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function activityName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized && !/[\u0000-\u001f\u007f]/u.test(normalized)
    ? normalized.slice(0, 160)
    : fallback;
}

export function toolActivityDescriptors(normalizedRequest: unknown, sanitize: (value: string) => string = plainWorkspaceActivityText): Map<string, {
  origin: ThreadToolActivityOrigin;
  serverName?: string;
  toolName: string;
}> {
  const descriptors = new Map<string, {
    origin: ThreadToolActivityOrigin;
    serverName?: string;
    toolName: string;
  }>();
  if (!isRecord(normalizedRequest)) return descriptors;

  const mcp = isRecord(normalizedRequest.mcp) ? normalizedRequest.mcp : null;
  if (mcp && Array.isArray(mcp.tools)) {
    for (const value of mcp.tools) {
      if (!isRecord(value) || typeof value.namespacedName !== "string") continue;
      descriptors.set(value.namespacedName, {
        origin: "mcp",
        serverName: activityName(sanitize(String(value.serverName ?? "")), "MCP server"),
        toolName: activityName(sanitize(String(value.originalName ?? "")), "Tool")
      });
    }
  }

  const discovery = isRecord(normalizedRequest.mcpDiscovery)
    ? normalizedRequest.mcpDiscovery
    : null;
  const catalog = discovery && isRecord(discovery.catalog) ? discovery.catalog : null;
  if (catalog && Array.isArray(catalog.servers)) {
    for (const server of catalog.servers) {
      if (!isRecord(server) || !Array.isArray(server.tools)) continue;
      for (const value of server.tools) {
        if (!isRecord(value) || typeof value.namespacedName !== "string") continue;
        if (!descriptors.has(value.namespacedName)) {
          descriptors.set(value.namespacedName, {
            origin: "mcp",
            serverName: activityName(sanitize(String(server.serverName ?? "")), "MCP server"),
            toolName: activityName(sanitize(String(value.originalName ?? "")), "Tool")
          });
        }
      }
    }
  }

  const searchPlan = isRecord(normalizedRequest.searchPlan) ? normalizedRequest.searchPlan : null;
  if (searchPlan && Array.isArray(searchPlan.options)) {
    searchPlan.options.forEach((option, index) => {
      descriptors.set(`search_engine_${index + 1}`, {
        origin: "web_search",
        serverName: isRecord(option)
          ? activityName(sanitize(String(option.displayName ?? "")), "Web search")
          : "Web search",
        toolName: "search"
      });
    });
  }

  if (isRecord(normalizedRequest.workspace) && normalizedRequest.workspace.enabled === true) {
    for (const name of WORKSPACE_MCP_TOOL_ALLOWLIST) {
      descriptors.set(namespacedWorkspaceToolName(name), {
        origin: "workspace",
        serverName: "Workspace",
        toolName: name
      });
    }
  }

  descriptors.set("find_tools", { origin: "discovery", serverName: "Auto tools", toolName: "find_tools" });
  descriptors.set("load_skill", { origin: "skill", serverName: "Skills", toolName: "load_skill" });
  descriptors.set("read_skill_file", { origin: "skill", serverName: "Skills", toolName: "read_skill_file" });
  if (normalizedRequest.imagePlan) descriptors.set("generate_image", { origin: "image", serverName: "Images", toolName: "generate_image" });
  descriptors.set("search_knowledge", { origin: "knowledge", serverName: "Knowledge", toolName: "search_knowledge" });
  descriptors.set("retrieve_knowledge", { origin: "knowledge", serverName: "Knowledge", toolName: "search_knowledge" });
  for (const name of [
    "forget_memory",
    "list_memories",
    "mark_memory_incorrect",
    "save_memory",
    "search_memory",
    "update_memory"
  ]) {
    descriptors.set(name, { origin: "memory", serverName: "Memory", toolName: name });
  }
  return descriptors;
}

/** User-visible facts derived from admitted aliases, never arbitrary arguments. */
export function skillToolActivityFacts(normalizedRequest: unknown, toolName: string, argumentsValue: unknown): {
  skillId?: string; skillName?: string; skillPath?: string;
} {
  if (!isSkillToolName(toolName) || !isRecord(normalizedRequest) || !isRecord(argumentsValue)) return {};
  const manifest = decodeFrozenSkillManifest(normalizedRequest.skills);
  const skill = manifest && [...manifest.pinned, ...manifest.available].find((entry) => entry.alias === argumentsValue.skill);
  if (!skill) return {};
  const path = toolName === READ_SKILL_FILE_TOOL_NAME && typeof argumentsValue.path === "string" &&
    argumentsValue.path.length <= 256 && skillTarPath(argumentsValue.path) ? argumentsValue.path : null;
  return { skillId: skill.skillId, skillName: activityName(skill.name, "Skill"), ...(path ? { skillPath: path } : {}) };
}
