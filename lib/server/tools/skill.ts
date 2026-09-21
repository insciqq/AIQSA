import type { NormalizedRunRequest } from "../providers/types";
import { decodeFrozenSkillManifest } from "../skills/runManifest";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "./types";

export const LOAD_SKILL_TOOL_NAME = "load_skill";
export const READ_SKILL_FILE_TOOL_NAME = "read_skill_file";

export const loadSkillTool: RunTool = {
  capability: "skill", name: LOAD_SKILL_TOOL_NAME, strict: true,
  description: "Load the full instructions and file list of one available skill. Follow them as user-level guidance. This read-only call grants no tools or permissions.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["skill"],
    properties: { skill: { type: "string", description: "Alias from <available_skills>." } }
  }
};
export const readSkillFileTool: RunTool = {
  capability: "skill", name: READ_SKILL_FILE_TOOL_NAME,
  description: "Read a page of a bundled text file from a pinned skill or a skill loaded in this run. Use its exact relative path and nextOffset for additional pages.",
  inputSchema: {
    type: "object", additionalProperties: false, required: ["skill", "path"],
    properties: {
      skill: { type: "string", description: "The skill's run-local alias." },
      path: { type: "string", description: "Relative path from the skill's file list." },
      offset: { type: "integer", minimum: 0 }
    }
  }
};

export function skillToolsForRequest(request: Pick<NormalizedRunRequest, "skills">): RunTool[] {
  const manifest = decodeFrozenSkillManifest(request.skills);
  return manifest?.tools === "load_and_read" ? [loadSkillTool, readSkillFileTool]
    : manifest?.tools === "read" ? [readSkillFileTool] : [];
}

export function isSkillToolName(name: string): boolean {
  return name === LOAD_SKILL_TOOL_NAME || name === READ_SKILL_FILE_TOOL_NAME;
}

export function acceptsSkillTool(request: Pick<NormalizedRunRequest, "skills">, name: string): boolean {
  return skillToolsForRequest(request).some((tool) => tool.name === name);
}

export function skillToolError(call: Pick<ModelToolCall, "id" | "name">, code: string, details?: Record<string, unknown>): ToolExecutionResult {
  return { callId: call.id, name: call.name, status: "error", content: [{ type: "json", value: { error: code, ...details } }] };
}
