import type { RunTool } from "../../tools/types";
import type { MemoryActionPlan } from "./intent";

export const MEMORY_SAVE_TOOL_NAME = "save_memory";
export const MEMORY_LIST_TOOL_NAME = "list_memories";
export const MEMORY_UPDATE_TOOL_NAME = "update_memory";
export const MEMORY_FORGET_TOOL_NAME = "forget_memory";

const noAdditionalProperties = { additionalProperties: false, type: "object" } as const;

const listQueryProperties = {
  query: { maxLength: 500, minLength: 1, type: "string" }
} as const;

const listTool = Object.freeze({
  capability: "memory",
  description:
    "List the current user's saved memories from AIQSA's authoritative first-party Memory service.",
  inputSchema: {
    ...noAdditionalProperties,
    properties: listQueryProperties
  },
  name: MEMORY_LIST_TOOL_NAME,
  strict: true
} satisfies RunTool);

const queriedListTool = Object.freeze({
  ...listTool,
  inputSchema: {
    ...noAdditionalProperties,
    properties: listQueryProperties,
    required: ["query"]
  }
} satisfies RunTool);

const tools = Object.freeze({
  FORGET: Object.freeze({
    capability: "memory",
    description:
      "Forget only the saved memory named by the user's current direct command. The server resolves and authorizes the exact current version.",
    inputSchema: {
      ...noAdditionalProperties,
      properties: { exact_query: { maxLength: 500, minLength: 1, type: "string" } },
      required: ["exact_query"]
    },
    name: MEMORY_FORGET_TOOL_NAME,
    strict: true
  } satisfies RunTool),
  LIST: listTool,
  SAVE: Object.freeze({
    capability: "memory",
    description:
      "Save exactly the statement in the user's current direct remember command. Paraphrases and added claims are rejected.",
    inputSchema: {
      ...noAdditionalProperties,
      properties: { statement: { maxLength: 2_000, minLength: 1, type: "string" } },
      required: ["statement"]
    },
    name: MEMORY_SAVE_TOOL_NAME,
    strict: true
  } satisfies RunTool),
  UPDATE: Object.freeze({
    capability: "memory",
    description:
      "Update the one saved memory resolved from the user's current direct command, using exactly the requested replacement statement.",
    inputSchema: {
      ...noAdditionalProperties,
      properties: { statement: { maxLength: 2_000, minLength: 1, type: "string" } },
      required: ["statement"]
    },
    name: MEMORY_UPDATE_TOOL_NAME,
    strict: true
  } satisfies RunTool)
});

export function memoryActionToolForPlan(plan: MemoryActionPlan): RunTool {
  if (plan.kind === "LIST" && plan.query !== null) return queriedListTool;
  return tools[plan.kind];
}

export function memoryActionToolName(plan: MemoryActionPlan): string {
  return memoryActionToolForPlan(plan).name;
}

export function isMemoryActionToolName(value: string): boolean {
  return value === MEMORY_SAVE_TOOL_NAME ||
    value === MEMORY_LIST_TOOL_NAME ||
    value === MEMORY_UPDATE_TOOL_NAME ||
    value === MEMORY_FORGET_TOOL_NAME;
}
