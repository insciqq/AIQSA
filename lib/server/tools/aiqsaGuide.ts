import { AIQSA_GUIDE_TOPICS, aiqsaGuideText, type AiqsaGuideTopic } from "../engine/prompts/selfService";
import { harnessToolError, type HarnessToolDescriptor } from "./harnessTool";
import { hasInvalidProviderToolArguments, type ModelToolCall, type ToolExecutionResult } from "./types";

/**
 * `read_aiqsa_guide`: the readable AIQSA guide (`lib/server/engine/prompts/selfService.ts`),
 * one topic per call, so the system prompt stays short. Static text: no
 * effects, no VM, nothing about the user.
 */
export const READ_AIQSA_GUIDE_TOOL_NAME = "read_aiqsa_guide";

const DESCRIPTION = `Returns a section of the AIQSA guide: how AIQSA works, where things are in Studio and Settings (with links), and what you can do for the user with their own resources.
topic: one of ${AIQSA_GUIDE_TOPICS.join(", ")}; overview (the default) lists the others.
Read it when the user asks about AIQSA itself or before you explain a feature you are unsure about. Static text; it changes nothing.`;

const INPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    topic: { description: "The guide topic; overview lists the others.", enum: [...AIQSA_GUIDE_TOPICS], type: "string" }
  },
  required: [],
  type: "object"
};

export const readAiqsaGuideTool: HarnessToolDescriptor = Object.freeze({
  description: DESCRIPTION,
  effects: "none",
  inputSchema: INPUT_SCHEMA,
  name: READ_AIQSA_GUIDE_TOOL_NAME,
  needsApproval: false,
  requiresVm: false,
  tool: Object.freeze({ capability: "session", description: DESCRIPTION, inputSchema: INPUT_SCHEMA, name: READ_AIQSA_GUIDE_TOOL_NAME, strict: false })
});

function isTopic(value: unknown): value is AiqsaGuideTopic {
  return typeof value === "string" && (AIQSA_GUIDE_TOPICS as readonly string[]).includes(value);
}

export function executeReadAiqsaGuide(call: ModelToolCall): ToolExecutionResult {
  const refuse = () => harnessToolError(call, "aiqsa_guide_invalid",
    `Pass {"topic": "<topic>"} with one of ${AIQSA_GUIDE_TOPICS.join(", ")}, or no arguments for the overview.`);
  if (hasInvalidProviderToolArguments(call.arguments)) return refuse();
  const { topic, ...rest } = call.arguments;
  if (Object.keys(rest).length || (topic !== undefined && topic !== null && !isTopic(topic))) return refuse();
  return { callId: call.id, content: [{ text: aiqsaGuideText(isTopic(topic) ? topic : "overview"), type: "text" }], name: call.name,
    status: "complete" };
}
