import { SUBAGENT_TOOL_GROUPS, type SubagentToolGroup } from "../../../contracts/subagents";
import { subagentMayUseTool } from "../../subagents/tools";
import { READ_AIQSA_GUIDE_TOOL_NAME } from "../../tools/aiqsaGuide";
import { APPLY_PATCH_TOOL_NAME } from "../../tools/applyPatch";
import { BROWSER_HANDOFF_TOOL_NAME } from "../../tools/browserHandoff";
import { READ_SECRET_TOOL_NAME } from "../../tools/readSecret";
import type { RunTool } from "../../tools/types";
import { UPDATE_PLAN_TOOL_NAME } from "../../tools/updatePlan";
import type { ToolRegistry } from "../toolRegistry";
import { READ_TOOL_RESULT_NAME } from "../toolResults";

/**
 * A sub-agent's tools (operator decision 2026-10-29): the registry the
 * parent's code path builds for the run, filtered. Never a resource change,
 * a Skill save, an export, the run's reserved report or a sub-agent tool
 * (`SUBAGENT_EXCLUDED_TOOL_NAMES`, so no nesting); `load_skill` stays. A
 * custom sub-agent's tool groups narrow the rest and never add a tool; the
 * plan, saved results and the AIQSA guide are always there. Resolving an
 * excluded name answers as an unknown tool, so a call of one is refused
 * before anything is recorded as sent.
 */
const ALWAYS: ReadonlySet<string> = new Set([UPDATE_PLAN_TOOL_NAME, READ_TOOL_RESULT_NAME, READ_AIQSA_GUIDE_TOOL_NAME]);

/** The group a tool belongs to, or null when none of the groups covers it (only a sub-agent with every tool has it). */
export function subagentToolGroup(tool: Pick<RunTool, "capability" | "name">): SubagentToolGroup | null {
  const groups = SUBAGENT_TOOL_GROUPS;
  if (tool.name === READ_SECRET_TOOL_NAME) return groups.secrets;
  if (tool.name === APPLY_PATCH_TOOL_NAME || tool.name === BROWSER_HANDOFF_TOOL_NAME) return groups.workspace;
  switch (tool.capability) {
    case "workspace": return groups.workspace;
    case "web_search": return groups.web_search;
    case "web_fetch": return groups.web_fetch;
    case "mcp": return groups.mcp;
    case "skill": return groups.skills;
    case "memory": return groups.memory;
    case "image": return groups.images;
    case "vision": return groups.vision;
    default: return null;
  }
}

/** Whether a sub-agent with these tool groups (null: every default tool) is offered this tool. */
export function subagentOffersTool(tool: Pick<RunTool, "capability" | "name">, groups: readonly SubagentToolGroup[] | null): boolean {
  if (!subagentMayUseTool(tool.name)) return false;
  if (ALWAYS.has(tool.name) || groups === null) return true;
  const group = subagentToolGroup(tool);
  return group !== null && groups.includes(group);
}

/** The parent's registry as a sub-agent sees it. */
export function subagentToolRegistry(registry: ToolRegistry, groups: readonly SubagentToolGroup[] | null): ToolRegistry {
  const offered = (name: string) => {
    const tool = registry.resolve(name);
    return tool && subagentOffersTool(tool.definition, groups) ? tool : undefined;
  };
  return {
    definitions: () => registry.definitions().filter((definition) => subagentOffersTool(definition, groups)),
    ...(registry.images ? { images: registry.images } : {}),
    ...(registry.mcpLoadCall && (groups === null || groups.includes(SUBAGENT_TOOL_GROUPS.mcp))
      ? { mcpLoadCall: registry.mcpLoadCall } : {}),
    // A replacement names a newer tool; offered only when the sub-agent has that one.
    replacement: (name) => {
      const text = registry.replacement?.(name);
      return text && registry.definitions().some((definition) => text.includes(` ${definition.name} `) &&
        subagentOffersTool(definition, groups)) ? text : undefined;
    },
    resolve: offered
  };
}
