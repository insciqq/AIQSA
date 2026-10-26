// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readToolResultTool as engineReadToolResultTool } from "../engine/toolResults";
import { mcpFindToolsTool } from "../mcp/discovery";
import { memorySearchTool } from "../memory/search/contract";
import { analyzeConversationImageTool, analyzeImageTool } from "./analyzeImage";
import { artifactTool, readArtifactTool } from "./artifact";
import { checkpointOutputsTool } from "./checkpointOutputs";
import { fetchUrlTool } from "./fetchUrlPlan";
import { HARNESS_TOOLS } from "./harnessTools";
import { monitoringVerdictTool } from "./monitoringVerdict";
import { readToolResultTool } from "./readToolResult";
import { createScheduledTaskTool } from "./scheduledTaskCreation";
import { manageScheduledTaskTool } from "./scheduledTaskManagement";
import { SELF_SERVICE_TOOLS } from "./selfServiceTools";
import { sessionStatusTool } from "./sessionStatus";
import { loadSkillTool, readSkillFileTool } from "./skill";
import { saveSkillTool } from "./skillSave";
import type { RunTool } from "./types";
import { viewWorkspaceImageTool } from "./viewWorkspaceImage";

/**
 * Every provider must accept every tool schema the engine offers. DeepSeek's
 * strict tool schemas (its beta Chat Completions route, and OpenRouter's
 * DeepSeek endpoint for AIQSA's strict tools) take a `type` list only of
 * scalar types and refuse one naming "array" or "object" with HTTP 400 for
 * the whole request (seen 2026-10-26 with `create_scheduled_task`). A nullable
 * list or object, or a value that is a string or a list, is written as
 * `anyOf`, which OpenAI strict schemas, Anthropic, Gemini and DeepSeek accept.
 */
const CONTAINER_TYPES = new Set(["array", "object"]);
const CHILD_KEYS = ["items", "additionalProperties", "contains", "not", "if", "then", "else", "propertyNames"];
const CHILD_ARRAY_KEYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const CHILD_MAP_KEYS = ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Paths of the schema positions whose `type` is a list naming a container type. */
function containerTypeLists(schema: unknown, path = "$"): string[] {
  if (!record(schema)) return [];
  const found = Array.isArray(schema.type) && schema.type.some((type) => CONTAINER_TYPES.has(type as string)) ? [path] : [];
  for (const key of CHILD_KEYS) found.push(...containerTypeLists(schema[key], `${path}.${key}`));
  for (const key of CHILD_ARRAY_KEYS) {
    const children = schema[key];
    if (Array.isArray(children)) children.forEach((child, index) => found.push(...containerTypeLists(child, `${path}.${key}[${index}]`)));
  }
  for (const key of CHILD_MAP_KEYS) {
    const children = schema[key];
    if (record(children)) for (const [name, child] of Object.entries(children)) found.push(...containerTypeLists(child, `${path}.${key}.${name}`));
  }
  return found;
}

const memorySearch = { comparisonResultTokens: 12000, destinations: [], maxCalls: 3, memoryGeneration: 1, referenceChatHistory: true,
  resultTokens: 6000, timeoutSeconds: 30, version: "memory-search-v1" } as const;

/** The first-party tools the engine's registry can offer (`lib/server/engine/toolRegistry.ts`). */
function firstPartyTools(): RunTool[] {
  return [
    ...HARNESS_TOOLS.map((descriptor) => descriptor.tool),
    ...SELF_SERVICE_TOOLS.map((descriptor) => descriptor.tool),
    createScheduledTaskTool("Europe/Moscow"),
    manageScheduledTaskTool({ chatTask: { taskId: "task-1", title: "Check mail" }, userUrlDigests: [] }),
    saveSkillTool, monitoringVerdictTool, engineReadToolResultTool, readToolResultTool, mcpFindToolsTool, fetchUrlTool,
    loadSkillTool, readSkillFileTool, artifactTool(), readArtifactTool(), checkpointOutputsTool, analyzeImageTool(),
    analyzeConversationImageTool(), viewWorkspaceImageTool, sessionStatusTool, memorySearchTool(memorySearch)
  ];
}

/** Non-test TypeScript sources under `lib/`. */
function librarySources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : librarySources(path);
    return /\.tsx?$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe("tool schema portability", () => {
  it("finds a type list naming a container type wherever it is nested", () => {
    expect(containerTypeLists({ properties: { a: { anyOf: [{ properties: { days: { items: { type: "string" }, type: ["array", "null"] } },
      type: "object" }, { type: "null" }] }, b: { type: ["string", "object"] }, c: { type: ["string", "null"] } }, type: "object" }))
      .toEqual(["$.properties.a.anyOf[0].properties.days", "$.properties.b"]);
  });

  it("writes every nullable list or object of a first-party tool as anyOf, never as a type list", () => {
    const tools = firstPartyTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["create_scheduled_task", "manage_assistant", "save_skill"]));
    for (const tool of tools) expect(containerTypeLists(tool.inputSchema), tool.name).toEqual([]);
  });

  it("has no type list naming array or object in any library schema literal", () => {
    // Covers schemas built from plans the list above cannot construct (Search, image generation, structured outputs).
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const pattern = /\btype["']?\s*:\s*\[[^\]]*["'](?:array|object)["']/u;
    const offending = librarySources(root).filter((path) => pattern.test(readFileSync(path, "utf8")))
      .map((path) => relative(root, path));
    expect(offending).toEqual([]);
  });

  it("keeps the nullable lists of create_scheduled_task, save_skill and manage_assistant as anyOf branches", () => {
    const schedule = createScheduledTaskTool("UTC").inputSchema.properties as Record<string, Record<string, unknown>>;
    const scheduleObject = (schedule.schedule!.anyOf as Record<string, unknown>[])[0]!.properties as Record<string, unknown>;
    expect(scheduleObject.days).toMatchObject({ anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }] });
    expect(schedule.skills).toMatchObject({ anyOf: [{ items: { type: "string" }, type: "array" }, { type: "null" }] });
    expect((saveSkillTool.inputSchema.properties as Record<string, unknown>).files)
      .toMatchObject({ anyOf: [{ minItems: 1, type: "array" }, { type: "null" }] });
    const assistant = SELF_SERVICE_TOOLS.find((descriptor) => descriptor.name === "manage_assistant")!.tool;
    expect((assistant.inputSchema.properties as Record<string, unknown>).mcpTools)
      .toMatchObject({ anyOf: [{ type: "string" }, { items: { type: "string" }, type: "array" }] });
  });
});
